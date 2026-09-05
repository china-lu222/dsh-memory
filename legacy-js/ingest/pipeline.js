// dsh-memory-personal — session ingest pipeline.
//
// Consumes DSH session events ("session/event" with a SessionEvent payload,
// plus "session/created" / "session/flush" / "session/disposed") and produces
// two durable outputs in the MemoryStore:
//   1. a per-session transcription (session_runs table),
//   2. memory records for explicit user self-statements, with quoted evidence.
//
// The pipeline is intentionally event-driven but NEVER blocks or throws on a
// malformed event: memory is an amplifier, not a gating dependency of chat.

import { collapseLine, extractMessageText } from './text.js'
import { extractCandidates } from './rules.js'
import { initialStatusFor, LIVE_STATUSES, makeId } from '../model/types.js'

/** @typedef {import('../store/repository.js').MemoryRepository} MemoryRepository */

const MAX_TRANSCRIPT_CHARS = 100_000

/**
 * Project id derivation is defensive: we only accept values that look like a
 * real path segment or an explicit id. Never derive from random text.
 * @param {string | undefined} cwd
 * @param {string | undefined} projectId
 * @returns {string | undefined}
 */
export function resolveProjectId(cwd, projectId) {
  if (projectId && /^[A-Za-z0-9._-]{1,120}$/.test(projectId)) return projectId
  if (cwd) {
    const parts = cwd.replaceAll('\\', '/').split('/').filter(Boolean)
    // Refuse suspicious path segments (parent traversal, whitespace) so a
    // hostile or malformed cwd can never become project identity.
    if (parts.some((p) => p === '..' || p.includes('..') || /\s/.test(p))) return undefined
    const last = parts[parts.length - 1]
    if (last && /^[A-Za-z0-9._-]{1,120}$/.test(last)) return last
  }
  return undefined
}

/**
 * Ingest pipeline for one plugin instance. Each DSH session maps to a
 * "run" row; user text is appended to the run transcript and pushed through
 * the extraction rules; extracted candidates become memory records guarded by
 * a dedupe check.
 */
export class SessionIngestPipeline {
  /**
   * @param {MemoryRepository} repo - store.
   * @param {object} [options] - options.
   * @param {boolean} [options.enableProfileExtraction=true]
   */
  constructor(repo, options = {}) {
    this.repo = repo
    this.enableProfileExtraction = options.enableProfileExtraction ?? true
    /** @type {Map<string, {sessionId:string, cwd:string|undefined, projectId:string|undefined, startedAt:number, lines:string[], userCount:number, assistantCount:number, toolCount:number, lastSeq:number}>} */
    this.#runs = new Map()
  }

  /** @type {Map<string, object>} */
  #runs

  /**
   * Handle an event emitted on a DSH session. Signature mirrors
   * ctx.on('session/event', (session, event) => …); tolerant of shape drift.
   * @param {object} session - DSH session object.
   * @param {object} event - DSH session event.
   */
  onSessionEvent(session, event) {
    if (!event || typeof event !== 'object') return
    const sessionId = typeof session?.id === 'string' && session.id ? session.id : undefined
    if (!sessionId) return
    const eventType = event.type
    if (eventType !== 'user/message' && eventType !== 'assistant/message'
      && eventType !== 'tool/call' && eventType !== 'tool/result'
      && eventType !== 'turn/start' && eventType !== 'user/header') {
      return
    }
    const run = this.#ensureRun(sessionId, session)
    run.lastSeq += 1
    const data = event.data ?? event
    switch (eventType) {
      case 'user/message': {
        const text = extractMessageText(data)
        if (text.trim().length > 0) {
          run.userCount += 1
          run.lines.push(`user: ${collapseLine(text)}`)
          if (this.enableProfileExtraction) this.#extractFromUserText(text, sessionId)
        }
        break
      }
      case 'assistant/message': {
        const msg = data.message ?? data
        const text = extractMessageText(msg)
        if (text.trim().length > 0) {
          run.assistantCount += 1
          run.lines.push(`assistant: ${collapseLine(text)}`)
        }
        break
      }
      case 'tool/result': {
        const msg = data.message ?? data
        const text = extractMessageText(msg)
        if (text.trim().length > 0) {
          run.toolCount += 1
          const callId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
          run.lines.push(`tool${callId ? `(${callId})` : ''}: ${collapseLine(text, 800)}`)
        }
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'tool'
        run.lines.push(`#tool-call ${name} args=${JSON.stringify(data.arguments ?? {})}`)
        break
      }
      case 'turn/start': {
        break
      }
      case 'user/header': {
        break
      }
      default:
        break
    }
    // Persist incrementally so a crash loses at most this run.
    this.#persistRun(sessionId, 'open')
  }

  /** Handle the durable per-session flush (final state recorded by host). */
  onSessionFlush() {
    // Events already persist incrementally; flush is a no-op guarantee that the
    // run row reflects the latest event we saw.
  }

  /** Close bookkeeping for a disposed session (kept rows for history). */
  onSessionDisposed(session) {
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (!sessionId) return
    const run = this.#runs.get(sessionId)
    if (run) {
      this.#captureSessionContext(run, session)
      this.#persistRun(sessionId, 'closed')
    }
    this.#runs.delete(sessionId)
  }

  /**
   * Read the working directory a session was created in. DSH carries it on the
   * session snapshot (accepting `session.header.cwd`, `session.cwd` and
   * `session.meta.cwd` so host-version drift degrades to an empty value, never
   * a crash).
   * @param {object} session - DSH session object.
   * @returns {string | undefined}
   */
  static sessionCwd(session) {
    if (!session || typeof session !== 'object') return undefined
    for (const candidate of [session.header?.cwd, session.cwd, session.meta?.cwd]) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
    return undefined
  }

  /** Fold the session's cwd / project context into a run once, when first seen. */
  #captureSessionContext(run, session) {
    if (run.cwd !== undefined) return
    const cwd = SessionIngestPipeline.sessionCwd(session)
    if (cwd === undefined) return
    run.cwd = cwd
    run.projectId = resolveProjectId(cwd, typeof session?.projectId === 'string' ? session.projectId : undefined)
  }

  /** @param {string} sessionId */
  #ensureRun(sessionId, session) {
    const existing = this.#runs.get(sessionId)
    if (existing) return existing
    const run = { sessionId, cwd: undefined, projectId: undefined, startedAt: Date.now(), lines: [], userCount: 0, assistantCount: 0, toolCount: 0, lastSeq: 0 }
    this.#runs.set(sessionId, run)
    if (session) this.#captureSessionContext(run, session)
    return run
  }

  /** Persist one run row, trimming transcript to the budget. */
  #persistRun(sessionId, status) {
    const run = this.#runs.get(sessionId)
    if (!run) return
    const transcript = run.lines.join('\n').slice(-MAX_TRANSCRIPT_CHARS)
    this.repo.putSessionRun({
      sessionId,
      cwd: run.cwd,
      projectId: run.projectId,
      startedAt: run.startedAt,
      updatedAt: Date.now(),
      userMessageCount: run.userCount,
      assistantMessageCount: run.assistantCount,
      toolCallCount: run.toolCount,
      turnCount: 0,
      lastSeq: run.lastSeq,
      transcript,
      status,
    })
  }

  /**
   * Run extraction rules on a user message and write any high-confidence
   * profile facts as memory records (skipping exact duplicates).
   * @param {string} text - the user message text.
   * @param {string} sessionId - owning session.
   */
  #extractFromUserText(text, sessionId) {
    const candidates = extractCandidates(text)
    for (const cand of candidates) {
      const dupes = this.repo.list({
        scopes: ['global', 'project'],
        kinds: ['profile'],
        statuses: LIVE_STATUSES,
        query: cand.content,
        limit: 10,
      })
      const already = dupes.some((r) => r.content === cand.content)
      if (already) continue
      const id = makeId('mem', `${sessionId}:${cand.content}`)
      const now = Date.now()
      const record = {
        id,
        scope: 'global',
        kind: 'profile',
        content: cand.content,
        summary: cand.summary,
        importance: 0.7,
        confidence: cand.confidence,
        // v3 entry gate: fresh input never lands directly in `active`.
        status: initialStatusFor(cand.confidence, 'user'),
        source: 'user',
        sourceIds: [sessionId],
        tags: ['profile', 'language'],
        createdAt: now,
        updatedAt: now,
        userEdited: false,
      }
      this.repo.put(record, { actor: 'user' })
      this.repo.addEvidence({
        id: makeId('ev', `${id}:${cand.quote}`),
        memoryId: id,
        kind: 'transcript',
        quote: cand.quote,
        ref: { sessionId },
        observedAt: now,
      })
    }
  }
}
