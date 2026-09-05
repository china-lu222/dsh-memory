// MD → DB adoption: parse a user-edited Markdown file into store mutations.
//
// All writes go through repo.put / repo.delete with actor 'user'. The store
// event loop (see service.js) then re-renders the affected file and bumps
// versions, so adoption never needs to touch the filesystem itself.

import { parseFrontmatter } from './markdown.js'
import { aggregateBullets, parseEntry, scalarValue } from './parse.js'
import { LIVE_STATUSES } from '../model/types.js'

const NEW_KIND_FALLBACK = 'fact'
const BUCKET_KINDS = {
  'profile.md': 'profile',
  'preferences.md': 'profile',
  'facts.md': 'fact',
  'constraints.md': 'constraint',
  'state.md': 'state',
  'generalized.md': 'fact',
}

/** Result of an adoption pass. */
export class AdoptionResult {
  constructor(handled = false, created = 0, updated = 0, deleted = 0) {
    this.handled = handled
    this.created = created
    this.updated = updated
    this.deleted = deleted
  }
}

/**
 * Adopt an entry file (frontmatter carries memory_id). Updates the record in
 * place when it exists, creates a new one otherwise.
 * @param {import('../store/repository.js').MemoryRepository} repo
 * @param {string} text - full file content.
 * @param {Record<string, unknown>} meta - parsed frontmatter.
 * @returns {AdoptionResult}
 */
export function adoptEntry(repo, text, meta) {
  const entry = parseEntry(text)
  const id = scalarValue(meta.memory_id)
  if (id === undefined) return new AdoptionResult(false)
  const existing = repo.get(String(id))
  if (existing !== undefined) {
    const content = entry.content === undefined ? existing.content : entry.content
    const summary = entry.summary === undefined ? existing.summary : entry.summary
    if (content === existing.content && summary === existing.summary) return new AdoptionResult(true)
    repo.put({ ...existing, content, summary, userEdited: true }, { actor: 'user' })
    return new AdoptionResult(true, 0, 1, 0)
  }
  const content = entry.content ?? ''
  if (content.length === 0) return new AdoptionResult(false)
  repo.put({
    id: String(id),
    scope: scalarValue(meta.scope) ?? 'global',
    kind: scalarValue(meta.kind) ?? 'fact',
    projectId: scalarValue(meta.project_id),
    sessionId: scalarValue(meta.session_id),
    content,
    summary: entry.summary,
    source: 'user',
    userEdited: true,
  }, { actor: 'user' })
  return new AdoptionResult(true, 1, 0, 0)
}

/**
 * Adopt an aggregate bucket file by diffing its bullets (identity markers)
 * against the store. Unmarked bullets match an existing record by content or
 * become new memories; records whose marker/bullet disappeared are deleted.
 * @param {import('../store/repository.js').MemoryRepository} repo
 * @param {string} text - full bucket file content.
 * @param {string} rel - bucket relative path.
 * @returns {AdoptionResult}
 */
export function adoptBucket(repo, text, rel) {
  const context = bucketContextOf(rel)
  if (context === undefined) return new AdoptionResult(false)
  const bullets = aggregateBullets(text)
  const before = repo
    .listProjectionStates()
    .filter((row) => row.path === rel)
    .map((row) => repo.get(row.memoryId))
    .filter((record) => record !== undefined && LIVE_STATUSES.includes(record.status))
  const matched = new Set()
  let created = 0
  let updated = 0
  for (const bullet of bullets) {
    if (bullet.bullet.length === 0) continue
    if (bullet.memoryId !== undefined) {
      const record = repo.get(bullet.memoryId)
      if (record === undefined) continue
      matched.add(record.id)
      if (record.content !== bullet.bullet) {
        repo.put({ ...record, content: bullet.bullet, userEdited: true }, { actor: 'user' })
        updated++
      }
      continue
    }
    const owner = before.find((record) => record.content === bullet.bullet && !matched.has(record.id))
    if (owner !== undefined) {
      matched.add(owner.id)
      continue
    }
    repo.put({ ...defaultRecord(context, bullet.bullet) }, { actor: 'user' })
    created++
  }
  let deleted = 0
  for (const record of before) {
    if (!matched.has(record.id)) {
      repo.delete(record.id, { actor: 'user' })
      deleted++
    }
  }
  return new AdoptionResult(true, created, updated, deleted)
}

/** Default record fields for a brand-new aggregate bullet. */
function defaultRecord(context, content) {
  return {
    scope: context.scope,
    kind: context.kind,
    projectId: context.projectId,
    content,
    source: 'user',
    userEdited: true,
  }
}

/** Map an aggregate relative path to context for new records. */
export function bucketContextOf(rel) {
  const project = /^projects\/([^/]+)\/([^/]+)$/.exec(rel)
  if (project) {
    return { scope: 'project', kind: BUCKET_KINDS[project[2]] ?? NEW_KIND_FALLBACK, projectId: project[1] }
  }
  if (rel === 'knowledge/generalized.md') {
    return { scope: 'generalized', kind: 'fact', projectId: undefined }
  }
  const kind = BUCKET_KINDS[rel]
  if (kind === undefined) return undefined
  return { scope: 'global', kind, projectId: undefined }
}

export { parseFrontmatter }
