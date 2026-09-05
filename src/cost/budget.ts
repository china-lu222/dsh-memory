import type { SqlDatabase } from "../store/sqlite.js";
import { writeTelemetry } from "../store/telemetry.js";

export type BudgetLevel = "low" | "normal" | "high" | "diagnostic";
export type RetrievalProfile = "economy" | "standard" | "thorough";
export type TaskKind = "query" | "diagnosis" | "planning" | "chat";
export type DiagnosticImpact = "none" | "low" | "medium" | "high";

export interface BudgetFeatures {
  taskKind: TaskKind;
  confidence?: number;
  scoreMargin?: number;
  candidateCount?: number;
  cacheHit?: boolean;
  diagnosticImpact?: DiagnosticImpact;
  /** 简单/低价值请求：低成本档位（Q057）。 */
  simple?: boolean;
}

export interface BudgetPlan {
  level: BudgetLevel;
  profile: RetrievalProfile;
  keywordDepth: number;
  vectorDepth: number;
  rerank: boolean;
  contextHint: "compact" | "standard" | "generous" | "diagnostic";
  allowExtraTools: boolean;
  allowModelCall: boolean;
  reason: string[];
}

/** 动态预算：诊断/高不确定性升级；简单/高置信 + cache hit 压缩（Q094/Q095）。 */
export function planBudget(f: BudgetFeatures): BudgetPlan {
  const confidence = f.confidence ?? 0.5;
  const margin = f.scoreMargin ?? 0.2;
  const candidates = f.candidateCount ?? 0;
  const impact = f.diagnosticImpact ?? "none";

  if (f.taskKind === "diagnosis" || impact === "high") {
    return tier("diagnostic", [
      "diagnosis task",
      impact === "high" ? "high diagnostic impact" : undefined,
    ]);
  }
  if (f.taskKind === "planning" || candidates >= 30 || confidence < 0.5 || margin < 0.15) {
    return tier("high", [
      f.taskKind === "planning" ? "planning task" : undefined,
      candidates >= 30 ? `candidates=${candidates}` : undefined,
      confidence < 0.5 ? "low confidence" : undefined,
      margin < 0.15 ? "thin margin" : undefined,
    ]);
  }
  if ((f.simple === true && (f.cacheHit === true || confidence >= 0.85)) ||
      (f.cacheHit === true && confidence >= 0.8 && margin >= 0.25)) {
    return tier("low", [
      "simple query",
      f.cacheHit === true ? "cache hit" : undefined,
      confidence >= 0.8 ? "high confidence" : undefined,
      margin >= 0.2 ? "wide margin" : undefined,
    ]);
  }
  return tier("normal", ["default"]);
}

function tier(level: BudgetLevel, hints: Array<string | undefined>): BudgetPlan {
  const reason = hints.filter((h): h is string => h !== undefined);
  switch (level) {
    case "diagnostic":
      return {
        level,
        profile: "thorough",
        keywordDepth: 3,
        vectorDepth: 3,
        rerank: true,
        contextHint: "diagnostic",
        allowExtraTools: true,
        allowModelCall: true,
        reason,
      };
    case "high":
      return {
        level,
        profile: "thorough",
        keywordDepth: 3,
        vectorDepth: 2,
        rerank: true,
        contextHint: "generous",
        allowExtraTools: reason.includes("planning task"),
        allowModelCall: false,
        reason,
      };
    case "low":
      return {
        level,
        profile: "economy",
        keywordDepth: 1,
        vectorDepth: 1,
        rerank: false,
        contextHint: "compact",
        allowExtraTools: false,
        allowModelCall: false,
        reason,
      };
    case "normal":
      return {
        level,
        profile: "standard",
        keywordDepth: 2,
        vectorDepth: 2,
        rerank: true,
        contextHint: "standard",
        allowExtraTools: false,
        allowModelCall: false,
        reason,
      };
  }
}

/**
 * 单次检索的预算决策视图（附着在检索 telemetry 上）。
 * `enabled: false` 是“预算记录未启用”的显式标记（NOT ENABLED），禁止缺省缺席。
 */
export interface BudgetDecisionView {
  enabled: boolean;
  level: BudgetLevel;
  profile: RetrievalProfile;
  /** 本轮检索实际采用的上下文预算（token，selector 截断口径）。 */
  contextBudgetTokens: number;
  /** 最终上下文估算 token。 */
  estimateTokens: number;
  contextHint: "compact" | "standard" | "generous" | "diagnostic";
  reason: string[];
  cacheHit: boolean;
}

/** 记录预算决策到遥测（“有证据表明预算真的改变了”）。 */
export function recordBudgetDecision(
  db: SqlDatabase,
  features: BudgetFeatures,
  plan: BudgetPlan,
  actor = "system",
): string {
  return writeTelemetry(db, {
    kind: "budget",
    key: `budget.${plan.level}`,
    value: { features, plan },
    actor,
  });
}

export function mapLevelToProfile(level: BudgetLevel): RetrievalProfile {
  return planBudget({
    taskKind: level === "diagnostic"
      ? "diagnosis"
      : level === "high"
        ? "planning"
        : "query",
  }).profile;
}
