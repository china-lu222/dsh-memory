// dsh-memory-personal — Embedding Provider interface (data model v3,
// §semantic retrieval). Declared but NOT enabled: providers (local model or
// hosted API) are chosen in a later Phase and reach the pipeline through the
// EmbeddingProvider seam, never through a hard-coded import.

/**
 * EmbeddingProvider — maps text to a fixed-dimension dense vector.
 *
 * A provider exposes its output `dimension` up front so the VectorStore can
 * validate inserts and the pipeline can decide whether embedding is available
 * at all (a host without a provider keeps semantic retrieval off and degrades
 * to keyword search).
 * @typedef {{
 *   embed(input: string): Promise<number[]>,
 *   embedMany(inputs: string[]): Promise<number[][]>,
 *   dimension: number,
 * }} EmbeddingProvider
 */

/** Interface manifest for {@link EmbeddingProvider}. */
export const EmbeddingProvider = Object.freeze({
  name: 'EmbeddingProvider',
  description: 'text → fixed-dimension dense vector (not enabled)',
  methods: Object.freeze(['embed', 'embedMany']),
})

/**
 * Structural check: does `impl` expose every EmbeddingProvider method and a
 * numeric `dimension`?
 * @param {unknown} impl - candidate implementation.
 * @returns {boolean} true when every required method is callable.
 */
export function isEmbeddingProvider(impl) {
  return impl !== null && typeof impl === 'object'
    && typeof impl.dimension === 'number'
    && EmbeddingProvider.methods.every((m) => typeof impl[m] === 'function')
}
