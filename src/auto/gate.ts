/**
 * Auto Long-Term Memory — 输入门控（Gate）。
 *
 * 决定一段输入是「值得学习的高价值内容」还是应丢弃的闲聊/瞬时信息，同时把
 * 显式「记住」请求标到最高优先级。判定是确定性规则，不是 LLM 调用。
 */

import type { AutoOrigin, GateIntent, GateVerdict } from "./types.js";

/** 显式「记住」的引导语（中英）。记住的是内容本身，前缀在 extractor 剥离。 */
const REMEMBER_PREFIX =
  /^\s*(?:please\s+|pls\s+)?(?:remember|note|keep in mind)(?:\s+that)?[\s:：,，-]*|^\s*(?:请\s*)?(?:记住|记一下|请记下|请牢记|记好|注意)[:：,，\s]*/i;

/** 问候/致谢/寒暄（无可学内容的短句）。 */
const CHATTER =
  /^(?:(?:hi|hello|hey|yo|thanks|thank\s+you|thankyou|thx|goodbye|bye|ok|okay|got\s+it|sure|no\s+problem|great|cool|nice|understood|understand|roger|copy)\b|你好|您好|谢谢|多谢|谢谢您|不客气|再见|拜拜|嗨|哈喽|嗯|好的|收到|没问题|明白了|了解|辛苦了|好的谢谢|ok[.!?]?$).*$/i;

/** 明显的问题/纯指令（无已断言事实，不自动沉淀为长期记忆）。 */
const QUESTION_OR_COMMAND =
  /^(?:can|could|would|will|please|how|what|why|when|where|who|which|帮我|请帮我|能不能|可不可以|怎么做|怎么办|怎么|为什么|什么是|什么是|如何|是否|请)[^。！？!?]{0,80}[?？]$/i;

/** 纯工具输出/系统回显标记（无可学语义）。 */
const NOISE_PREFIX =
  /^\s*(?:\[(?:system|tool|error|info|debug)\][\s:：]*(?:ok|done|started|finished|noop|no-op)?|--+|===+|```)/i;

/**
 * 输入分级。
 * @param text 待判定的原始输入（已归一化换行，未裁剪长度）
 * @param origin 触发来源；"remember"/"api" 视为显式用户意图
 */
export function gateText(text: string, origin: AutoOrigin): GateVerdict {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { intent: "noisy", reason: "empty input" };
  if (origin === "remember") return { intent: "remember" };
  if (trimmed.length < 2) return { intent: "noisy", reason: "too short" };
  if (NOISE_PREFIX.test(trimmed)) return { intent: "noisy", reason: "tool/system echo" };
  if (CHATTER.test(trimmed)) return { intent: "chatter", reason: "greeting / acknowledgement" };
  // 显式记住引导语（无论 origin），提取内容为最高优先级。
  if (REMEMBER_PREFIX.test(trimmed)) return { intent: "remember" };
  if (QUESTION_OR_COMMAND.test(trimmed)) {
    return { intent: "noisy", reason: "question / transient instruction" };
  }
  return { intent: "learnable" };
}

/** 剥离显式「记住」前缀，返回内容主体（供 extractor 使用）。 */
export function stripRememberPrefix(text: string): string {
  return text.replace(REMEMBER_PREFIX, "").trim();
}
