import test from 'node:test'
import assert from 'node:assert/strict'
import { openMemoryStore } from '../lib/store/sqlite.js'
import { SessionIngestPipeline, resolveProjectId } from '../lib/ingest/pipeline.js'

/** Build a fake session/event payload the same shape as DSH emits. */
function sessionStub(id) {
  return { id, header: { cwd: '/work/demo' } }
}
function userMessage(text, seq = 1) {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }] } }
}
function assistantMessage(text, seq = 1) {
  return {
    type: 'assistant/message',
    seq,
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}
function toolResult(name, text, seq = 1) {
  return { type: 'tool/result', seq, data: { message: { content: [{ type: 'tool-result', name, content: [{ type: 'text', text }] }] } } }
}

test('pipeline transcribes events into a session run and extracts profile memory', async () => {
  const repo = await openMemoryStore()
  try {
    const pipeline = new SessionIngestPipeline(repo)
    const session = sessionStub('sess_extract')

    pipeline.onSessionEvent(session, userMessage('我主要用 TypeScript。'))
    pipeline.onSessionEvent(session, assistantMessage('好的，我记下了。'))
    pipeline.onSessionEvent(session, toolResult('Read', 'content of file A'))

    const run = repo.getSessionRun('sess_extract')
    assert.ok(run, 'run row exists')
    assert.equal(run.userMessageCount, 1)
    assert.equal(run.assistantMessageCount, 1)
    assert.ok(run.transcript.includes('user: 我主要用 TypeScript。'))
    assert.ok(run.transcript.includes('assistant: 好的，我记下了。'))

    // the explicit self-statement became a memory with quoted evidence;
    // the v3 entry gate lands fresh user input in `candidate`, never `active`
    const memories = repo.list({ kinds: ['profile'], statuses: ['candidate'] })
    assert.equal(memories.length, 1, JSON.stringify(memories))
    assert.equal(memories[0].content, 'User mainly uses TypeScript')
    assert.equal(memories[0].source, 'user')
    assert.equal(memories[0].status, 'candidate')
    const evidence = repo.evidence(memories[0].id)
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].kind, 'transcript')
    assert.equal(evidence[0].quote, '我主要用 TypeScript。')
  } finally {
    repo.close()
  }
})

test('pipeline does not duplicate the same explicit statement twice', async () => {
  const repo = await openMemoryStore()
  try {
    const pipeline = new SessionIngestPipeline(repo)
    const session = sessionStub('sess_dedupe')
    pipeline.onSessionEvent(session, userMessage('我主要用 Go。'))
    pipeline.onSessionEvent(session, userMessage('我主要用 Go。'))
    const memories = repo.list({ kinds: ['profile'] })
    assert.equal(memories.length, 1)
  } finally {
    repo.close()
  }
})

test('pipeline ignores malformed events without throwing (memory never breaks chat)', async () => {
  const repo = await openMemoryStore()
  try {
    const pipeline = new SessionIngestPipeline(repo)
    const session = sessionStub('sess_bad')
    pipeline.onSessionEvent(session, null)
    pipeline.onSessionEvent(session, { type: 'totally/unknown' })
    pipeline.onSessionEvent(session, { type: 'user/message', data: { content: null } })
    pipeline.onSessionEvent(undefined, userMessage('no session'))
    const run = repo.getSessionRun('sess_bad')
    assert.equal(run.userMessageCount, 0)
    assert.ok(pipeline)
  } finally {
    repo.close()
  }
})

test('resolveProjectId keeps sane project identity only', () => {
  assert.equal(resolveProjectId('/work/my-app', undefined), 'my-app')
  assert.equal(resolveProjectId(undefined, 'proj_1'), 'proj_1')
  assert.equal(resolveProjectId('/work/.. weird ../x', undefined), undefined)
  assert.equal(resolveProjectId(undefined, undefined), undefined)
})

test('pipeline captures the session cwd/project context on the run row', async () => {
  const repo = await openMemoryStore()
  try {
    const pipeline = new SessionIngestPipeline(repo)
    pipeline.onSessionEvent(sessionStub('sess_cwd'), userMessage('hello'))
    const run = repo.getSessionRun('sess_cwd')
    assert.equal(run.cwd, '/work/demo')
    assert.equal(run.projectId, 'demo')
  } finally {
    repo.close()
  }
})

test('pipeline closes the run on dispose and keeps history rows', async () => {
  const repo = await openMemoryStore()
  try {
    const pipeline = new SessionIngestPipeline(repo)
    const session = sessionStub('sess_closed')
    pipeline.onSessionEvent(session, userMessage('hello'))
    pipeline.onSessionDisposed(session)
    const run = repo.getSessionRun('sess_closed')
    assert.equal(run.status, 'closed')
    assert.equal(repo.listSessionRuns().length, 1)
  } finally {
    repo.close()
  }
})
