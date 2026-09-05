/**
 * Query Understanding（R3 规则版）：trim/normalize/去噪/去重 + 有限同义扩展。
 * 不引入 LLM；HyDE 等留待 R4 Provider 成熟后接入。
 */

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "for", "of", "in",
  "on", "and", "or", "with", "how", "what", "why", "do", "does", "did",
  "我", "你", "他", "她", "它", "的", "了", "是", "在", "和", "与", "就",
  "都", "要", "怎么", "什么", "为什么", "如何", "这个", "那个", "我们", "你们",
]);

const SYNONYMS: Record<string, string[]> = {
  ts: ["typescript"],
  js: ["javascript"],
  py: ["python"],
  db: ["database", "sqlite"],
  sqlite: ["database"],
  database: ["sqlite"],
  error: ["报错", "错误", "异常", "失败"],
  报错: ["error", "错误"],
  错误: ["error", "报错"],
  fix: ["修复", "解决"],
  修复: ["fix", "解决"],
  解决: ["fix", "修复"],
};

/** 归一化：小写、去标点、分词、去噪声、去重，返回有序 token。 */
export function normalizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP_WORDS.has(t));
  return [...new Set(tokens)];
}

/** 有限同义扩展（基于 normalize 后的 token）。 */
export function expandTerms(terms: string[], enabled: boolean): string[] {
  if (!enabled) return terms;
  const out = new Set(terms);
  for (const t of terms) {
    const syns = SYNONYMS[t];
    if (syns) for (const s of syns) out.add(s);
  }
  return [...out];
}

/**
 * 构建同义词分组：每个原始词与其同义词同组（组内 OR），不同组之间 AND。
 * 检索层据此构造 FTS5 MATCH，避免“同义词必须同时出现”的过度约束。
 */
export function buildTermGroups(terms: string[], expand: boolean): string[][] {
  return terms.map((t) => {
    if (!expand) return [t];
    const syns = SYNONYMS[t] ?? [];
    return [t, ...syns];
  });
}
