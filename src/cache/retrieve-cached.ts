/**
 * 检索 + Memory Cache 包装器（R6，Q059/Q092）。
 *
 * keyword：委托 `retrieval/pipeline.retrieve()`（缓存逻辑已在检索链内）；
 * hybrid：cache lookup → miss 执行 `retrieveHybrid` → put。
 * fingerprint 已含 memory.watermark 与 embedding 模型 → 记忆/模型变化自动失效。
 * 返回对象附带 `cacheHit`，供调用方计量与测试。
 */

import { MemoryCache, makeMemoryCacheContext } from "./memory-cache.js";
import { retrieve, type RetrievalRuntime } from "../retrieval/pipeline.js";
import type { RetrievalRequest, RetrievalResult } from "../retrieval/types.js";
import {
  retrieveHybrid,
  type HybridRetrievalRequest,
  type HybridRuntime,
} from "../retrieval/hybrid.js";
import type { HybridRetrievalResult } from "../retrieval/hybrid-types.js";
import type { SqlDatabase } from "../store/sqlite.js";
import type { TaskKind } from "../cost/budget.js";

export interface CacheOptions {
  /** 显式检索档位（keyword wrapper 仅做键用途；hybrid 会传给请求）。 */
  profile?: string;
  /** 嵌入模型标识（hybrid 命中 key 用）。 */
  embeddingModel?: string;
  /** 预算决策遥测（keyword 包装启用预算时透传给检索链）。 */
  budget?: { taskKind: TaskKind; actor?: string };
}

type CachedResult<T> = T & { cacheHit: boolean };

/** 关键词检索缓存包装（委托检索链内置缓存路径）。 */
export function cachedKeywordRetrieve(
  db: SqlDatabase,
  cache: MemoryCache,
  request: RetrievalRequest,
  options: CacheOptions = {},
): CachedResult<RetrievalResult> {
  const runtime: RetrievalRuntime = {
    cache,
    profile: options.profile,
    embeddingModel: options.embeddingModel,
    budget: options.budget,
  };
  return retrieve(db, request, runtime);
}

/** Hybrid 检索缓存包装。 */
export async function cachedHybridRetrieve(
  db: SqlDatabase,
  cache: MemoryCache,
  request: HybridRetrievalRequest,
  runtime: HybridRuntime,
  options: CacheOptions = {},
): Promise<CachedResult<HybridRetrievalResult>> {
  const cacheCtx = makeMemoryCacheContext(request.query, request.filter, request.limit, {
    kind: "hybrid",
    profile: options.profile ?? ("profile" in request ? request.profile : undefined),
    embeddingModel: options.embeddingModel,
    fusion: request.fusionStrategy ?? null,
  });
  const hit = cache.get(cacheCtx);
  if (hit.hit) {
    const result = hit.payload as HybridRetrievalResult;
    return { ...result, cacheHit: true };
  }
  const result = await retrieveHybrid(db, request, runtime);
  cache.put(cacheCtx, result);
  return { ...result, cacheHit: false };
}
