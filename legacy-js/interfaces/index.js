// dsh-memory-personal — Storage Abstraction (data model v3) entry point.
//
// Declared seams: MemoryStore (wired today by the SQLite repository),
// VectorStore / EmbeddingProvider / RerankerProvider (contracts only — no
// provider is shipped or enabled yet). Importing these modules has no side
// effects beyond the frozen manifests, so future provider plugins and tests
// share one vocabulary for what a storage implementation must provide.

export { MemoryStore, isMemoryStore } from './memory-store.js'
export { VectorStore, isVectorStore } from './vector-store.js'
export { EmbeddingProvider, isEmbeddingProvider } from './embedding-provider.js'
export { RerankerProvider, isRerankerProvider } from './reranker-provider.js'
