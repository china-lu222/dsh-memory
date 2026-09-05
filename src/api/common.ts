/**
 * Memory Center 管理 API（R7）共享契约。
 *
 * 所有 api/* 管理操作统一返回 `Result<T>`：宿主路由可直接透传
 * `{ ok: true, data }` / `{ ok: false, error }` 给浏览器，无需在
 * 路由层再做异常分支。管理操作只调用域函数与只读查询，不承载业务语义。
 */

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

/** 将抛错逻辑包装为 Result；管理操作以显式错误响应而非异常冒泡。 */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (error) {
    return fail(toMessage(error));
  }
}

export function toMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** 字符串参数：trim 后非空返回原值，否则 undefined。 */
export function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function parseLimit(value: unknown, fallback = 50, max = 500): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

export function parseOffset(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 运行时校验：值须为枚举数组字面量成员（schema/enums 提供）。 */
export function isOneOf<const T extends readonly string[]>(
  options: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && options.includes(value as T[number]);
}

export function enumOr<const T extends readonly string[]>(
  options: T,
  value: unknown,
): T[number] | undefined {
  return isOneOf(options, value) ? value : undefined;
}
