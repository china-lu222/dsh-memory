// dsh-memory-personal — Vector Store interface (data model v3, §semantic
// retrieval). Declared but NOT enabled: no provider is wired or shipped yet.
// The seam exists so a future Phase (embedding + nearest-neighbour recall)
// plugs into `retrieve()` without touching the memory lifecycle.

/**
 * A scored nearest-neighbour hit returned by a VectorStore query.
 * @typedef {{
 *   id: string,
 *   score: number,
 *   metadata?: Record<string, any>,
 * }} VectorHit
 */

/**
 * VectorStore — dense-index persistence over memory embeddings.
 *
 * Embeddings are owned by an EmbeddingProvider and stored here keyed by the
 * memory id; a store must stay consistent with the MemoryStore lifecycle
 * (vectors are removed when their memory is deleted/superseded).
 * @typedef {{
 *   upsert(id: string, vector: number[], metadata?: Record<string, any>): void,
 *   remove(id: string): boolean,
 *   query(vector: number[], opts?: { topK?: number, filter?: (metadata: Record<string, any>) => boolean }): VectorHit[],
 *   contains(id: string): boolean,
 *   clear(): void,
 * }} VectorStore
 */

/** Interface manifest for {@link VectorStore}. */
export const VectorStore = Object.freeze({
  name: 'VectorStore',
  description: 'dense nearest-neighbour index keyed by memory id (not enabled)',
  methods: Object.freeze(['upsert', 'remove', 'query', 'contains', 'clear']),
})

/**
 * Structural check: does `impl` expose every VectorStore method?
 * @param {unknown} impl - candidate implementation.
 * @returns {boolean} true when every required method is callable.
 */
export function isVectorStore(impl) {
  return impl !== null && typeof impl === 'object'
    && VectorStore.methods.every((m) => typeof impl[m] === 'function')
}
