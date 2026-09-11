/**
 * R8 SSE 事件流 — type 前缀过滤（phase 4）。
 *
 * 订阅表达式支持整段事件名（memory.create）、前缀通配（memory.*）与全量
 * （*）。过滤既用于 JS 侧匹配，也下沉为 SQL 谓词（值一律参数绑定，
 * 表达式只决定运算符分支，无注入面）。
 */

const EXACT_CHARS_RE = /^[a-z0-9._-]+$/;

/** 规范化订阅表达式列表（逗号分隔、去空白、去空项、去重、保序）。 */
export function normalizeTypeExpressions(input: readonly string[] | string): string[] {
  const list = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    for (const part of raw.split(",")) {
      const expr = part.trim();
      if (expr.length === 0 || seen.has(expr)) continue;
      seen.add(expr);
      out.push(expr);
    }
  }
  return out;
}

/** 订阅表达式非法（含非安全字符等）时返回原因；合法返回 null。 */
export function invalidTypeExpression(expr: string): string | null {
  if (expr === "*") return null;
  if (expr.endsWith(".*")) {
    const prefix = expr.slice(0, -2);
    return EXACT_CHARS_RE.test(prefix) ? null : `非法前缀通配表达式: ${expr}`;
  }
  return EXACT_CHARS_RE.test(expr) ? null : `非法事件类型表达式: ${expr}`;
}

type SqlPredicate =
  | { kind: "all" }
  | { kind: "prefix"; prefix: string }
  | { kind: "exact"; value: string };

export interface CompiledStreamFilter {
  /** JS 侧匹配。 */
  matches(type: string): boolean;
  /**
   * SQL 侧谓词。column 必须是 `events` 表 event_type 列的合法引用
   * （本模块调用方只传字面量 "event_type"）。空订阅（无表达式）返回
   * `{ where: "1 = 0", params: [] }`。
   */
  toSql(column: string): { where: string; params: string[] };
  /** 是否匹配任意事件（`*` 订阅）。 */
  matchesAll: boolean;
}

/** 编译表达式集。空列表 = 空订阅（什么都不推）。 */
export function compileStreamFilter(expressions: readonly string[]): CompiledStreamFilter {
  const predicates: SqlPredicate[] = expressions.map((expr) => {
    if (expr === "*") return { kind: "all" } as const;
    if (expr.endsWith(".*")) return { kind: "prefix", prefix: expr.slice(0, -1) } as const;
    return { kind: "exact", value: expr } as const;
  });
  const matches = (type: string): boolean =>
    predicates.some((p) =>
      p.kind === "all" ? true : p.kind === "prefix" ? type.startsWith(p.prefix) : type === p.value,
    );
  const toSql = (column: string): { where: string; params: string[] } => {
    if (predicates.length === 0) return { where: "1 = 0", params: [] };
    const col = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column) ? column : "event_type";
    const parts = predicates.map((p) => {
      if (p.kind === "all") return "1 = 1";
      if (p.kind === "prefix") {
        return `${col} LIKE ? ESCAPE '\\'`;
      }
      return `${col} = ?`;
    });
    return {
      where: `(${parts.join(" OR ")})`,
      params: predicates.flatMap((p) =>
        p.kind === "prefix" ? [`${escapeLike(p.prefix)}%`] : p.kind === "exact" ? [p.value] : [],
      ),
    };
  };
  return { matches, toSql, matchesAll: expressions.includes("*") };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
