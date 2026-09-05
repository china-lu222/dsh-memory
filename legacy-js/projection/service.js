// MarkdownProjectionService — projection layer between the SQLite store and
// editable Markdown files.
//
//   DB → MD: subscribing on the repository, every store mutation renders the
//     affected file (single-record entry or aggregate bucket) and records per-
//     record version plus the last-written file hash in `md_projection`.
//   MD → DB: applyFileChange() adopts a user-edited file (actor 'user',
//     user_edited = true) so inferred memory never silently overwrites it.
//   Status: scanStatus() compares tracked files against recorded hashes →
//     synced / modified / missing / conflict.
//   Archive: leaving the live set moves the record to
//     `archive/<dir>/<stem>--<id>.md` and drops its live copy.
//
// This service is the only file writer; the store never touches the disk
// outside the SQLite handle.

import { isoTime, livePathFor, entryPathFor, bucketPathFor, archivedPathFor, parseFrontmatter, sha256 } from './markdown.js'
import { renderAggregate, renderEntry } from './render.js'
import { adoptBucket, adoptEntry } from './adopt.js'
import { OWNER_MARK, ProjectionFs } from './io.js'
import { LIVE_STATUSES } from '../model/types.js'

export class MarkdownProjectionService {
  /**
   * @param {{ repo: import('../store/repository.js').MemoryRepository,
   *   root: string, log?: (message: string) => void }} options
   */
  constructor({ repo, root, log = () => {} }) {
    if (!repo || !root) throw new Error('projection requires a repository and a root directory')
    this.repo = repo
    this.log = log
    this.fs = new ProjectionFs(root)
    this.writing = 0
    this.#dispose = undefined
  }

  /** Start listening to store mutations. */
  attach() {
    if (this.#dispose === undefined) {
      this.#dispose = this.repo.subscribe((change) => {
        try {
          if (change.type === 'delete') this.#removeRecord(change.record)
          else this.syncRecord(change.record)
        } catch (error) {
          this.log(`markdown projection failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    }
    return this
  }

  detach() {
    if (this.#dispose !== undefined) {
      this.#dispose()
      this.#dispose = undefined
    }
  }

  /** Projection root, for the watcher and the file explorer. */
  directory() {
    return this.fs.root
  }

  // ------------------------------------------------------------------
  // Store → Markdown
  // ------------------------------------------------------------------

  /**
   * Ensure one record's file reflects the store. Only real content changes
   * rewrite files and bump versions, so repeated calls stay idempotent.
   * @param {import('../model/types.js').MemoryRecord} record
   */
  syncRecord(record) {
    if (!LIVE_STATUSES.includes(record.status)) {
      this.#archive(record)
      return
    }
    if (entryPathFor(record) !== undefined) {
      this.#syncEntry(record)
      return
    }
    const rel = bucketPathFor(record)
    if (rel !== undefined) this.#resyncBucket(rel, [record.id])
  }

  /** Full reconciliation: DB authoritative, files converge. No version bumps.
   * @returns {{ rewrote: number, synced: number, errors: number }}
   */
  resyncAll() {
    const buckets = new Map()
    let errors = 0
    let entries = 0
    for (const record of this.repo.list()) {
      try {
        if (!LIVE_STATUSES.includes(record.status)) {
          this.#archive(record)
          continue
        }
        if (entryPathFor(record) !== undefined) {
          entries++
          this.#syncEntry(record)
          continue
        }
        const rel = bucketPathFor(record)
        if (rel === undefined) continue
        const ids = buckets.get(rel) ?? []
        ids.push(record.id)
        buckets.set(rel, ids)
      } catch {
        errors++
      }
    }
    let rewrote = 0
    for (const [rel] of buckets) {
      try {
        this.#resyncBucket(rel, [])
        rewrote++
      } catch {
        errors++
      }
    }
    return { rewrote, synced: buckets.size + entries, errors }
  }

  // ------------------------------------------------------------------
  // Status / health
  // ------------------------------------------------------------------

  /**
   * Compare every tracked projection row with its live file.
   * @returns {{
   *   summary: { synced: number, modified: number, missing: number, conflict: number, tracked: number },
   *   files: Array<{ memoryId: string, path: string, status: string, version: number }>,
   *   unknown: string[],
   *   archived: number,
   * }}
   */
  scanStatus() {
    const rows = this.repo.listProjectionStates()
    const owned = new Set()
    const files = []
    for (const row of rows) {
      owned.add(row.path)
      const hash = this.hash(row.path)
      const record = this.repo.get(row.memoryId)
      let status = 'synced'
      if (hash === undefined) status = 'missing'
      else if (hash !== row.fileHash) {
        const storeMoved = record !== undefined && record.updatedAt > row.writtenAt
        status = storeMoved ? 'conflict' : 'modified'
      }
      files.push({ memoryId: row.memoryId, path: row.path, status, version: row.version })
    }
    const summary = { synced: 0, modified: 0, missing: 0, conflict: 0, tracked: rows.length }
    for (const file of files) summary[file.status]++
    const tree = this.fs.walkMarkdown()
    const unknown = tree.filter((rel) => !rel.startsWith('archive/') && !owned.has(rel) && !this.owned(rel))
    const archived = tree.filter((rel) => rel.startsWith('archive/')).length
    return { summary, files, unknown, archived }
  }

  /** Read one file's sha256; undefined when missing. */
  hash(rel) {
    const text = this.fs.read(rel)
    return text === undefined ? undefined : sha256(text)
  }

  /** Whole-tree listing for the explorer: every projected path AND every `.md`
   * on disk. One entry per path; aggregate buckets carry all their record ids.
   * Tracked rows whose file is missing still appear (status: 'missing').
   * @returns {Array<{ path: string, archived: boolean, tracked: boolean,
   *   status?: string, memoryId?: string, memoryIds: string[], version?: number,
   *   size?: number, mtimeMs?: number }>}
   */
  treeFiles() {
    const rows = this.repo.listProjectionStates()
    const byPath = new Map()
    for (const row of rows) {
      const entry = byPath.get(row.path)
      if (entry === undefined) {
        byPath.set(row.path, {
          path: row.path,
          archived: row.path.startsWith('archive/'),
          tracked: true,
          memoryId: row.memoryId,
          version: row.version,
          memoryIds: [row.memoryId],
        })
      } else {
        entry.memoryIds.push(row.memoryId)
      }
    }
    for (const rel of this.fs.walkMarkdown()) {
      if (!byPath.has(rel)) byPath.set(rel, { path: rel, archived: rel.startsWith('archive/'), tracked: false, memoryIds: [] })
    }
    const statuses = new Map(this.scanStatus().files.map((file) => [file.path, file.status]))
    return [...byPath.values()]
      .map((entry) => ({ ...entry, status: statuses.get(entry.path), ...(this.fs.stat(entry.path) ?? {}) }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Whether a relative file was produced by the projector. */
  owned(rel) {
    const text = this.fs.read(rel)
    return text !== undefined && text.includes(OWNER_MARK)
  }

  /** Safe file read for the explorer route (undefined when missing). */
  readFile(rel) {
    const path = this.fs.safe(rel)
    const text = this.fs.read(path)
    return text === undefined ? undefined : { path, text }
  }

  /**
   * The text the store would write for a file right now — the deterministic
   * "expected" side of a diff. Aggregate buckets rebuild from their live rows
   * at the last shared write time; entry files re-render from their record.
   * @param {string} rel - relative path under the projection root.
   * @returns {string | undefined} - undefined when the path is untracked.
   */
  expectedText(rel) {
    const path = this.fs.safe(rel)
    if (path.startsWith('archive/')) return undefined
    const rows = this.repo.listProjectionStates().filter((row) => row.path === path)
    if (rows.length === 0) return undefined
    const first = this.repo.get(rows[0].memoryId)
    if (first !== undefined && entryPathFor(first) === path) {
      return renderEntry(first, rows[0].version)
    }
    // Aggregate bucket: canonical re-renders from its live records at the last
    // shared write time (identical for every row of the same bucket).
    const written = Math.max(...rows.map((row) => row.writtenAt))
    const records = rows
      .map((row) => this.repo.get(row.memoryId))
      .filter((record) => record !== undefined && LIVE_STATUSES.includes(record.status))
      .sort((a, b) => a.createdAt - b.createdAt)
    if (records.length === 0) return undefined
    return renderAggregate(records, { path, updatedAt: isoTime(written) })
  }

  /**
   * Rewrite one file from the store (repair missing, discard disk edits).
   * Archive files are never regenerated.
   * @param {string} rel - relative path under the projection root.
   * @returns {{ path: string, handled: boolean }}
   */
  restoreFile(rel) {
    const path = this.fs.safe(rel)
    if (path.startsWith('archive/')) return { path, handled: false }
    const rows = this.repo.listProjectionStates().filter((row) => row.path === path)
    if (rows.length === 0) return { path, handled: false }
    const first = this.repo.get(rows[0].memoryId)
    if (first !== undefined && entryPathFor(first) === path) {
      if (!LIVE_STATUSES.includes(first.status)) return { path, handled: false }
      this.#syncEntry(first)
      return { path, handled: true }
    }
    this.#resyncBucket(path, [])
    return { path, handled: true }
  }

  /**
   * Apply an edited file (typed in the Web UI): write it under the self-write
   * guard, then adopt its changes into the store. Equivalent to a user's
   * external edit followed by the watcher, minus the debounce.
   * @param {string} rel - relative path under the projection root.
   * @param {string} text - full new file content.
   * @returns {{ path: string, handled: boolean, created: number, updated: number, deleted: number }}
   */
  saveUserEdit(rel, text) {
    const path = this.fs.safe(rel)
    if (path.startsWith('archive/')) throw new Error('archive files are read-only')
    this.#write(path, String(text ?? ''))
    return { path, ...this.applyFileChange(path) }
  }

  // ------------------------------------------------------------------
  // Markdown → Store (user edits)
  // ------------------------------------------------------------------

  /**
   * Adopt a user-edited Markdown file back into the store. Entry files map
   * 1:1 to records; aggregate buckets diff their bullets by identity marker.
   * @param {string} rel - relative path under the projection root.
   * @returns {import('./adopt.js').AdoptionResult & { missing?: boolean }}
   */
  applyFileChange(rel) {
    const text = this.fs.read(this.fs.safe(rel))
    if (text === undefined) return { handled: false, missing: true, created: 0, updated: 0, deleted: 0 }
    if (this.fs.safe(rel).startsWith('archive/')) {
      return { handled: false, created: 0, updated: 0, deleted: 0 }
    }
    const { meta } = parseFrontmatter(text)
    const result = meta.memory_id !== undefined && meta.memory_id !== null
      ? adoptEntry(this.repo, text, meta)
      : adoptBucket(this.repo, text, this.fs.safe(rel))
    return result
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Write one entry file, bumping the version when content changed. */
  #syncEntry(record) {
    const rel = entryPathFor(record)
    if (rel === undefined) return
    const disk = this.fs.read(rel)
    const prior = this.repo.getProjectionState(record.id)
    const version = prior?.version ?? 1
    const canonical = renderEntry(record, version)
    if (disk === canonical) {
      // Store moved after our last write yet the file already equals this
      // canonical: an adoption wrote it first. Bump the embedded version so the
      // row and the frontmatter agree again.
      if (prior !== undefined && record.updatedAt > prior.writtenAt && this.hash(rel) !== prior.fileHash) {
        const bumped = version + 1
        const text = renderEntry(record, bumped)
        this.#write(rel, text)
        this.#save(record, rel, text, bumped)
      }
      return
    }
    const bumped = disk === undefined ? version : version + 1
    const text = renderEntry(record, bumped)
    this.#write(rel, text)
    this.#save(record, rel, text, bumped)
  }

  /** Rewrite one aggregate bucket from its live store records.
   * @param {string} rel
   * @param {string[]} bumpIds - records whose content actually changed.
   */
  #resyncBucket(rel, bumpIds) {
    const records = this.#recordsForBucket(rel)
    const rows = this.repo.listProjectionStates().filter((row) => row.path === rel)
    const rowsBy = new Map(rows.map((row) => [row.memoryId, row]))
    const liveIds = new Set(records.map((record) => record.id))
    // One shared clock sample: the file's frontmatter and every row's writtenAt
    // must agree so expectedText() can rebuild the canonical text byte-for-byte.
    const now = Date.now()
    const canonical = renderAggregate(records, { path: rel, updatedAt: isoTime(now) })
    if (records.length === 0) {
      if (this.fs.read(rel) !== undefined && this.owned(rel)) this.#unlink(rel)
      for (const row of rows) this.repo.deleteProjectionState(row.memoryId)
      return
    }
    const disk = this.fs.read(rel)
    const changed = disk === undefined || disk !== canonical
    if (changed) this.#write(rel, canonical)
    for (const record of records) {
      const prior = rowsBy.get(record.id)
      const bump = bumpIds.includes(record.id)
      const version = bump ? (prior?.version ?? 0) + 1 : (prior?.version ?? 1)
      // Save on any file rewrite, on a first sync, or when the store adopted a
      // change whose file already matches the canonical text (adoption flows
      // re-render nothing but still must refresh the recorded hash).
      if (changed || prior === undefined || bump) this.#save(record, rel, canonical, version, now)
    }
    for (const row of rows) {
      if (!liveIds.has(row.memoryId)) this.repo.deleteProjectionState(row.memoryId)
    }
  }

  /** Live store records mapped to one aggregate bucket (createdAt order). */
  #recordsForBucket(rel) {
    return this.repo
      .list({ statuses: LIVE_STATUSES })
      .filter((record) => bucketPathFor(record) === rel)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Move a record out of the live set into archive/. */
  #archive(record) {
    const prior = this.repo.getProjectionState(record.id)
    const version = prior?.version ?? 1
    const archived = { ...record, status: 'archived' }
    const text = renderEntry(archived, version)
    if (this.fs.read(archivedPathFor(record)) !== text) {
      this.#write(archivedPathFor(record), text)
    }
    const live = prior?.path ?? livePathFor(record)
    if (live !== undefined) {
      if (entryPathFor(record) !== undefined) {
        if (this.owned(live)) this.#unlink(live)
      } else if (this.fs.read(live) !== undefined) {
        this.#resyncBucket(live, [])
      }
    }
    this.repo.deleteProjectionState(record.id)
  }

  /** Record deleted from the store: tombstone it, drop the live copy. */
  #removeRecord(record) {
    const prior = this.repo.getProjectionState(record.id)
    if (prior !== undefined) {
      const tomb = renderEntry({ ...record, status: 'archived' }, prior.version)
      this.#write(archivedPathFor(record), tomb)
      if (entryPathFor(record) !== undefined) {
        if (this.owned(prior.path)) this.#unlink(prior.path)
      } else if (this.fs.read(prior.path) !== undefined) {
        this.#resyncBucket(prior.path, [])
      }
    }
    this.repo.deleteProjectionState(record.id)
  }

  /** Write a file (watchers must ignore this process's own writes). */
  #write(rel, text) {
    this.writing++
    try {
      this.fs.write(rel, text)
    } finally {
      this.writing--
    }
  }

  /** Remove a file owned by this process. */
  #unlink(rel) {
    this.writing++
    try {
      this.fs.unlink(rel)
    } finally {
      this.writing--
    }
  }

  /** Persist one projection state row.
   * @param {number} writtenAt - clock sample shared with the file frontmatter.
   */
  #save(record, rel, text, version, writtenAt = Date.now()) {
    this.repo.setProjectionState({
      memoryId: record.id,
      path: rel,
      fileHash: sha256(text),
      writtenAt,
      version,
    })
  }

  /** @type {(() => void) | undefined} */
  #dispose
}
