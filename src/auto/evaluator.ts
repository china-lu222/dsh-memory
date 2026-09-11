/**
 * Auto Long-Term Memory — 评估（阶段 2）。
 *
 * 在抽取后给每个候选定 confidence（证据强度）与 importance（对用户价值）：
 * 两者正交——confidence 来自来源可靠性/规则显式度，importance 来自价值信号
 * （显式记住、强约束、关键/紧急词）。只做确定性合成，不含 LLM。
 */

import type {
  AutoCandidate,
  EvaluatedAutoCandidate,
  GateIntent,
  LearnContext,
} from "./types.js";

/** 显式「记住」的规则基线置信。 */
export const EXPLICIT_CONFIDENCE = 0.9;

/** 低于该置信的 inferred 候选写入后直接进隔离区。 */
export const AUTO_QUARANTINE_THRESHOLD = 0.6;

/** 价值信号：命中即 importance=high。 */
const VALUE_HIGH =
  /(?:always|never|must|critical|key|essential|deadline|urgent|重要|关键|核心|必须|严禁|禁止|无论如何|无论如何都要|首选|绝对)/i;

/**
 * 评估单个候选。
 * @param cand 抽取结果
 * @param ctx 调用上下文（explicit remember / api 直接给高置信）
 * @param intent gate 判定结果
 */
export function evaluateAutoCandidate(
  cand: AutoCandidate,
  ctx: LearnContext,
  intent: GateIntent,
): EvaluatedAutoCandidate {
  const explicit =
    intent === "remember" ||
    ctx.origin === "remember" ||
    ctx.origin === "api";
  const confidence = Math.min(
    1,
    explicit ? Math.max(cand.baseConfidence, EXPLICIT_CONFIDENCE) : cand.baseConfidence,
  );
  let importance: EvaluatedAutoCandidate["importance"] = "normal";
  if (explicit) {
    importance = "high";
  } else if (cand.baseConfidence >= 0.85 || VALUE_HIGH.test(cand.content)) {
    importance = "high";
  }
  return { ...cand, confidence, importance };
}

/** 批量评估（保持输入顺序）。 */
export function evaluateAutoCandidates(
  candidates: AutoCandidate[],
  ctx: LearnContext,
  intent: GateIntent,
): EvaluatedAutoCandidate[] {
  return candidates.map((c) => evaluateAutoCandidate(c, ctx, intent));
}
