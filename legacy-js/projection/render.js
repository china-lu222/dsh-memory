// Markdown renderers: aggregate list buckets and record entry files.

import { toFrontmatter } from './markdown.js'

/**
 * Map a record to its frontmatter metadata object (the record fields that
 * must survive a round trip through a Markdown file).
 * @param {import('../model/types.js').MemoryRecord} record
 * @returns {Record<string, unknown>}
 */
export function metadataFor(record) {
  /** @type {Record<string, unknown>} */
  const meta = {
    memory_id: record.id,
    kind: record.kind,
    scope: record.scope,
  }
  if (record.projectId !== undefined && record.projectId !== null) meta.project_id = record.projectId
  if (record.sessionId !== undefined && record.sessionId !== null) meta.session_id = record.sessionId
  if (record.status !== undefined && record.status !== null && record.status !== 'active') meta.status = record.status
  if (record.importance !== undefined && record.importance !== null) meta.importance = record.importance
  if (record.confidence !== undefined && record.confidence !== null) meta.confidence = record.confidence
  if (record.source !== undefined && record.source !== null) meta.source = record.source
  if (record.tags !== undefined && record.tags.length > 0) meta.tags = record.tags
  if (record.userEdited) meta.user_edited = true
  if (record.version !== undefined && record.version !== null && record.version > 1) meta.version = record.version
  if (record.createdAt !== undefined && record.createdAt !== null) meta.created_at = record.createdAt
  if (record.updatedAt !== undefined && record.updatedAt !== null) meta.updated_at = record.updatedAt
  return meta
}

/** @type {Record<string, string>} human titles for buckets. */
const BUCKET_TITLES = {
  'profile.md': 'User Profile',
  'preferences.md': 'User Preferences',
  'facts.md': 'Facts',
  'constraints.md': 'Constraints',
  'state.md': 'Project State',
}

/** Guess a heading for a record-kind entry file. */
function entryTitle(record) {
  switch (record.kind) {
    case 'experience': return 'Experience'
    case 'fact': return 'Fact'
    case 'constraint': return 'Constraint'
    case 'profile': return 'User Profile Note'
    case 'state': return 'Project State Note'
    default: return 'Memory'
  }
}

/**
 * Serialize one record into the text of a dedicated entry file
 * (experiences, session diaries). Body is a readable Markdown passage plus
 * a metadata footer that survives rewrites.
 * @param {import('../model/types.js').MemoryRecord} record
 * @param {number} [version=1] - per-record projection version.
 * @returns {string}
 */
export function renderEntry(record, version = 1) {
  const front = toFrontmatter({ ...metadataFor(record), version })
  const lines = []
  lines.push(front, '', `# ${entryTitle(record)}`)
  if (record.tags && record.tags.length > 0) lines.push('', record.tags.map((t) => `- \`${t}\``).join('\n'))
  if (record.summary) lines.push('', '## Summary', '', record.summary)
  lines.push('', '## Details', '', record.content || '(no detail text)')
  lines.push('', '---', '')
  lines.push('<!-- dsh-memory projection entry; edit freely — the store adopts your text on the next sync. -->')
  return lines.join('\n') + '\n'
}

/**
 * Serialize a set of records into one aggregate list file. Frontmatter holds
 * bucket-level facts; each record is a single `- {content}` bullet. Content
 * is inlined on one line so a bullet stays a reversible, editable unit.
 * @param {import('../model/types.js').MemoryRecord[]} records
 * @param {{ path: string, updatedAt: string }} bucket
 * @returns {string}
 */
export function renderAggregate(records, bucket) {
  /** @type {Record<string, unknown>} */
  const meta = { bucket: bucket.path, updated_at: bucket.updatedAt }
  const front = toFrontmatter(meta)
  const { name } = splitPath(bucket.path)
  const title = BUCKET_TITLES[name] ?? name
  const lines = [front, '', `# ${title}`, '']
  for (const record of records) {
    const bullet = inline(record.content)
    lines.push(`- ${bullet} <!--mem:${record.id}-->`)
  }
  lines.push('', '---', '')
  lines.push('<!-- dsh-memory projection bucket; add, edit or delete bullet lines to change memory. -->')
  return lines.join('\n') + '\n'
}

/** Keep a bullet on one line without losing meaning. */
function inline(text) {
  return String(text).replace(/\s*\n+\s*/g, ' ').trim()
}

/** Split a bucket relative path into dir + file base. */
function splitPath(path) {
  const i = path.lastIndexOf('/')
  return i === -1 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) }
}
