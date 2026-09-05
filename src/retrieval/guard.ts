/**
 * Memory Guard（R3）：最终注入前检查 temporal state / suppression / confidence /
 * scope ownership / 敏感信息，拒绝不适合注入 Context 的记忆。
 * Memory 是辅助上下文，不是权威事实。
 */

import type { RankedMemory } from "./types.js";

const SENSITIVE_RE =
  /(password|api[_-]?key|secret|token|credential|密码|密钥|口令|私钥)/i;

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
}

export interface GuardOptions {
  projectId?: string;
  minConfidence?: number;
}

/** 单条记忆的守卫判定。 */
export function guard(
  m: RankedMemory,
  opts: GuardOptions = {},
): GuardDecision {
  const row = m.row;
  if (row.temporalState === "historical") {
    return { allowed: false, reason: "historical" };
  }
  if (row.hidden === 1) {
    return { allowed: false, reason: "suppressed" };
  }
  const minConfidence = opts.minConfidence ?? 0.3;
  if (row.confidence < minConfidence) {
    return { allowed: false, reason: "low confidence" };
  }
  if (
    row.scope === "project" &&
    opts.projectId !== undefined &&
    row.projectId !== opts.projectId
  ) {
    return { allowed: false, reason: "project scope mismatch" };
  }
  if (SENSITIVE_RE.test(row.content)) {
    return { allowed: false, reason: "sensitive content" };
  }
  return { allowed: true };
}
