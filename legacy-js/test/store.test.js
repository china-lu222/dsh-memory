import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemoryStore, openStore } from '../lib/store/sqlite.js'
import { makeId } from '../lib/model/types.js'

test('store: create, update, audit, evidence round-trip', async () => {
  const repo = await openMemoryStore()
  try {
    const now = Date.now()
    const id = makeId('mem', 'roundtrip')
    const saved = repo.put({
      id,
      scope: 'global',
      kind: 'profile',
      content: 'User mainly uses TypeScript',
      importance: 0.8,
      confidence: 0.9,
      source: 'user',
      createdAt: now,
      updatedAt: now,
    }, { actor: 'user' })
    assert.equal(repo.get(id).content, 'User mainly uses TypeScript')

    repo.addEvidence({
      id: 'ev_1',
      memoryId: id,
      kind: 'transcript',
      quote: '我主要用 TypeScript。',
      ref: { sessionId: 's1' },
      observedAt: now,
    })
    const evidence = repo.evidence(id)
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].quote, '我主要用 TypeScript。')

    // update keeps createdAt, records audit
    repo.put({
      ...saved,
      content: 'User mainly uses TypeScript and Go',
      confidence: 1,
      userEdited: true,
    }, { actor: 'user' })
    const updated = repo.get(id)
    assert.equal(updated.content, 'User mainly uses TypeScript and Go')
    assert.equal(updated.userEdited, true)
    assert.equal(updated.createdAt, now)

    const audit = repo.audit(id)
    assert.equal(audit.length, 2)
    assert.equal(audit[0].action, 'create')
    assert.equal(audit[1].action, 'update')
    assert.equal(audit[1].before.content, 'User mainly uses TypeScript')
    assert.equal(audit[1].after.content, 'User mainly uses TypeScript and Go')

    // list by scope/kind/query
    const rows = repo.list({ scopes: ['global'], kinds: ['profile'], query: 'TypeScript' })
    assert.equal(rows.length, 1)

    // delete keeps audit, evidence is cascaded
    assert.equal(repo.delete(id, { actor: 'system' }), true)
    assert.equal(repo.get(id), undefined)
    assert.equal(repo.evidence(id).length, 0)
    assert.equal(repo.audit(id).length, 3)
    assert.equal(repo.audit(id)[2].action, 'delete')
  } finally {
    repo.close()
  }
})

test('store: exportJson is complete and re-seedable', async () => {
  const repo = await openMemoryStore()
  try {
    repo.put({ id: 'mem_a', scope: 'global', kind: 'fact', content: 'fact A', createdAt: 1, updatedAt: 1 })
    repo.put({ id: 'mem_b', scope: 'project', kind: 'constraint', content: 'never x', projectId: 'proj', createdAt: 2, updatedAt: 2 })
    const dump = repo.exportJson()
    assert.equal(dump.schemaVersion, 1)
    assert.equal(dump.memories.length, 2)
    assert.equal(dump.memories[0].content, 'fact A')
    assert.ok(dump.meta.schema_version)
  } finally {
    repo.close()
  }
})

test('store: session runs upsert', async () => {
  const repo = await openMemoryStore()
  try {
    repo.putSessionRun({
      sessionId: 'sess_1',
      cwd: '/work/proj',
      projectId: 'proj',
      startedAt: 1000,
      updatedAt: 2000,
      userMessageCount: 1,
      transcript: 'user: hi',
    })
    repo.putSessionRun({
      sessionId: 'sess_1',
      cwd: '/work/proj',
      projectId: 'proj',
      startedAt: 1000,
      updatedAt: 3000,
      userMessageCount: 2,
      transcript: 'user: hi\nuser: how are you',
      status: 'closed',
    })
    const run = repo.getSessionRun('sess_1')
    assert.equal(run.userMessageCount, 2)
    assert.equal(run.updatedAt, 3000)
    assert.equal(run.status, 'closed')
    const all = repo.listSessionRuns()
    assert.equal(all.length, 1)
  } finally {
    repo.close()
  }
})

test('store: rejects write to unknown memory evidence target', async () => {
  const repo = await openMemoryStore()
  try {
    assert.throws(() => repo.addEvidence({ kind: 'transcript', quote: 'x', memoryId: 'nope' }), /not found/)
  } finally {
    repo.close()
  }
})

test('store: v3 record fields round-trip (metadata, version, status reason, audit states)', async () => {
  const repo = await openMemoryStore()
  try {
    const id = 'mem_v3_fields'
    const created = repo.put({
      id,
      scope: 'global',
      kind: 'decision',
      content: 'content v1',
      metadata: { risk: 'low', refs: ['a', 'b'] },
      status: 'candidate',
      statusReason: 'fresh candidate awaiting review',
      source: 'user',
      createdAt: 1,
      updatedAt: 1,
    }, { actor: 'user', reason: 'captured during onboarding' })

    assert.equal(created.version, 1)
    assert.equal(created.status, 'candidate')
    let got = repo.get(id)
    assert.deepEqual(got.metadata, { risk: 'low', refs: ['a', 'b'] })
    assert.equal(got.statusReason, 'fresh candidate awaiting review')
    assert.equal(got.version, 1)

    // Same-content update (importance only) does not bump the version.
    repo.put({ ...got, importance: 1 }, { actor: 'user' })
    assert.equal(repo.get(id).version, 1)

    // Content change bumps the version exactly once.
    const bumped = repo.put(
      { ...repo.get(id), content: 'content v2' },
      { actor: 'user', reason: 'user clarified the decision' },
    )
    assert.equal(bumped.version, 2)
    got = repo.get(id)
    assert.equal(got.content, 'content v2')
    assert.deepEqual(got.metadata, { risk: 'low', refs: ['a', 'b'] })

    // Audit carries the statuses on each side plus the caller reason.
    const audit = repo.audit(id)
    assert.equal(audit.length, 3)
    assert.equal(audit[0].action, 'create')
    assert.equal(audit[0].afterState, 'candidate')
    assert.equal(audit[0].reason, 'captured during onboarding')
    // The metadata-only change audits with no reason and no version bump.
    assert.equal(audit[1].action, 'update')
    assert.equal(audit[1].beforeState, 'candidate')
    assert.equal(audit[1].afterState, 'candidate')
    assert.equal(audit[1].reason, undefined)
    // The content change records the caller-provided reason.
    assert.equal(audit[2].action, 'update')
    assert.equal(audit[2].beforeState, 'candidate')
    assert.equal(audit[2].afterState, 'candidate')
    assert.equal(audit[2].reason, 'user clarified the decision')

    // Evidence carries v3 summary / source_type through a full cycle.
    repo.addEvidence({
      id: 'ev_v3',
      memoryId: id,
      kind: 'file',
      quote: 'quote text',
      summary: 'supports the decision',
      sourceType: 'file',
      observedAt: 2,
    })
    const evidence = repo.evidence(id)
    assert.equal(evidence[0].summary, 'supports the decision')
    assert.equal(evidence[0].sourceType, 'file')
  } finally {
    repo.close()
  }
})

test('store: migrates a v2 database to schema v3, preserving data and writing a backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-v2-'))
  const file = join(dir, 'memory.db')
  try {
    // Build a genuine v2-shaped database (no version/status_reason/deleted_at/
    // metadata on memories; no reason/before_state/after_state on audit; no
    // summary/source_type on evidence) with one live memory + evidence.
    const { DatabaseSync } = await import('node:sqlite')
    const v2 = new DatabaseSync(file)
    v2.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta (key, value) VALUES ('schema_version', '2');
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL,
        source_ids TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        user_edited INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        quote TEXT NOT NULL,
        ref_session_id TEXT,
        ref_event_seq INTEGER,
        ref_tool_call_id TEXT,
        ref_path TEXT,
        observed_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO memories (id, scope, kind, content, status, source, created_at, updated_at)
        VALUES ('legacy_1', 'global', 'fact', 'pre-v3 fact', 'active', 'agent', 100, 100);
      INSERT INTO evidence (id, memory_id, kind, quote, observed_at)
        VALUES ('ev_legacy', 'legacy_1', 'observation', 'seen in transcript', 100);
    `)
    v2.close()

    const repo = await openStore(file)
    try {
      assert.equal(repo.getMeta('schema_version'), '3')

      // The v2 row survives and reads back through the v3 column set.
      const legacy = repo.get('legacy_1')
      assert.equal(legacy.content, 'pre-v3 fact')
      assert.equal(legacy.status, 'active')
      assert.equal(legacy.version, 1)
      assert.deepEqual(legacy.metadata, {})
      assert.equal(repo.evidence('legacy_1').length, 1)

      // New v3-only columns accept writes on the migrated store.
      const created = repo.put({
        id: 'mem_v3_new',
        scope: 'global',
        kind: 'decision',
        content: 'adopt sqlite metadata',
        metadata: { risk: 'low' },
        statusReason: 'created after v3 migration',
        source: 'user',
        createdAt: 200,
        updatedAt: 200,
      })
      assert.deepEqual(repo.get('mem_v3_new').metadata, { risk: 'low' })
      assert.equal(repo.get('mem_v3_new').statusReason, 'created after v3 migration')
      assert.equal(repo.get('mem_v3_new').version, 1)
      repo.addEvidence({
        id: 'ev_v3_new',
        memoryId: 'mem_v3_new',
        kind: 'file',
        quote: 'q',
        summary: 's',
        sourceType: 'file',
        observedAt: 300,
      })
      assert.equal(repo.evidence('mem_v3_new')[0].sourceType, 'file')

      // A pre-migration snapshot was written next to the database.
      assert.equal(existsSync(`${file}.bak`), true)
      assert.ok(statSync(`${file}.bak`).size > 0)
    } finally {
      repo.close()
    }

    // Reopening after migration is a no-op that stays on schema v3.
    const reopened = await openStore(file)
    try {
      assert.equal(reopened.getMeta('schema_version'), '3')
      assert.equal(reopened.get('legacy_1').content, 'pre-v3 fact')
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
