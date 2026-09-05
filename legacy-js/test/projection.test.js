import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryStore } from '../lib/store/sqlite.js'
import { MarkdownProjectionService } from '../lib/projection/service.js'

/**
 * In-memory store + a disposable projection root.
 * @returns {{ repo: import('../lib/store/repository.js').MemoryRepository,
 *   service: MarkdownProjectionService, root: string,
 *   read: (rel: string) => string, has: (rel: string) => boolean,
 *   cleanup: () => void }}
 */
async function setup() {
  const repo = await openMemoryStore()
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-proj-'))
  const service = new MarkdownProjectionService({ repo, root }).attach()
  service.resyncAll()
  return {
    repo,
    service,
    root,
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    has: (rel) => existsSync(join(root, rel)),
    cleanup: () => {
      service.detach()
      repo.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Deterministic bucket-only record builder (avoids the preference bucket). */
function record(id, content, createdAt) {
  return {
    id,
    scope: 'global',
    kind: 'profile',
    content,
    importance: 0.7,
    confidence: 1,
    source: 'user',
    sourceIds: [],
    tags: [],
    createdAt,
    updatedAt: createdAt,
  }
}

test('projection: bucket records create, merge and leave one file', async () => {
  const s = await setup()
  try {
    s.repo.put(record('mem_a', 'content A', 1000))
    s.repo.put(record('mem_b', 'content B', 2000))
    assert.equal(s.has('profile.md'), true)
    const text = s.read('profile.md')
    assert.match(text, /content A/)
    assert.match(text, /content B/)
    assert.match(text, /<!--mem:mem_a-->/)
    assert.match(text, /<!--mem:mem_b-->/)
    assert.ok(text.indexOf('content A') < text.indexOf('content B'), 'bullets follow createdAt order')

    let status = s.service.scanStatus()
    assert.equal(status.summary.tracked, 2)
    assert.equal(status.summary.synced, 2)

    s.repo.delete('mem_a', { actor: 'system' })
    assert.equal(s.read('profile.md').includes('content A'), false)
    assert.equal(s.read('profile.md').includes('content B'), true)

    s.repo.delete('mem_b', { actor: 'system' })
    assert.equal(s.has('profile.md'), false, 'last bullet deletion removes the owned bucket file')
    status = s.service.scanStatus()
    assert.equal(status.summary.tracked, 0)
  } finally {
    s.cleanup()
  }
})

test('projection: a missing file is reported and repaired from the store', async () => {
  const s = await setup()
  try {
    s.repo.put(record('mem_a', 'content A', 1000))
    rmSync(join(s.root, 'profile.md'))
    let status = s.service.scanStatus()
    assert.equal(status.summary.missing, 1)
    assert.equal(status.files[0].status, 'missing')

    assert.equal(s.service.restoreFile('profile.md').handled, true)
    assert.equal(s.has('profile.md'), true)
    assert.match(s.read('profile.md'), /content A/)
    status = s.service.scanStatus()
    assert.equal(status.summary.synced, 1)
  } finally {
    s.cleanup()
  }
})

test('projection: an external edit is modified then discarded by restore (DB wins)', async () => {
  const s = await setup()
  try {
    s.repo.put(record('mem_a', 'content A', 1000))
    writeFileSync(join(s.root, 'profile.md'), s.read('profile.md').replace('content A', 'user text'))
    let status = s.service.scanStatus()
    assert.equal(status.summary.modified, 1)

    assert.equal(s.service.restoreFile('profile.md').handled, true)
    assert.match(s.read('profile.md'), /content A/)
    assert.equal(s.read('profile.md').includes('user text'), false)
    status = s.service.scanStatus()
    assert.equal(status.summary.synced, 1)
  } finally {
    s.cleanup()
  }
})

test('projection: version bumps only when content changed, never on reconcile', async () => {
  const s = await setup()
  try {
    const id = 'mem_e'
    const rel = 'projects/p1/experiences/mem_e.md'
    // experiences are project-scoped records that own a dedicated entry file
    const experience = (content) => ({ ...record(id, content, 1000), kind: 'experience', scope: 'project', projectId: 'p1' })
    s.repo.put(experience('experience summary'))
    s.repo.put(experience('updated summary'))
    s.repo.put(experience('updated again'))
    assert.equal(s.has(rel), true)
    let row = s.repo.getProjectionState(id)
    assert.equal(row.path, rel)
    assert.equal(row.version, 3)
    const before = row.fileHash

    s.service.resyncAll()
    row = s.repo.getProjectionState(id)
    assert.equal(row.version, 3, 'reconcile is not a content change')
    assert.equal(row.fileHash, before)
    assert.equal(s.service.scanStatus().summary.synced, 1)
  } finally {
    s.cleanup()
  }
})

test('projection: conflict state resolves toward the store when both sides moved', async () => {
  const s = await setup()
  try {
    s.repo.put(record('mem_a', 'content A', 1000))
    const rel = 'profile.md'
    s.service.detach() // stop auto-sync so we can diverge both sides
    writeFileSync(join(s.root, rel), s.read(rel).replace('content A', 'local edit'))
    s.repo.put({ ...record('mem_a', 'remote change', 1000) })
    // Simulate the store moving after the projection last wrote: age the row.
    s.repo.setProjectionState({ memoryId: 'mem_a', path: rel, fileHash: 'stale', writtenAt: 0, version: 1 })

    const status = s.service.scanStatus()
    assert.equal(status.files[0].status, 'conflict')

    assert.equal(s.service.restoreFile(rel).handled, true)
    assert.match(s.read(rel), /remote change/)
    assert.equal(s.read(rel).includes('local edit'), false)
    assert.equal(s.service.scanStatus().summary.synced, 1)
  } finally {
    s.cleanup()
  }
})

test('projection: user edits via saveUserEdit are adopted back into the store', async () => {
  const s = await setup()
  try {
    s.repo.put(record('mem_a', 'content A', 1000))
    const edited = s.read('profile.md').replace('content A', 'edited from WebUI')
    const result = s.service.saveUserEdit('profile.md', edited)
    assert.equal(result.handled, true)
    assert.equal(result.updated, 1)
    const stored = s.repo.get('mem_a')
    assert.equal(stored.content, 'edited from WebUI')
    assert.equal(stored.userEdited, true)
    assert.equal(s.service.scanStatus().summary.synced, 1)
  } finally {
    s.cleanup()
  }
})

test('projection: expectedText reproduces the canonical file for diffs', async () => {
  const s = await setup()
  try {
    s.repo.put(record('mem_a', 'content A', 1000))
    s.repo.put(record('mem_b', 'content B', 2000))
    assert.equal(s.service.expectedText('profile.md'), s.read('profile.md'))

    // external edit does not move the DB side of the diff
    writeFileSync(join(s.root, 'profile.md'), s.read('profile.md').replace('content A', 'edited'))
    assert.notEqual(s.service.expectedText('profile.md'), s.read('profile.md'))
    assert.match(s.service.expectedText('profile.md'), /content A/)

    // an unknown file has no DB side
    assert.equal(s.service.expectedText('scratch.md'), undefined)
  } finally {
    s.cleanup()
  }
})

test('projection: treeFiles merges tracked rows (even missing) with disk files', async () => {
  const s = await setup()
  try {
    s.repo.put(record('mem_a', 'content A', 1000))
    s.repo.put({ ...record('mem_e', 'experience body', 1000), kind: 'experience', scope: 'project', projectId: 'p1' })
    writeFileSync(join(s.root, 'notes.md'), '# notes')
    rmSync(join(s.root, 'profile.md')) // tracked row whose file is missing

    const files = s.service.treeFiles()
    const by = Object.fromEntries(files.map((file) => [file.path, file]))
    assert.equal(by['profile.md'].tracked, true)
    assert.equal(by['profile.md'].status, 'missing')
    assert.equal(by['profile.md'].memoryIds.length, 1)
    assert.equal(by['projects/p1/experiences/mem_e.md'].tracked, true)
    assert.equal(by['notes.md'].tracked, false)
    assert.deepEqual(by['notes.md'].memoryIds, [])
  } finally {
    s.cleanup()
  }
})
