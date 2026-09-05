/**
 * Evaluator：评估候选的重要性/置信度（R2 规则版，确定性）。
 * 高置信显式自述 → importance=high；否则 normal。后续可替换为 LLM 评估。
 */

import type { Importance } from "../schema/enums.js";
import type { ExtractionCandidate } from "./rules.js";

export interface EvaluatedCandidate extends ExtractionCandidate {
  importance: Importance;
}

/** 为候选补齐 importance 等级。 */
export function evaluate(
  candidates: ExtractionCandidate[],
): EvaluatedCandidate[] {
  return candidates.map((c) => ({
    ...c,
    importance: c.confidence >= 0.8 ? "high" : "normal",
  }));
}
