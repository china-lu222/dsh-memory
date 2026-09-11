/**
 * Auto Long-Term Memory — Scope 解析与写入行装配（阶段 2）。
 *
 * 把评估后的候选装配为写入行：scope 归类、projectId 归属、source_kind 判定、
 * 确定性 memoryId（type+scope+content+projectId 哈希 → 幂等去重）。
 * 阶段 2 尚无会话上下文（host-adapter 未接入），scope 只落 project/global；
 * personal 与无 projectId 的项目知识一律 global。
 */

import type {
  EvaluatedAutoCandidate,
  GateIntent,
  LearnContext,
  ResolvedAutoCandidate,
} from "./types.js";
import { makeMemoryId } from "../store/repository.js";

/**
 * 装配写入行。
 * @param cand 评估后的候选
 * @param ctx 调用上下文（projectId/actor 归属）
 * @param intent gate 判定结果；remember 视为 explicit，否则 inferred
 */
export function resolveAutoCandidate(
  cand: EvaluatedAutoCandidate,
  ctx: LearnContext,
  intent: GateIntent,
): ResolvedAutoCandidate {
  const project = ctx.projectId !== null && cand.type !== "personal";
  const scope = project ? "project" : "global";
  const projectId = project ? ctx.projectId : null;
  const sourceKind = intent === "remember" ? "explicit" : "inferred";
  const memoryId = makeMemoryId(
    cand.type,
    scope,
    cand.content,
    projectId ?? undefined,
  );
  return { ...cand, scope, projectId, sourceKind, memoryId };
}

/** 批量装配。 */
export function resolveAutoCandidates(
  candidates: EvaluatedAutoCandidate[],
  ctx: LearnContext,
  intent: GateIntent,
): ResolvedAutoCandidate[] {
  return candidates.map((c) => resolveAutoCandidate(c, ctx, intent));
}
