/**
 * R3 关键词检索链的公共类型。
 * 保持稳定的分层 Context 结构与 telemetry，供 R4/R6 扩展（向量/成本）。
 */

import type { BudgetDecisionView } from "../cost/budget.js";
import type {
  ExperiencePhase,
  Importance,
  MemoryScope,
  MemoryType,
  TemporalState,
} from "../schema/enums.js";
import type { MemoryItemRow } from "../store/repository.js";

export type QueryKind =
  | "simple"
  | "project"
  | "historical"
  | "error"
  | "knowledge";

export interface QueryPlan {
  kind: QueryKind;
  shouldRetrieve: boolean;
  candidateLimit: number;
  expandQuery: boolean;
  expandRelated: boolean;
}

export interface GateResult {
  shouldRetrieve: boolean;
  reason: string;
}

export interface MetadataFilter {
  scope?: MemoryScope;
  projectId?: string;
  type?: MemoryType;
  temporalState?: TemporalState;
  experiencePhase?: ExperiencePhase;
  importance?: Importance;
  minConfidence?: number;
  /** 是否包含已归档（historical）记忆；默认 false */
  includeHistorical?: boolean;
}

export interface RetrievalRequest {
  query: string;
  filter?: MetadataFilter;
  limit?: number;
}

/** 归一化相关度后的候选记忆（score ∈ [0,1]，越高越相关）。 */
export interface RankedMemory {
  row: MemoryItemRow;
  score: number;
}

/** 分层检索上下文（部分层本轮可空，结构稳定）。 */
export interface RetrievalContext {
  profile: RankedMemory[];
  projectState: RankedMemory[];
  experience: RankedMemory[];
  negative: RankedMemory[];
  knowledge: RankedMemory[];
  historical: RankedMemory[];
  trust: {
    totalCandidates: number;
    selected: number;
    generatedAt: string;
  };
}

export interface RetrievalTelemetry {
  query: string;
  gate: GateResult;
  plan: QueryPlan;
  queryTerms: string[];
  candidateCount: number;
  selectedCount: number;
  relatedCount: number;
  latencyMs: number;
  estimatedTokens: number;
  /** R6 Cost/Budget：检索预算决策（请求启用预算记录时附着；否则 undefined）。 */
  budget?: BudgetDecisionView;
}

export interface RetrievalResult {
  context: RetrievalContext;
  telemetry: RetrievalTelemetry;
}
