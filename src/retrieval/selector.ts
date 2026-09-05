/**
 * Selector（R3）：从候选记忆中综合 relevance/importance/confidence/redundancy/
 * token 成本选择最终进入 Context 的记忆。
 * 至少解决重复/高度相似记忆的冗余问题，并受 token 预算约束。
 */

import type { RankedMemory } from "./types.js";

/** 分词 token 集合（去冗余比对用）。 */
function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  );
}

/** Jaccard 相似度（0..1）。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 粗略估算 content 的 token 数（中文按字符，其余按 4 字符/token）。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/**
 * 选择最终记忆：按分数顺序，跳过冗余（与已选记忆 Jaccard > 0.8）与超预算项。
 */
export function select(
  candidates: RankedMemory[],
  budgetTokens: number,
): RankedMemory[] {
  const selected: RankedMemory[] = [];
  let used = 0;
  for (const cand of candidates) {
    const t = estimateTokens(cand.row.content);
    const ct = tokenSet(cand.row.content);
    let redundant = false;
    for (const s of selected) {
      if (jaccard(ct, tokenSet(s.row.content)) > 0.8) {
        redundant = true;
        break;
      }
    }
    if (redundant) continue;
    if (used + t > budgetTokens) continue;
    selected.push(cand);
    used += t;
  }
  return selected;
}
