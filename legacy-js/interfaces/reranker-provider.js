// dsh-memory-personal — Reranker Provider interface (data model v3,
// §semantic retrieval). Declared but NOT enabled: like the EmbeddingProvider
// this is an optional seam; without a provider the pipeline uses raw
// embedding scores or keyword ranking.

/**
 * RerankerProvider — re-scores an ordered list of candidates for one query.
 *
 * Candidates are opaque strings (memory content/summary) because a reranker
 * may be a remote model that never sees internal record ids; the caller maps
 * the returned scores back to the original candidate order.
 * @typedef {{
 *   rerank(query: string, documents: string[], opts?: { topK?: number }): Promise<number[]>,
 * }} RerankerProvider
 */

/** Interface manifest for {@link RerankerProvider}. */
export const RerankerProvider = Object.freeze({
  name: 'RerankerProvider',
  description: 're-scores candidate documents for a query (not enabled)',
  methods: Object.freeze(['rerank']),
})

/**
 * Structural check: does `impl` expose every RerankerProvider method?
 * @param {unknown} impl - candidate implementation.
 * @returns {boolean} true when every required method is callable.
 */
export function isRerankerProvider(impl) {
  return impl !== null && typeof impl === 'object'
    && RerankerProvider.methods.every((m) => typeof impl[m] === 'function')
}
