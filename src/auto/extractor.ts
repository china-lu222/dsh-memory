/**
 * Auto Long-Term Memory — 候选抽取（阶段 2）。
 *
 * 两种形态：
 *  - 显式「记住」：整句即事实（remember 前缀已在调用方剥离），type 由 classifier 给出，
 *    仅产出一条候选，内容与引文原样保留；
 *  - 自动学习：复用 ingest 确定性规则（我只在规则显式命中的自述上产出候选）
 *    与会话事实规则（项目/技术断言、失败经验，见 conversation.ts），
 *    不猜测、不把任意文本当长期事实。
 */

import { extractCandidates as extractRuleCandidates } from "../ingest/rules.js";
import { collapseLine } from "../ingest/text.js";
import { extractConversationFacts } from "./conversation.js";
import type { ClassifyVerdict, AutoCandidate } from "./types.js";

/** remember 整句入库存放的内容上限；超长时截断（保留引文原文到 quote）。 */
const MAX_WHOLE_CONTENT = 1500;

/** 规则抽取单条内容的长度上限（与 ingest rules 保持一致口径）。 */
const MAX_RULE_CONTENT = 300;

export interface AutoExtractOptions {
  /** 提供时按「remember 整句」抽取（分类结果给定 type）。 */
  classify?: ClassifyVerdict;
}

/**
 * 从归一化文本抽取记忆候选。
 * @param text 归一化后的文本（remember 时已剥离前缀）
 * @param opts.classify 提供即整句模式；缺省走 ingest 确定性规则
 */
export function extractAutoCandidates(
  text: string,
  opts: AutoExtractOptions = {},
): AutoCandidate[] {
  const collapsed = collapseLine(text);
  if (collapsed.length === 0) return [];

  if (opts.classify !== undefined) {
    const { type, transient } = opts.classify;
    if (transient) return [];
    const content =
      collapsed.length <= MAX_WHOLE_CONTENT
        ? collapsed
        : `${collapsed.slice(0, MAX_WHOLE_CONTENT)}…`;
    const summary = content.length <= 180 ? content : `${content.slice(0, 180)}…`;
    return [
      {
        type,
        content,
        summary,
        baseConfidence: 0.9,
        quote: collapsed,
      },
    ];
  }

  const out: AutoCandidate[] = [];
  for (const hit of extractRuleCandidates(text)) {
    const content = collapseLine(hit.content, MAX_RULE_CONTENT);
    if (content.length === 0) continue;
    out.push({
      type: hit.type,
      content,
      summary: hit.summary,
      baseConfidence: hit.confidence,
      quote: hit.quote,
    });
  }

  // 会话事实规则与 ingest 规则不重叠（claimed 句子已被前者跳过），此处仅按
  // content 去重，两个来源可以同时命中同一条消息的不同句子。
  const seen = new Set(out.map((candidate) => candidate.content));
  for (const hit of extractConversationFacts(text)) {
    if (seen.has(hit.content)) continue;
    seen.add(hit.content);
    out.push(hit);
  }
  return out;
}
