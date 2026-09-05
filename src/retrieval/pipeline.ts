/**
 * 检索链编排（R3）：
 *   Query → Gate → Planner → Query Understanding/Expansion → Keyword(FTS5+filter)
 *   → Selector → Guard → Related Expansion → Context Assembly
 * 并产出 telemetry（候选数/选中数/延迟/预估 token），供 R4/R6 扩展。
 *
 * R6 Finalization 的可选运行时（RetrievalRuntime）：
 *  - `cache`：Context-aware Memory Cache。Query → cache lookup；miss 才执行真实
 *    检索链并 cache write（版本键含 memory.watermark/impl/embedding，见 cache/）。
 *  - `budget`：Cost/Budget 决策记录。真实检索后评估 planBudget 并写 telemetry
 *    `budget` 决策行（未提供时检索行为与 R3 完全一致，不产生额外遥测）。
 */

import type { MemoryCache } from "../cache/memory-cache.js";
import { makeMemoryCacheContext } from "../cache/memory-cache.js";
import {
  planBudget,
  recordBudgetDecision,
  type BudgetDecisionView,
  type TaskKind,
} from "../cost/budget.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { assemble } from "./context.js";
import { expandRelated } from "./expansion.js";
import { gate } from "./gate.js";
import { guard } from "./guard.js";
import { searchKeyword } from "./keyword.js";
import { plan } from "./planner.js";
import { select } from "./selector.js";
import type {
  RetrievalContext,
  RetrievalRequest,
  RetrievalResult,
  RetrievalTelemetry,
} from "./types.js";
import {
  buildTermGroups,
  expandTerms,
  normalizeQuery,
} from "./understanding.js";

const DEFAULT_BUDGET_TOKENS = 2000;
const RELATED_DEPTH = 1;
const RELATED_BUDGET = 5;

export interface RetrievalRuntime {
  /** 持久化检索缓存；提供时自动走 cache lookup → miss 后写回。 */
  cache?: MemoryCache;
  /** 缓存档位标签（仅键用途）。 */
  profile?: string;
  /** embedding 模型标识（keyword 检索无需；为键一致性保留）。 */
  embeddingModel?: string;
  /** 预算决策遥测（kind=budget）；缺省不启用（与 R3 行为一致）。 */
  budget?: { taskKind: TaskKind; actor?: string };
}

/** 单次检索结果 + 缓存命中标记。 */
export type RetrievedResult = RetrievalResult & { cacheHit: boolean };

/**
 * 执行关键词检索链（可带 R6 运行时）。
 * @returns 结果与 telemetry；`cacheHit` 表示本轮由缓存直接返回（未执行检索链）。
 */
export function retrieve(
  db: SqlDatabase,
  request: RetrievalRequest,
  runtime: RetrievalRuntime = {},
): RetrievedResult {
  if (runtime.cache !== undefined) {
    const ctx = makeMemoryCacheContext(request.query, request.filter, request.limit, {
      kind: "keyword",
      profile: runtime.profile,
      embeddingModel: runtime.embeddingModel,
    });
    const hit = runtime.cache.get(ctx);
    if (hit.hit) {
      const stored = hit.payload as RetrievalResult;
      return { ...stored, cacheHit: true };
    }
    const computed = runRetrieval(db, request);
    const decorated = decorateBudget(db, computed, request, runtime, false);
    runtime.cache.put(ctx, decorated);
    return decorated;
  }
  return decorateBudget(db, runRetrieval(db, request), request, runtime, false);
}

/** 实际执行检索链（无缓存、无预算的确定性核心）。 */
function runRetrieval(db: SqlDatabase, request: RetrievalRequest): RetrievalResult {
  const start = Date.now();
  const gateResult = gate(request.query);
  const queryPlan = plan(request.query);
  const normalized = normalizeQuery(request.query);
  const queryTerms = expandTerms(normalized, queryPlan.expandQuery);
  const termGroups = buildTermGroups(normalized, queryPlan.expandQuery);

  let context: RetrievalContext;
  let candidateCount = 0;
  let selectedCount = 0;
  let relatedCount = 0;

  if (gateResult.shouldRetrieve && queryPlan.shouldRetrieve) {
    const candidates = searchKeyword(
      db,
      termGroups,
      request.filter,
      queryPlan.candidateLimit,
    );
    candidateCount = candidates.length;
    const selected = select(candidates, DEFAULT_BUDGET_TOKENS);
    const guarded = selected.filter(
      (m) =>
        guard(m, {
          projectId: request.filter?.projectId,
          minConfidence: request.filter?.minConfidence,
        }).allowed,
    );
    selectedCount = guarded.length;
    let final = guarded;
    if (queryPlan.expandRelated) {
      const extra = expandRelated(db, guarded, RELATED_DEPTH, RELATED_BUDGET);
      relatedCount = extra.length;
      final = [...guarded, ...extra];
    }
    context = assemble(final, candidateCount, selectedCount);
  } else {
    context = assemble([], 0, 0);
  }

  const latencyMs = Date.now() - start;
  const telemetry: RetrievalTelemetry = {
    query: request.query,
    gate: gateResult,
    plan: queryPlan,
    queryTerms,
    candidateCount,
    selectedCount,
    relatedCount,
    latencyMs,
    estimatedTokens: estimateContextTokens(context),
  };
  return { context, telemetry };
}

/** 请求启用预算记录时：评估预算档并写 telemetry 决策行（命中缓存不重复记录）。 */
function decorateBudget(
  db: SqlDatabase,
  result: RetrievalResult,
  request: RetrievalRequest,
  runtime: RetrievalRuntime,
  cacheHit: boolean,
): RetrievedResult {
  if (runtime.budget === undefined) {
    return { ...result, cacheHit };
  }
  const plan = planBudget({
    taskKind: runtime.budget.taskKind,
    simple: isSimpleQuery(request.query),
    cacheHit,
    candidateCount: result.telemetry.candidateCount,
  });
  const features = {
    taskKind: runtime.budget.taskKind,
    simple: isSimpleQuery(request.query),
    cacheHit,
    candidateCount: result.telemetry.candidateCount,
  };
  recordBudgetDecision(db, features, plan, runtime.budget.actor);
  const budget: BudgetDecisionView = {
    enabled: true,
    level: plan.level,
    profile: plan.profile,
    contextBudgetTokens: DEFAULT_BUDGET_TOKENS,
    estimateTokens: result.telemetry.estimatedTokens,
    contextHint: plan.contextHint,
    reason: plan.reason,
    cacheHit,
  };
  return {
    ...result,
    cacheHit,
    telemetry: { ...result.telemetry, budget },
  };
}

/** 短查询启发（预算 simple 档用；不参与检索语义）。 */
function isSimpleQuery(query: string): boolean {
  const tokens = normalizeQuery(query).filter((t) => t.length > 0);
  return tokens.length <= 2 && tokens.join(" ").length <= 24;
}

/** 估算最终上下文 token 数。 */
function estimateContextTokens(context: RetrievalContext): number {
  const all = [
    ...context.profile,
    ...context.projectState,
    ...context.experience,
    ...context.negative,
    ...context.knowledge,
    ...context.historical,
  ];
  return all.reduce((sum, m) => {
    const cjk = (m.row.content.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    return sum + Math.ceil(cjk + (m.row.content.length - cjk) / 4);
  }, 0);
}
