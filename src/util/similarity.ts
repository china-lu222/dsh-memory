/**
 * 共享文本相似度/归一化工具（R5）：
 * 供 负向抑制、冲突检测、consolidation dedup、Experience 匹配 复用同一套词元口径，
 * 避免各域各自实现“看起来像”的相似度。
 */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "for",
  "in",
  "on",
  "with",
  "that",
  "this",
  "it",
  "be",
  "as",
  "at",
  "by",
  "from",
  "use",
  "using",
  "used",
  "do",
  "does",
  "did",
  "can",
  "will",
  "not",
  "don't",
]);

/** 小写词元（Unicode 单词字符与常见符号）；空串丢弃。 */
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const raw = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}._#+-]*/gu) ?? [];
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** token 集合。 */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Jaccard 相似度 ∈[0,1]；空集视为 0。 */
export function jaccard(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.length === 0 || sb.length === 0) return 0;
  const setA = new Set(sa);
  const setB = new Set(sb);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** a 的词元有多大比例出现在 b 中（a 被 b 覆盖度）∈[0,1]。 */
export function containment(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenSet(b);
  if (sa.length === 0) return 0;
  let hit = 0;
  for (const t of sa) if (sb.has(t)) hit += 1;
  return hit / sa.length;
}

/** 幂等/去重的规范形：小写、折叠空白、去两端符号。 */
export function normalizeCanon(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?"'()\[\]{}<>|`~^%$@#&*=_+\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 最大相似度。 */
export function maxSimilarity(text: string, candidates: readonly string[]): number {
  let best = 0;
  for (const c of candidates) {
    const s = jaccard(text, c);
    if (s > best) best = s;
  }
  return best;
}
