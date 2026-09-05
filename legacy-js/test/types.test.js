import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canTransition,
  clampUnit,
  initialStatusFor,
  KIND_GROUPS,
  LIVE_STATUSES,
  makeId,
  MEMORY_KINDS,
  normalizeMemoryEvidence,
  normalizeMemoryRecord,
  RECORD_STATUSES,
  statusForAction,
} from '../lib/model/types.js'

test('clampUnit clamps to unit range and falls back on non-number', () => {
  assert.equal(clampUnit(0, 0.5), 0)
  assert.equal(clampUnit(1, 0.5), 1)
  assert.equal(clampUnit(-3, 0.5), 0)
  assert.equal(clampUnit(9, 0.5), 1)
  assert.equal(clampUnit(0.42, 0.5), 0.42)
  assert.equal(clampUnit('x', 0.5), 0.5)
  assert.equal(clampUnit(Number.NaN, 0.7), 0.7)
})

test('normalizeMemoryRecord fills defaults and freezes the record', () => {
  const record = normalizeMemoryRecord({
    id: 'mem_1',
    scope: 'global',
    kind: 'profile',
    content: 'User mainly uses TypeScript',
    createdAt: 1,
  })
  assert.equal(record.status, 'active')
  assert.equal(record.source, 'agent')
  assert.equal(record.importance, 0.5)
  assert.equal(record.confidence, 0.5)
  assert.deepEqual(record.sourceIds, [])
  assert.deepEqual(record.tags, [])
  assert.equal(record.userEdited, false)
  assert.ok(Object.isFrozen(record))
})

test('normalizeMemoryRecord rejects invalid inputs', () => {
  assert.throws(() => normalizeMemoryRecord(null), /plain object/)
  assert.throws(() => normalizeMemoryRecord({}), /id/)
  assert.throws(() => normalizeMemoryRecord({ id: 'x' }), /scope/)
  assert.throws(
    () => normalizeMemoryRecord({ id: 'x', scope: 'global' }),
    /kind/,
  )
  assert.throws(
    () => normalizeMemoryRecord({ id: 'x', scope: 'global', kind: 'profile' }),
    /content/,
  )
  assert.throws(
    () => normalizeMemoryRecord({
      id: 'x', scope: 'global', kind: 'profile', content: 'c', status: 'bogus',
    }),
    /status/,
  )
})

test('normalizeMemoryEvidence normalizes ref and keeps memoryId', () => {
  const ev = normalizeMemoryEvidence(
    {
      id: 'ev_1',
      memoryId: 'mem_1',
      kind: 'transcript',
      quote: '我用 TypeScript。',
      ref: { sessionId: 's1', eventSeq: 3 },
    },
    'mem_1',
  )
  assert.equal(ev.memoryId, 'mem_1')
  assert.equal(ev.ref.sessionId, 's1')
  assert.equal(ev.ref.eventSeq, 3)
  assert.ok(Object.isFrozen(ev))
  assert.throws(() => normalizeMemoryEvidence({ kind: 'nope', quote: 'x' }, 'mem_1'), /kind/)
})

test('makeId is stable length and unique', () => {
  const a = makeId('mem', 'same')
  const b = makeId('mem', 'same')
  assert.notEqual(a, b)
  assert.ok(a.startsWith('mem_'))
  assert.equal(typeof a, 'string')
})

test('data model v3 exports a closed kind vocabulary grouped by domain', () => {
  assert.equal(MEMORY_KINDS.length, 16)
  assert.ok(MEMORY_KINDS.includes('preference'))
  assert.ok(MEMORY_KINDS.includes('experience'))
  assert.ok(MEMORY_KINDS.includes('error_event'))
  assert.equal(KIND_GROUPS.preference, 'PERSONAL')
  assert.equal(KIND_GROUPS.decision, 'PROJECT')
  assert.equal(KIND_GROUPS.state, 'PROJECT')
  assert.equal(KIND_GROUPS.experience, 'EXPERIENCE')
  assert.equal(KIND_GROUPS.generalized_pattern, 'KNOWLEDGE')
  assert.equal(KIND_GROUPS.error_event, 'ERROR')
})

test('data model v3 status vocabulary: seven states, five live', () => {
  assert.deepEqual(RECORD_STATUSES, [
    'candidate', 'quarantined', 'verified', 'active', 'validated', 'superseded', 'archived',
  ])
  assert.deepEqual(LIVE_STATUSES, ['candidate', 'quarantined', 'verified', 'active', 'validated'])
})

test('normalizeMemoryRecord carries metadata, statusReason and version', () => {
  const record = normalizeMemoryRecord({
    id: 'mem_v3',
    scope: 'global',
    kind: 'fact',
    content: 'metadata survives normalization',
    metadata: { origin: 'onboarding', tags: ['a'] },
    status: 'candidate',
    statusReason: 'observed but not yet confirmed',
    source: 'user',
    createdAt: 1,
  })
  assert.equal(record.version, 1)
  assert.deepEqual(record.metadata, { origin: 'onboarding', tags: ['a'] })
  assert.equal(record.statusReason, 'observed but not yet confirmed')
  assert.equal(record.status, 'candidate')
  assert.throws(
    () => normalizeMemoryRecord({ id: 'x', scope: 'global', kind: 'fact', content: 'c', metadata: ['not-an-object'] }),
    /metadata/,
  )
  assert.throws(
    () => normalizeMemoryRecord({ id: 'x', scope: 'global', kind: 'fact', content: 'c', version: 0 }),
    /version/,
  )
  assert.throws(
    () => normalizeMemoryRecord({ id: 'x', scope: 'global', kind: 'fact', content: 'c', statusReason: 7 }),
    /statusReason/,
  )
})

test('normalizeMemoryEvidence carries summary and sourceType when given', () => {
  const ev = normalizeMemoryEvidence(
    {
      memoryId: 'mem_1',
      kind: 'transcript',
      quote: 'quote',
      summary: 'shows a TypeScript preference',
      sourceType: 'conversation',
    },
    'mem_1',
  )
  assert.equal(ev.summary, 'shows a TypeScript preference')
  assert.equal(ev.sourceType, 'conversation')
  assert.throws(
    () => normalizeMemoryEvidence({ kind: 'file', quote: 'x', summary: 5 }, 'mem_1'),
    /summary/,
  )
  assert.throws(
    () => normalizeMemoryEvidence({ kind: 'file', quote: 'x', sourceType: 5 }, 'mem_1'),
    /sourceType/,
  )
})

test('v3 status gate: fresh records enter candidate unless low-confidence non-user input', () => {
  // High-authority user statements always land as candidates, never quarantined.
  assert.equal(initialStatusFor(0.1, 'user'), 'candidate')
  assert.equal(initialStatusFor(0.95, 'user'), 'candidate')
  // Low-confidence inferred (non-user) observations are quarantined.
  assert.equal(initialStatusFor(0.5, 'agent'), 'quarantined')
  // At or above the confidence gate non-user input enters as candidate.
  assert.equal(initialStatusFor(0.6, 'agent'), 'candidate')
  assert.equal(initialStatusFor(0.6, 'session'), 'candidate')
  assert.equal(initialStatusFor(0.5, 'session'), 'quarantined')
})

test('v3 status gate: live statuses move freely, history only reopens via restore', () => {
  // Forward chain edges all exist.
  assert.equal(canTransition('candidate', 'verified'), true)
  assert.equal(canTransition('candidate', 'quarantined'), true)
  assert.equal(canTransition('quarantined', 'candidate'), true)
  assert.equal(canTransition('quarantined', 'verified'), true)
  assert.equal(canTransition('verified', 'active'), true)
  assert.equal(canTransition('active', 'validated'), true)
  assert.equal(canTransition('active', 'superseded'), true)
  assert.equal(canTransition('superseded', 'archived'), true)
  // Any live → live is allowed (promote/demote between live statuses) ...
  assert.equal(canTransition('candidate', 'active'), true)
  assert.equal(canTransition('validated', 'verified'), true)
  // ... but archived only reopens to candidate/verified/active, never further.
  assert.equal(canTransition('archived', 'active'), true)
  assert.equal(canTransition('archived', 'candidate'), true)
  assert.equal(canTransition('archived', 'verified'), true)
  assert.equal(canTransition('archived', 'validated'), false)
  assert.equal(canTransition('archived', 'superseded'), false)
  // Superseded never reopens.
  assert.equal(canTransition('superseded', 'active'), false)
  // Same-state transitions are inert and allowed.
  assert.equal(canTransition('active', 'active'), true)
})

test('v3 status gate: statusForAction resolves an action to its resulting state', () => {
  assert.equal(statusForAction('confirm', 'candidate'), 'verified')
  assert.equal(statusForAction('confirm', 'quarantined'), 'verified')
  assert.equal(statusForAction('confirm', 'verified'), 'active')
  assert.equal(statusForAction('reject', 'candidate'), 'quarantined')
  assert.equal(statusForAction('archive', 'candidate'), 'archived')
  assert.equal(statusForAction('restore', 'archived'), 'active')
  assert.equal(statusForAction('restore', 'active'), 'active')
  assert.equal(statusForAction('soft-delete', 'active'), 'archived')
  // Bookkeeping actions that are not status changes leave the status alone.
  assert.equal(statusForAction('split', 'active'), 'active')
  assert.equal(statusForAction('merge', 'verified'), 'verified')
})
