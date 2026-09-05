/**
 * Hybrid Retrieval 编排（R4）：
 *
 *   Gate → Planner → Understanding/Expansion
 *      ├─ Keyword/FTS5（R3 同款 searchKeyword）
 *      └─ Vector（embedding → sqlite-vec MATCH k，metadata 过滤同关键词语义）
 *   → Candidate Fusion（weighted | rrf）
 *   → Reranker（默认多因子）→ Selector → Guard → Related Expansion → Context
 *
 * 透明降级：向量链路不可用或失败时回退关键词路径（R3 语义不变），
 * telemetry.hybrid.mode='keyword-only' 并附 fallback.reason。
 */

import type { EmbeddingProvider } from "../embedding/provider.js";
import type { RerankerProvider } from "../rerank/provider.js";
import { getMemoryItemById, type MemoryItemRow } from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import type { VectorStore } from "../vector/types.js";
import { chooseBudget, type BudgetProfileName } from "./budget.js";
import { LruEmbeddingCache, type EmbeddingCache } from "./cache.js";
import { assemble } from "./context.js";
import { expandRelated } from "./expansion.js";
import { fuse, type FusionStrategy } from "./fusion.js";
import { gate } from "./gate.js";
import { guard } from "./guard.js";
import type {
  HybridMode,
  HybridRetrievalResult,
  HybridTelemetry,
} from "./hybrid-types.js";
import { searchKeyword } from "./keyword.js";
import { plan } from "./planner.js";
import { estimateTokens } from "./selector.js";
import type { MetadataFilter, RetrievalContext } from "./types.js";
import {
  buildTermGroups,
  expandTerms,
  normalizeQuery,
} from "./understanding.js";

export interface HybridRuntime {
  /** null 表示不启用向量（关键词模式） */
  embedding: EmbeddingProvider | null;
  vectorStore: VectorStore | null;
  reranker: RerankerProvider | null;
  /** 缺省创建进程内 LRU 缓存 */
  cache?: EmbeddingCache | null;
}

export interface HybridRetrievalRequest {
  query: string;
  filter?: MetadataFilter;
  limit?: number;
  /** 显式预算档（缺省按查询特征自动选择） */
  profile?: BudgetProfileName;
  fusionStrategy?: FusionStrategy;
}

/** metadata 过滤（与 R3 searchKeyword 的 WHERE 语义一致）。 */
function matchesMetadata(row: MemoryItemRow, filter?: MetadataFilter): boolean {
  if (filter === undefined) return true;
  if (filter.scope != null && row.scope !== filter.scope) return false;
  if (filter.projectId != null && row.projectId !== filter.projectId) return false;
  if (filter.type != null && row.type !== filter.type) return false;
  if (filter.temporalState != null && row.temporalState !== filter.temporalState) return false;
  if (filter.experiencePhase != null && row.experiencePhase !== filter.experiencePhase) return false;
  if (filter.importance != null && row.importance !== filter.importance) return false;
  if (filter.minConfidence != null && row.confidence < filter.minConfidence) return false;
  if (filter.includeHistorical !== true && row.temporalState === "historical") return false;
  return true;
}

/** 估算最终上下文 token（与 R3 estimateContextTokens 同口径）。 */
function estimateContextTokens(context: RetrievalContext): number {
  const layers = [
    context.profile,
    context.projectState,
    context.experience,
    context.negative,
    context.knowledge,
    context.historical,
  ];
  return layers.flat().reduce((sum, m) => sum + estimateTokens(m.row.content), 0);
}

/** 执行完整 Hybrid 检索链（异步：embedding 可为远程模型）。 */
export async function retrieveHybrid(
  db: SqlDatabase,
  request: HybridRetrievalRequest,
  runtime: HybridRuntime,
): Promise<HybridRetrievalResult> {
  const start = Date.now();
  const gateResult = gate(request.query);
  const queryPlan = plan(request.query);
  const normalized = normalizeQuery(request.query);
  const queryTerms = expandTerms(normalized, queryPlan.expandQuery);
  const termGroups = buildTermGroups(normalized, queryPlan.expandQuery);
  const filter = request.filter;
  const fusionStrategy = request.fusionStrategy ?? "weighted";

  const embedding = runtime.embedding;
  const store = runtime.vectorStore;
  const reranker = runtime.reranker;
  const cache = runtime.cache ?? new LruEmbeddingCache();
  const budget = chooseBudget(queryPlan, queryTerms, request.profile);

  // 向量可用性快照
  const vectorEnabled = embedding !== null && store !== null;
  const vectorStats: HybridTelemetry["vector"] = {
    enabled: vectorEnabled,
    available: false,
    storeCount: 0,
    candidateCount: 0,
    depth: budget.vectorDepth,
    latencyMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  let vecAvail = false;
  if (vectorEnabled) {
    const eh = embedding!.health();
    const sh = store!.health();
    vecAvail = eh.available && sh.available;
    vectorStats.engine = sh.engine;
    vectorStats.modelId = sh.modelId ?? eh.modelId;
    vectorStats.dimension = sh.dimension ?? eh.dimension;
    vectorStats.storeCount = sh.available ? sh.count : 0;
    if (!vecAvail) {
      const parts: string[] = [];
      if (!eh.available && eh.reason !== undefined) parts.push(`embedding: ${eh.reason}`);
      if (!sh.available && sh.reason !== undefined) parts.push(`store: ${sh.reason}`);
      vectorStats.reason = parts.join("; ");
    }
  }

  const keywordStats: HybridTelemetry["keyword"] = {
    enabled: true,
    depth: budget.keywordDepth,
    candidateCount: 0,
  };
  const fusionStats: HybridTelemetry["fusion"] = {
    strategy: fusionStrategy,
    poolSize: 0,
    keywordOnly: 0,
    vectorOnly: 0,
    both: 0,
  };
  const rerankStats: HybridTelemetry["rerank"] = {
    enabled: false,
    depth: 0,
    count: 0,
  };

  const retrieveOn = gateResult.shouldRetrieve && queryPlan.shouldRetrieve;
  let context: RetrievalContext;
  let poolSize = 0;
  let selectedCount = 0;
  let relatedCount = 0;
  let mode: HybridMode = "keyword-only";
  let fallbackReason: string | undefined;

  if (retrieveOn) {
    const kw = searchKeyword(db, termGroups, filter, budget.keywordDepth);
    keywordStats.candidateCount = kw.length;

    let vec: Array<{ row: MemoryItemRow; score: number }> = [];
    if (vecAvail && budget.vectorDepth > 0) {
      const vecStart = Date.now();
      try {
        const embedText = queryTerms.length > 0 ? queryTerms.join(" ") : request.query;
        let v = cache.get(embedText, embedding!.modelId, embedding!.dimension);
        if (v === undefined) {
          v = await embedding!.embedText(embedText);
          cache.set(embedText, embedding!.modelId, embedding!.dimension, v);
          vectorStats.cacheMisses += 1;
        } else {
          vectorStats.cacheHits += 1;
        }
        const hits = store!.search(v, budget.vectorDepth);
        const seen = new Set<string>();
        for (const hit of hits) {
          if (seen.has(hit.memoryId)) continue;
          seen.add(hit.memoryId);
          const row = getMemoryItemById(db, hit.memoryId);
          if (row === null || !matchesMetadata(row, filter)) continue;
          vec.push({ row, score: hit.similarity });
        }
        vectorStats.candidateCount = vec.length;
      } catch (err) {
        vectorStats.reason = (err as Error).message;
        vecAvail = false;
      }
      vectorStats.latencyMs = Date.now() - vecStart;
    }

    const pool = fuse(kw, vec, fusionStrategy);
    poolSize = pool.length;
    const kwHit = kw.length > 0;
    const vecHit = pool.some((c) => c.sources.includes("vector"));
    if (vecHit && kwHit) mode = "hybrid";
    else if (vecHit) mode = "vector-only";
    else mode = "keyword-only";

    fusionStats.poolSize = poolSize;
    fusionStats.keywordOnly = pool.filter(
      (c) => c.sources.length === 1 && c.sources[0] === "keyword",
    ).length;
    fusionStats.vectorOnly = pool.filter(
      (c) => c.sources.length === 1 && c.sources[0] === "vector",
    ).length;
    fusionStats.both = pool.filter((c) => c.sources.length === 2).length;

    if (mode === "keyword-only" && vectorEnabled && !vecAvail && kwHit) {
      fallbackReason = `vector unavailable: ${vectorStats.reason ?? "unknown"}`;
    }

    // Rerank 仅用于非关键词回退路径（回退保持 R3 顺序）。
    const rerankEnabled =
      reranker !== null && mode !== "keyword-only" && pool.length > 0 && budget.rerankDepth > 0;
    let ordered: Array<{ row: MemoryItemRow; score: number }>;
    if (rerankEnabled) {
      const top = pool.slice(0, budget.rerankDepth);
      rerankStats.engine = reranker!.id;
      rerankStats.depth = top.length;
      const reranked = reranker!.rerank(
        top.map((c) => ({
          row: c.row,
          keywordScore: c.keywordScore,
          vectorScore: c.vectorScore,
          fusedScore: c.score,
        })),
      );
      rerankStats.count = reranked.length;
      ordered = reranked;
    } else {
      ordered = pool;
    }

    const guarded = ordered.filter(
      (m) =>
        guard(m, {
          projectId: filter?.projectId,
          minConfidence: filter?.minConfidence,
        }).allowed,
    );
    selectedCount = guarded.length;
    let final = guarded;
    if (queryPlan.expandRelated) {
      const extra = expandRelated(db, guarded, 1, 5);
      relatedCount = extra.length;
      final = [...guarded, ...extra];
    }
    context = assemble(final, poolSize, selectedCount);
  } else {
    context = assemble([], 0, 0);
  }

  vectorStats.available = vecAvail;
  const hybrid: HybridTelemetry = {
    mode,
    keyword: keywordStats,
    vector: vectorStats,
    fusion: fusionStats,
    rerank: rerankStats,
    budget: {
      name: budget.name,
      selectTokens: budget.selectTokens,
      vectorDepth: budget.vectorDepth,
      rerankDepth: budget.rerankDepth,
    },
    ...(fallbackReason !== undefined ? { fallback: { reason: fallbackReason } } : {}),
  };

  const telemetry: HybridRetrievalResult["telemetry"] = {
    query: request.query,
    gate: gateResult,
    plan: queryPlan,
    queryTerms,
    candidateCount: poolSize,
    selectedCount,
    relatedCount,
    latencyMs: Date.now() - start,
    estimatedTokens: estimateContextTokens(context),
    hybrid,
  };
  return { context, telemetry };
}
