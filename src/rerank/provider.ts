/**
 * Reranker（R4）。
 *
 * RerankCandidate 是携带多源评分的候选（row + keyword/vector/fused 分数），
 * Reranker 产出按最终分降序的 RankedMemory（score=综合分）。
 *
 * DefaultReranker 为确定性多因子排序（非 LLM）：
 *   score = wRel·rel + wImp·importance + wConf·confidence
 *         + wFresh·recency + wUtil·utility
 * rel 取 fused（融合分；反映关键词+向量相关度）；importance 映射见下；
 * recency 用 exp(-ageDays/halfLife)。权重可由 RerankConfig 覆盖。
 */

import type { MemoryItemRow } from "../store/repository.js";
import type { Importance } from "../schema/enums.js";
import type { RankedMemory } from "../retrieval/types.js";

const IMPORTANCE_VALUE: Record<Importance, number> = {
  critical: 1,
  high: 0.85,
  normal: 0.6,
  low: 0.4,
  disposable: 0.2,
};

const UTILITY_BY_TYPE: Record<string, number> = {
  experience: 0.9,
  generalized: 0.8,
  project_knowledge: 0.8,
  personal: 0.6,
  negative: 0.5,
};

export interface RerankCandidate {
  row: MemoryItemRow;
  /** 关键词源得分（R3 combineScore，∈[0,1]）；无关键词命中时缺省 */
  keywordScore?: number;
  /** 向量源相似度（∈[0,1]）；无向量命中时缺省 */
  vectorScore?: number;
  /** 融合分（fusion 已产出时使用） */
  fusedScore?: number;
}

export interface RerankConfig {
  weightRelevance?: number;
  weightImportance?: number;
  weightConfidence?: number;
  weightRecency?: number;
  weightUtility?: number;
  /** 新鲜度半衰期（天） */
  recencyHalfLifeDays?: number;
}

export interface RerankOptions {
  /** 基准时间（测试注入）；缺省取当前时间 */
  now?: number;
}

export interface RerankerProvider {
  readonly id: string;
  rerank(candidates: RerankCandidate[], opts?: RerankOptions): RankedMemory[];
}

export class DefaultReranker implements RerankerProvider {
  readonly id = "default-multifactor";
  private readonly config: Required<RerankConfig>;

  constructor(config: RerankConfig = {}) {
    this.config = {
      weightRelevance: config.weightRelevance ?? 0.5,
      weightImportance: config.weightImportance ?? 0.2,
      weightConfidence: config.weightConfidence ?? 0.15,
      weightRecency: config.weightRecency ?? 0.1,
      weightUtility: config.weightUtility ?? 0.05,
      recencyHalfLifeDays: config.recencyHalfLifeDays ?? 30,
    };
  }

  rerank(candidates: RerankCandidate[], opts: RerankOptions = {}): RankedMemory[] {
    const now = opts.now ?? Date.now();
    const w = this.config;
    const scored: RankedMemory[] = candidates.map((c) => {
      const row = c.row;
      const ageDays =
        (now - Date.parse(row.createdAt)) / (24 * 60 * 60 * 1000);
      const recency =
        Number.isFinite(ageDays) && ageDays >= 0
          ? Math.exp(-ageDays / w.recencyHalfLifeDays)
          : 0.5;
      const importance = IMPORTANCE_VALUE[row.importance] ?? 0.5;
      const utility = UTILITY_BY_TYPE[row.type] ?? 0.5;
      const confidence = Math.max(0, Math.min(1, row.confidence));
      const rel = c.fusedScore ?? c.vectorScore ?? c.keywordScore ?? 0;
      const score =
        w.weightRelevance * rel +
        w.weightImportance * importance +
        w.weightConfidence * confidence +
        w.weightRecency * recency +
        w.weightUtility * utility;
      return { row, score };
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}
