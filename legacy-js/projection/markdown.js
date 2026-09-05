// dsh-memory-personal — Markdown projection primitives.
//
// Shared vocabulary for the projection layer: content hashing, path/bucket
// mapping from a MemoryRecord to its Markdown file, ISO timestamps, and a tiny
// line-based YAML (sub)parser for frontmatter. The plugin has zero runtime
// dependencies (decision D9), so frontmatter is a strict, documented subset:
//   - scalars:  string / number / true / false
//   - lists:    "- item" lines under a bare key
// Only what the projector itself writes and re-reads must round-trip; foreign
// YAML is tolerated line-by-line and dropped on rewrite.

import { createHash } from 'node:crypto'
import { parse, join } from 'node:path'

/** ISO 8601 (UTC) string for a record timestamp. */
export function isoTime(ms) {
  return new Date(ms).toISOString()
}

/** Deterministic lowercase-safe file stem (keeps record ids URL-safe). */
export function safeStem(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'record'
}

/** SHA-256 hex digest of a string (file-content fingerprint). */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Bucket mapping: MemoryRecord → Markdown relative path.
//
// The checklist's tree (goals/, conflicts/, architecture/, decisions/…) maps
// to spec kinds the store does not model yet. This mapping is exhaustive over
// the CURRENT model; future kinds register a bucket here in the same PR that
// adds the kind. Archived / superseded records never render into the live
// bucket: they are moved to `archive/<dir>/<stem>--<id>.md`.
// ---------------------------------------------------------------------------

/** Aggregate list files per kind for global-scope memories. */
const GLOBAL_BUCKET = {
  profile: 'profile.md',
  preference: 'preferences.md',
  fact: 'facts.md',
  constraint: 'constraints.md',
  state: 'state.md',
}

/** Aggregate list files per kind inside a project folder. */
const PROJECT_BUCKET = {
  profile: 'profile.md',
  preference: 'preferences.md',
  fact: 'facts.md',
  constraint: 'constraints.md',
  state: 'state.md',
}

/** A "preference" profile fact is one whose content asserts a preference. */
const PREFERENCE_CONTENT = /^user\s+prefers\b/i

/**
 * The aggregate list file a memory renders into, or undefined when the record
 * owns a dedicated entry file (experiences, session-scoped records).
 * @param {import('../model/types.js').MemoryRecord} record
 * @returns {string | undefined}
 */
export function bucketPathFor(record) {
  const kind = record.kind === 'profile' && PREFERENCE_CONTENT.test(record.content) ? 'preference' : record.kind
  if (record.scope === 'project') {
    const pid = safeStem(record.projectId ?? 'default')
    const file = PROJECT_BUCKET[kind] ?? 'facts.md'
    return `projects/${pid}/${file}`
  }
  if (record.scope === 'generalized') return 'knowledge/generalized.md'
  const file = GLOBAL_BUCKET[kind]
  return file === undefined ? undefined : file
}

/**
 * The entry-file relative path for records that must not share a bucket:
 * experiences (structured templates) and session-scoped records (per-run
 * diaries). Returns undefined for records using an aggregate bucket.
 * @param {import('../model/types.js').MemoryRecord} record
 * @returns {string | undefined}
 */
export function entryPathFor(record) {
  if (record.scope === 'session') {
    return `sessions/${safeStem(record.sessionId ?? 'session')}/${record.id}.md`
  }
  if (record.kind === 'experience') {
    const pid = safeStem(record.projectId ?? '')
    return pid ? `projects/${pid}/experiences/${record.id}.md` : `experiences/${record.id}.md`
  }
  return undefined
}

/** The live file (aggregate bucket or entry) for an active record. */
export function livePathFor(record) {
  return entryPathFor(record) ?? bucketPathFor(record)
}

/**
 * Archive path for a record that leaves the live set (deleted / archived /
 * superseded). Mirrors the live directory and keeps the record id so restore
 * can find the source, e.g. `archive/projects/p/facts--mem_abc.md`.
 * @param {import('../model/types.js').MemoryRecord} record
 * @returns {string}
 */
export function archivedPathFor(record) {
  const live = livePathFor(record)
  const { dir, name } = parse(live)
  return join('archive', dir, `${name}--${record.id}.md`)
}

/** Frontmatter keys every projected file carries. */
export const FRONTMATTER_KEYS = [
  'memory_id',
  'kind',
  'scope',
  'project_id',
  'session_id',
  'status',
  'importance',
  'confidence',
  'source',
  'tags',
  'user_edited',
  'version',
  'created_at',
  'updated_at',
]

/**
 * Serialize one field into a YAML-subset line.
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
export function fieldLine(key, value) {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) {
    const items = value.filter((v) => typeof v === 'string' || typeof v === 'number')
    if (items.length === 0) return ''
    return `${key}:\n${items.map((v) => `  - ${v}`).join('\n')}`
  }
  if (typeof value === 'boolean') return `${key}: ${value ? 'true' : 'false'}`
  if (typeof value === 'number') return `${key}: ${value}`
  const text = String(value).replace(/\n/g, ' ')
  return `${key}: ${text}`
}

/**
 * Serialize a metadata object (ordered) to a frontmatter block INCLUDING the
 * `---` fences. Blank lines separate list blocks from following keys.
 * @param {Record<string, unknown>} meta
 * @returns {string}
 */
export function toFrontmatter(meta) {
  const lines = ['---']
  for (const key of Object.keys(meta)) {
    const line = fieldLine(key, meta[key])
    if (line === '') continue
    lines.push(line)
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * Parse a YAML-subset frontmatter block (the text between the first `---`
 * fence pair). Returns the object plus the body that follows the closing
 * fence. Never throws on malformed frontmatter: bad lines are skipped.
 * @param {string} text - full file content.
 * @returns {{ meta: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(text) {
  if (!/^---\r?\n/.test(text)) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text }
  const head = text.slice(4, end).replace(/\r\n/g, '\n')
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  /** @type {Record<string, unknown>} */
  const meta = {}
  let listKey
  for (const rawLine of head.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length === 0) { listKey = undefined; continue }
    const listItem = /^-\s+(.+)$/.exec(line)
    if (listItem && listKey !== undefined) {
      const arr = meta[listKey]
      if (Array.isArray(arr)) arr.push(scalar(listItem[1]))
      continue
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) { listKey = undefined; continue }
    listKey = kv[1]
    const value = kv[2].trim()
    if (value === '') {
      meta[listKey] = []
      continue
    }
    meta[listKey] = scalar(value)
  }
  return { meta, body }
}

/** Interpret one scalar token. */
function scalar(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return value.replace(/^["']|["']$/g, '')
}
