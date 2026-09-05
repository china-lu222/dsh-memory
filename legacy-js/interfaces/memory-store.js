// dsh-memory-personal — Storage Abstraction (data model v3).
//
// The seam every upper layer (ingest, projection, HTTP, future retrieval) talks
// to. Today the concrete implementation is the SQLite MemoryRepository
// (lib/store/repository.js); declaring the contract here — even though no
// alternative store is wired yet — fixes the seam so a provider swap never
// ripples through the plugin and so tests can substitute an in-memory fake.

/**
 * MemoryStore — persistence for memories, their evidence and the audit trail.
 *
 * All methods are synchronous (node:sqlite DatabaseSync); an alternative
 * store must either stay synchronous or expose an adapter that is.
 * @typedef {{
 *   put(record: import('../model/types.js').MemoryRecord, opts?: { actor?: import('../model/types.js').MemorySource }): import('../model/types.js').MemoryRecord,
 *   get(id: string): import('../model/types.js').MemoryRecord | undefined,
 *   delete(id: string, opts?: { actor?: import('../model/types.js').MemorySource }): boolean,
 *   list(filters?: object): import('../model/types.js').MemoryRecord[],
 *   overview(): object,
 *   addEvidence(evidence: import('../model/types.js').MemoryEvidence): import('../model/types.js').MemoryEvidence,
 *   evidence(memoryId: string): import('../model/types.js').MemoryEvidence[],
 *   audit(memoryId: string): object[],
 *   recentAudit(limit?: number): object[],
 *   getMeta(key: string): string | undefined,
 *   setMeta(key: string, value: string): void,
 *   close(): void,
 * }} MemoryStore
 */

/** Interface manifest for {@link MemoryStore}. */
export const MemoryStore = Object.freeze({
  name: 'MemoryStore',
  description: 'synchronous persistence for memories, evidence and audit',
  methods: Object.freeze([
    'put', 'get', 'delete', 'list', 'overview',
    'addEvidence', 'evidence', 'audit', 'recentAudit',
    'getMeta', 'setMeta', 'close',
  ]),
})

/**
 * Structural check: does `impl` expose every MemoryStore method?
 * @param {unknown} impl - candidate implementation.
 * @returns {boolean} true when every required method is callable.
 */
export function isMemoryStore(impl) {
  return impl !== null && typeof impl === 'object'
    && MemoryStore.methods.every((m) => typeof impl[m] === 'function')
}
