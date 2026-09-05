/**
 * Retrieval Budget（R4）：按查询特征动态决定 token/向量深度预算。
 *
 * 关键词基础深度 = QueryPlan.candidateLimit（与 R3 一致），profile 只加宽
 * 向量层与 rerank 层的搜索深度与最终 token 预算 —— 因此向量不可用而回退
 * 关键词时行为与 R3 完全一致。
 */

import type { QueryPlan } from "./types.js";

export type BudgetProfileName = "economy" | "standard" | "thorough";

export interface BudgetProfile {
  name: BudgetProfileName;
  /** 关键词检索深度（恒取 plan.candidateLimit，保持 R3 基线） */
  keywordDepth: number;
  /** 向量候选深度（MATCH k） */
  vectorDepth: number;
  /** 进入 reranker 的候选上限 */
  rerankDepth: number;
  /** Selector token 预算 */
  selectTokens: number;
}

const PROFILES: Record<BudgetProfileName, Omit<BudgetProfile, "keywordDepth">> = {
  economy: { name: "economy", vectorDepth: 24, rerankDepth: 12, selectTokens: 1200 },
  standard: { name: "standard", vectorDepth: 64, rerankDepth: 32, selectTokens: 2000 },
  thorough: { name: "thorough", vectorDepth: 160, rerankDepth: 64, selectTokens: 3000 },
};

/** 按命名取 profile（关键词深度始终绑定 plan）。 */
export function budgetByName(
  name: BudgetProfileName,
  plan: QueryPlan,
): BudgetProfile {
  const base = PROFILES[name];
  return { ...base, keywordDepth: plan.candidateLimit };
}

/** 自动选择：报错/长查询 → thorough；极短查询 → economy；其余 standard。 */
export function chooseBudget(
  plan: QueryPlan,
  queryTerms: readonly string[],
  explicit?: BudgetProfileName,
): BudgetProfile {
  if (explicit !== undefined) return budgetByName(explicit, plan);
  if (plan.kind === "error" || queryTerms.length >= 6) {
    return budgetByName("thorough", plan);
  }
  if (queryTerms.length <= 1 && plan.kind !== "historical") {
    return budgetByName("economy", plan);
  }
  return budgetByName("standard", plan);
}
