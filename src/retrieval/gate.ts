/**
 * Memory Relevance Gate（R3 规则版）：阻止简单请求触发不必要的完整检索。
 * 覆盖问候 / 闲聊 / 过短输入；放行历史 / 项目 / 错误等需检索的查询。
 */

import type { GateResult } from "./types.js";

const CHITCHAT_RE =
  /^(你好|您好|hi|hello|hey|谢谢|thanks|thank you|ok|好的|收到|再见|bye|早上好|晚上好|在吗|嗯|哦|哈哈)[!！。.~～?？]*$/i;

/** 判定查询是否需要检索。 */
export function gate(query: string): GateResult {
  const q = query.trim();
  if (CHITCHAT_RE.test(q)) {
    return { shouldRetrieve: false, reason: "chitchat/greeting" };
  }
  const meaningful = q.replace(/[^\w\u4e00-\u9fa5]/g, "");
  if (meaningful.length < 2) {
    return { shouldRetrieve: false, reason: "too short" };
  }
  return { shouldRetrieve: true, reason: "pass" };
}
