/**
 * Hybrid Retrieval 结果类型（R4）。
 * 与 R3 RetrievalResult 同构（context/telemetry 主字段不变），仅在 telemetry
 * 上附加 hybrid 块，保证上层展示与后续 Compressor 兼容。
 */

import type { FusionStrategy } from "./fusion.js";
import type { RetrievalResult } from "./types.js";

export type HybridMode = "keyword-only" | "vector-only" | "hybrid";

export interface HybridKeywordStats {
  /** 本路是否启用 */
  enabled: boolean;
  /** 关键词命中数（FTS5+filter 后） */
  candidateCount: number;
  /** 检索深度 */
  depth: number;
}

export interface HybridVectorStats {
  /** 配置层是否启用向量（embedding+store 均注入） */
  enabled: boolean;
  /** 运行时是否实际可用（embedding/store health） */
  available: boolean;
  engine?: string;
  modelId?: string;
  dimension?: number;
  /** 索引中记忆数 */
  storeCount: number;
  /** 向量命中（metadata filter 后） */
  candidateCount: number;
  depth: number;
  /** embedding + 检索耗时（ms） */
  latencyMs: number;
  cacheHits: number;
  cacheMisses: number;
  /** 不可用/失败原因（fallback 时给出） */
  reason?: string;
}

export interface HybridFusionStats {
  strategy: FusionStrategy;
  /** 融合池规模（去重后） */
  poolSize: number;
  /** 仅关键词命中 */
  keywordOnly: number;
  /** 仅向量命中 */
  vectorOnly: number;
  /** 双源命中 */
  both: number;
}

export interface HybridRerankStats {
  enabled: boolean;
  engine?: string;
  /** 送入 reranker 的候选数 */
  depth: number;
  /** 实际 rerank 数 */
  count: number;
}

export interface HybridBudgetStats {
  name: string;
  selectTokens: number;
  vectorDepth: number;
  rerankDepth: number;
}

export interface HybridTelemetry {
  mode: HybridMode;
  keyword: HybridKeywordStats;
  vector: HybridVectorStats;
  fusion: HybridFusionStats;
  rerank: HybridRerankStats;
  budget: HybridBudgetStats;
  /** 向量链路失败/不可用时对关键词的透明回退 */
  fallback?: { reason: string };
}

export interface HybridRetrievalResult extends RetrievalResult {
  telemetry: RetrievalResult["telemetry"] & { hybrid: HybridTelemetry };
}
