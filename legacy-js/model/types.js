// dsh-memory-personal — domain model of the memory system.
//
// All memory records live in one SQLite store and are typed by (scope, kind).
// A record is a FACT CLAIM with provenance, importance and confidence; it is
// NEVER treated as current truth by itself — consumers combine it with the
// current explicit user statement / project state (see docs/DECISIONS.md).

/**
 * Memory scopes, ordered from most specific to most general.
 * Promotion/demotion between scopes is a later-phase operation.
 * @typedef {'session' | 'project' | 'global' | 'generalized'} MemoryScope
 */

/**
 * Record kinds inside a scope (data model v3).
 *
 * PERSONAL   profile / preference / fact / goal / skill / constraint
 * PROJECT    project_state / architecture / decision / dependency / issue
 * EXPERIENCE experience / failed_experience
 * KNOWLEDGE  generalized_pattern
 * ERROR      error_event
 *
 * Legacy kind `state` (untyped project-state snapshot) is kept valid for
 * on-disk compatibility; new writes should use `project_state`.
 * @typedef {'profile' | 'preference' | 'fact' | 'goal' | 'skill' | 'constraint'
 *   | 'state' | 'project_state' | 'architecture' | 'decision' | 'dependency' | 'issue'
 *   | 'experience' | 'failed_experience' | 'generalized_pattern' | 'error_event'} MemoryKind
 */

/**
 * Kind grouping by ownership domain (data model v3). Used by the WebUI and by
 * future per-domain pipelines to map a kind to its bucket without hardcoding.
 * @typedef {'PERSONAL' | 'PROJECT' | 'EXPERIENCE' | 'KNOWLEDGE' | 'ERROR'} KindGroup
 */

/**
 * Lifecycle status of a record (data model v3 state machine).
 * New records must enter as `candidate` (or `quarantined` when low-confidence);
 * `input → active` directly is forbidden. Records traverse
 * candidate → quarantined → verified → active → validated, and leave the live
 * set through superseded/archived.
 * @typedef {'candidate' | 'quarantined' | 'verified' | 'active'
 *   | 'validated' | 'superseded' | 'archived'} RecordStatus
 */

/**
 * Provenance source of a memory.
 * - `user`        explicit user statement (highest authority)
 * - `agent`       agent inference
 * - `session`     derived from a session transcript
 * - `tool-result` derived from a tool result
 * - `system`      plugin/system bookkeeping
 * @typedef {'user' | 'agent' | 'session' | 'tool-result' | 'system'} MemorySource
 */

/**
 * A single memory record (the persisted claim).
 * `version` increments on every content change (see docs); `metadata` holds
 * kind-specific extra fields; `statusReason` explains the current status.
 * @typedef {{
 *   id: string,
 *   scope: MemoryScope,
 *   kind: MemoryKind,
 *   projectId?: string,
 *   sessionId?: string,
 *   content: string,
 *   summary?: string,
 *   metadata?: object,
 *   importance: number,
 *   confidence: number,
 *   status: RecordStatus,
 *   statusReason?: string,
 *   source: MemorySource,
 *   sourceIds: string[],
 *   tags: string[],
 *   createdAt: number,
 *   updatedAt: number,
 *   userEdited: boolean,
 *   version: number,
 * }} MemoryRecord
 */

/**
 * Evidence backing a memory record: the concrete observable that supports it.
 * `summary` condenses what the quote demonstrates; `sourceType` classifies the
 * origin medium (e.g. 'conversation' | 'file' | 'tool') alongside the finer
 * v2 `kind` vocabulary, which stays stable for on-disk compatibility.
 * @typedef {{
 *   id: string,
 *   memoryId: string,
 *   kind: 'transcript' | 'tool-result' | 'user-edit' | 'file' | 'observation',
 *   quote: string,
 *   summary?: string,
 *   sourceType?: string,
 *   ref: { sessionId?: string, eventSeq?: number, toolCallId?: string, path?: string },
 *   observedAt: number,
 * }} MemoryEvidence
 */

/**
 * An audit entry: who/what changed which record, and what it looked like.
 * `reason` (from the correction sheet) is mandatory on every user/agent
 * mutation; `beforeState/afterState` store the previous/target status on
 * status changes. `actor` keeps the legacy source vocabulary.
 * @typedef {{
 *   id: string,
 *   memoryId: string,
 *   action: AuditAction,
 *   actor: MemorySource,
 *   reason?: string,
 *   beforeState?: RecordStatus,
 *   afterState?: RecordStatus,
 *   before?: object,
 *   after?: object,
 *   at: number,
 * }} AuditEntry
 */

/**
 * Allowed mutations recorded in the audit log.
 * @typedef {'create' | 'update' | 'delete' | 'soft-delete' | 'status-change'
 *   | 'confirm' | 'reject' | 'restore' | 'archive' | 'merge' | 'split'
 *   | 'user-edit' | 'promote' | 'demote'} AuditAction
 */

export const MEMORY_SCOPES = ['session', 'project', 'global', 'generalized']

/** All kinds understood by data model v3 (personal / project / experience / knowledge / error). */
export const MEMORY_KINDS = [
  // PERSONAL
  'profile', 'preference', 'fact', 'goal', 'skill', 'constraint',
  // PROJECT
  'state', 'project_state', 'architecture', 'decision', 'dependency', 'issue',
  // EXPERIENCE / KNOWLEDGE / ERROR
  'experience', 'failed_experience', 'generalized_pattern', 'error_event',
]

/**
 * kind → owning domain group. `state` is legacy-project knowledge.
 * @type {Record<string, string>}
 */
export const KIND_GROUPS = Object.freeze({
  profile: 'PERSONAL',
  preference: 'PERSONAL',
  fact: 'PERSONAL',
  goal: 'PERSONAL',
  skill: 'PERSONAL',
  constraint: 'PERSONAL',
  state: 'PROJECT',
  project_state: 'PROJECT',
  architecture: 'PROJECT',
  decision: 'PROJECT',
  dependency: 'PROJECT',
  issue: 'PROJECT',
  experience: 'EXPERIENCE',
  failed_experience: 'EXPERIENCE',
  generalized_pattern: 'KNOWLEDGE',
  error_event: 'ERROR',
})

/**
 * Data model v3 status vocabulary. The live/retrievable set is
 * candidate/quarantined/verified/active/validated; superseded/archived are
 * history. `active` must NOT be assigned directly from a new observation:
 * records enter as `candidate` (or `quarantined` under the confidence gate).
 * The gate lives at the ingest boundary (initialStatusFor); normalizeMemoryRecord
 * keeps a legacy 'active' fallback only for writers that predate the gate.
 * @type {RecordStatus[]}
 */
export const RECORD_STATUSES = [
  'candidate', 'quarantined', 'verified', 'active', 'validated', 'superseded', 'archived',
]

/** Statuses considered live (retrievable) by default. */
export const LIVE_STATUSES = ['candidate', 'quarantined', 'verified', 'active', 'validated']

/**
 * Status an ingest gate assigns to a fresh observation when the confidence
 * gate does not fire (quarantined below CONFIDENCE_GATE for non-user sources).
 * This is the state-machine entry default, NOT the generic record fallback in
 * normalizeMemoryRecord, which stays 'active' until every writer is gated.
 */
export const DEFAULT_INITIAL_STATUS = 'candidate'

/** Below this confidence a fresh record must be quarantined, never active. */
export const CONFIDENCE_GATE = 0.6

export const MEMORY_SOURCES = ['user', 'agent', 'session', 'tool-result', 'system']
export const EVIDENCE_KINDS = ['transcript', 'tool-result', 'user-edit', 'file', 'observation']
export const AUDIT_ACTIONS = [
  'create', 'update', 'delete', 'soft-delete', 'status-change', 'confirm', 'reject',
  'restore', 'archive', 'merge', 'split', 'user-edit', 'promote', 'demote',
]

/** Zero-length content is never a valid memory. */
export const MAX_CONTENT = 20_000

/**
 * Clamp a number to [0,1].
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value when input is not a finite number.
 * @returns {number}
 */
export function clampUnit(value, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Validate an arbitrary value as a MemoryRecord. Throws with a precise
 * message on the first violation. Detached-input boundary for the store and
 * the HTTP layer (never trust callers' objects).
 * @param {unknown} input - the candidate record.
 * @returns {MemoryRecord} a frozen normalized record.
 */
export function normalizeMemoryRecord(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('memory record must be a plain object')
  }
  const record = /** @type {Record<string, unknown>} */ (input)
  const id = record.id
  const scope = record.scope
  const kind = record.kind
  if (typeof id !== 'string' || id.length === 0) throw new Error('memory id must be a non-empty string')
  if (!MEMORY_SCOPES.includes(/** @type {MemoryScope} */ (scope))) {
    throw new Error(`memory scope must be one of ${MEMORY_SCOPES.join(', ')}`)
  }
  if (!MEMORY_KINDS.includes(/** @type {MemoryKind} */ (kind))) {
    throw new Error(`memory kind must be one of ${MEMORY_KINDS.join(', ')}`)
  }
  if (record.projectId !== undefined && typeof record.projectId !== 'string') {
    throw new Error('projectId must be a string')
  }
  if (record.sessionId !== undefined && typeof record.sessionId !== 'string') {
    throw new Error('sessionId must be a string')
  }
  const content = record.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('memory content must be a non-empty string')
  }
  if (content.length > MAX_CONTENT) throw new Error(`memory content exceeds ${MAX_CONTENT} chars`)
  const summary = record.summary
  if (summary !== undefined && typeof summary !== 'string') throw new Error('memory summary must be a string')
  // A caller that states no status keeps the legacy live default ('active').
  // The v3 entry gate (initialStatusFor → candidate / quarantined under the
  // confidence gate) is applied by the ingest layer before a new observation is
  // put(), not by this pure normalizer, so existing un-gated writers never
  // strand a record outside the WebUI's live list.
  const status = record.status ?? 'active'
  if (!RECORD_STATUSES.includes(/** @type {RecordStatus} */ (status))) {
    throw new Error(`memory status must be one of ${RECORD_STATUSES.join(', ')}`)
  }
  const source = record.source ?? 'agent'
  if (!MEMORY_SOURCES.includes(/** @type {MemorySource} */ (source))) {
    throw new Error(`memory source must be one of ${MEMORY_SOURCES.join(', ')}`)
  }
  const metadata = record.metadata
  if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw new Error('memory metadata must be a plain object')
  }
  const statusReason = record.statusReason
  if (statusReason !== undefined && typeof statusReason !== 'string') {
    throw new Error('memory statusReason must be a string')
  }
  const version = record.version === undefined ? 1 : record.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('memory version must be a positive integer')
  }
  /** @type {MemoryRecord} */
  const normalized = {
    id,
    scope,
    kind,
    ...record.projectId !== undefined ? { projectId: String(record.projectId) } : {},
    ...record.sessionId !== undefined ? { sessionId: String(record.sessionId) } : {},
    content,
    ...summary !== undefined ? { summary } : {},
    ...metadata !== undefined ? { metadata } : {},
    importance: clampUnit(record.importance, 0.5),
    confidence: clampUnit(record.confidence, 0.5),
    status,
    ...statusReason !== undefined ? { statusReason } : {},
    source,
    sourceIds: Array.isArray(record.sourceIds)
      ? record.sourceIds.filter((s) => typeof s === 'string')
      : [],
    tags: Array.isArray(record.tags)
      ? record.tags.filter((t) => typeof t === 'string')
      : [],
    createdAt: typeof record.createdAt === 'number' && Number.isSafeInteger(record.createdAt)
      ? record.createdAt
      : Date.now(),
    updatedAt: typeof record.updatedAt === 'number' && Number.isSafeInteger(record.updatedAt)
      ? record.updatedAt
      : Date.now(),
    userEdited: record.userEdited === true,
    version,
  }
  return Object.freeze(normalized)
}

/**
 * Initial status decision for a new observation (state machine gate):
 * low-confidence observations go to `quarantined`; everything else starts as
 * `candidate`. Nothing is allowed to enter directly as `active`.
 * @param {number} confidence - clamped [0,1] confidence of the observation.
 * @param {MemorySource} source - provenance of the observation.
 * @returns {RecordStatus}
 */
export function initialStatusFor(confidence, source) {
  const level = clampUnit(confidence, 0)
  if (level < CONFIDENCE_GATE && source !== 'user') return 'quarantined'
  return DEFAULT_INITIAL_STATUS
}

/**
 * Allowed forward/backward transitions of the data model v3 state machine.
 * Live statuses may transition to any live status (promote/demote via confirm/
 * reject); any live status may be archived/superseded; archived may be restored
 * back to its pre-archival status via the explicit restore path.
 * @param {RecordStatus} from
 * @param {RecordStatus} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true
  if (from === 'archived') return to === 'active' || to === 'candidate' || to === 'verified'
  if (to === 'archived' || to === 'superseded') return true
  return LIVE_STATUSES.includes(from) && LIVE_STATUSES.includes(to)
}

/**
 * Resolve a semantic status-change action into a target status.
 * @param {string} action - e.g. 'confirm' | 'reject' | 'archive' | 'restore'.
 * @param {RecordStatus} from - current status.
 * @returns {RecordStatus}
 */
export function statusForAction(action, from) {
  switch (action) {
    case 'confirm':
      return from === 'candidate' || from === 'quarantined' ? 'verified' : 'active'
    case 'reject':
      return 'quarantined'
    case 'archive':
      return 'archived'
    case 'restore':
      return from === 'archived' ? 'active' : from
    case 'soft-delete':
      return 'archived'
    default:
      return from
  }
}

/**
 * Validate an evidence object attached to a memory.
 * @param {unknown} input - candidate evidence.
 * @param {string} memoryId - owning record id.
 * @returns {MemoryEvidence}
 */
export function normalizeMemoryEvidence(input, memoryId) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('memory evidence must be a plain object')
  }
  const ev = /** @type {Record<string, unknown>} */ (input)
  if (!EVIDENCE_KINDS.includes(/** @type {MemoryEvidence['kind']} */ (ev.kind))) {
    throw new Error(`evidence kind must be one of ${EVIDENCE_KINDS.join(', ')}`)
  }
  if (typeof ev.quote !== 'string' || ev.quote.length === 0) {
    throw new Error('evidence quote must be a non-empty string')
  }
  const summary = ev.summary
  if (summary !== undefined && typeof summary !== 'string') throw new Error('evidence summary must be a string')
  const sourceType = ev.sourceType
  if (sourceType !== undefined && typeof sourceType !== 'string') throw new Error('evidence sourceType must be a string')
  /** @type {MemoryEvidence} */
  const evidence = {
    id: typeof ev.id === 'string' && ev.id.length > 0 ? ev.id : `ev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    memoryId,
    kind: ev.kind,
    quote: ev.quote,
    ...summary !== undefined ? { summary } : {},
    ...sourceType !== undefined ? { sourceType } : {},
    ref: ev.ref !== null && typeof ev.ref === 'object' && !Array.isArray(ev.ref)
      ? {
        ...ev.ref.sessionId !== undefined ? { sessionId: String(ev.ref.sessionId) } : {},
        ...ev.ref.eventSeq !== undefined ? { eventSeq: Number(ev.ref.eventSeq) } : {},
        ...ev.ref.toolCallId !== undefined ? { toolCallId: String(ev.ref.toolCallId) } : {},
        ...ev.ref.path !== undefined ? { path: String(ev.ref.path) } : {},
      }
      : {},
    observedAt: typeof ev.observedAt === 'number' && Number.isSafeInteger(ev.observedAt)
      ? ev.observedAt
      : Date.now(),
  }
  return Object.freeze(evidence)
}

/**
 * Build a synthetic id from a stable prefix (no crypto dependency needed).
 * @param {string} prefix - short stable prefix.
 * @param {string} entropy - caller-provided entropy seed.
 * @returns {string}
 */
export function makeId(prefix, entropy) {
  let hash = 2166136261
  const seed = `${prefix}:${entropy}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`
}
