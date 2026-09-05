/**
 * Planner（R3 规则版）：按查询文本判定查询类型并给出检索计划。
 * 决定候选数量 / 是否扩展查询 / 是否做 related expansion。
 * 后续可用 LLM 替换，但接口保持稳定。
 */

import type { QueryKind, QueryPlan } from "./types.js";

const ERROR_RE = /(error|报错|失败|bug|异常|错误|解决|修复|debug|排查|崩溃|exception|crash|fix)/i;
const HISTORICAL_RE = /(之前|上次|以前|记得|历史|曾经|过去|previously|remember|before|last\s*time|上次|上次怎么)/i;
const PROJECT_RE = /(项目|工程|仓库|project|当前项目|这个项目|代码库|repo|架构|依赖)/i;

/** 规则式规划：判断查询类型与检索策略。 */
export function plan(query: string): QueryPlan {
  const q = query.trim();
  if (q.length < 2) {
    return {
      kind: "simple",
      shouldRetrieve: false,
      candidateLimit: 0,
      expandQuery: false,
      expandRelated: false,
    };
  }
  if (ERROR_RE.test(q)) {
    return {
      kind: "error",
      shouldRetrieve: true,
      candidateLimit: 12,
      expandQuery: true,
      expandRelated: true,
    };
  }
  if (HISTORICAL_RE.test(q)) {
    return {
      kind: "historical",
      shouldRetrieve: true,
      candidateLimit: 10,
      expandQuery: true,
      expandRelated: true,
    };
  }
  if (PROJECT_RE.test(q)) {
    return {
      kind: "project",
      shouldRetrieve: true,
      candidateLimit: 8,
      expandQuery: false,
      expandRelated: true,
    };
  }
  return {
    kind: "knowledge",
    shouldRetrieve: true,
    candidateLimit: 8,
    expandQuery: false,
    expandRelated: false,
  };
}

/** 供 telemetry 使用的 plan 副本。 */
export function describePlan(p: QueryPlan): QueryKind {
  return p.kind;
}
