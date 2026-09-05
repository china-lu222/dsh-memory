/**
 * Resolver：候选消解（R2 规则版）。
 * 与已存在记忆逐条比对 content，完全重复的候选跳过（幂等），其余创建。
 */

import type { EvaluatedCandidate } from "./evaluate.js";

export interface ResolvedCandidate {
  candidate: EvaluatedCandidate;
  action: "create" | "skip";
}

/** 去重消解：已存在相同 content 的候选标记 skip。 */
export function resolve(
  candidates: EvaluatedCandidate[],
  existingContents: ReadonlySet<string>,
): ResolvedCandidate[] {
  return candidates.map((candidate) => ({
    candidate,
    action: existingContents.has(candidate.content) ? "skip" : "create",
  }));
}
