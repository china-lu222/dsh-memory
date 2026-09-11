/**
 * R8 SSE 事件流 — 游标（phase 4）。
 *
 * 事件按 (ts, id) 全局有序（ISO-8601 文本 ts + uuid id，见 store/events.ts），
 * 增量读水位用单一定位符表达。SSE `id:` 帧行与重连 `Last-Event-ID` 共用
 * 该编码（浏览器 EventSource 自动回带最后收到的 id，实现断点续传）。
 *
 * 编码 = base64url(JSON {ts,id})：ISO 时间戳自身含冒号，不能直接拼接，
 * base64url 亦不含空格/控制字符，可在 `id:` 行与 header 中安全传输。
 */

/** 事件流水位：位于 (ts,id) 之后的事件尚未消费。 */
export interface StreamCursor {
  ts: string;
  id: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 编码为 SSE `id:` 帧行 / `Last-Event-ID` 值（base64url）。 */
export function encodeCursor(cursor: StreamCursor): string {
  const bytes = enc.encode(JSON.stringify({ ts: cursor.ts, id: cursor.id }));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 解码游标；非法/损坏输入返回 null（由调用方按 400 处理）。 */
export function decodeCursor(raw: string): StreamCursor | null {
  if (raw.length === 0 || raw.length > 512) return null;
  try {
    const normalized = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bin = atob(normalized);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const parsed = JSON.parse(dec.decode(bytes)) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { ts?: unknown }).ts !== "string" ||
      typeof (parsed as { id?: unknown }).id !== "string"
    ) {
      return null;
    }
    const { ts, id } = parsed as { ts: string; id: string };
    if (ts.length === 0 || id.length === 0) return null;
    return { ts, id };
  } catch {
    return null;
  }
}
