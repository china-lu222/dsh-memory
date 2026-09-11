/**
 * R8 SSE 事件流 — durable 事件源增量读取（phase 4）。
 *
 * 事件源是 `events` 表本身（R6 Durable Event Log）：已完成（status='done'）
 * 的域事件（memory.create / conflict.open / experience.advance 等）即对外
 * 变化流。增量谓词为 `(ts, id) > (cursor.ts, cursor.id)`，因此无论事件由
 * 本进程 worker、CLI drain 还是其它进程写入同一 SQLite 文件，SSE 都能
 * 感知——内存库/文件库语义一致，天然跨进程 durable。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import type { StreamCursor } from "./cursor.js";
import type { CompiledStreamFilter } from "./filter.js";

/** 推送给订阅者的已完成事件视图。 */
export interface DoneStreamEvent {
  id: string;
  /** ISO-8601 文本 ts（与 events.ts 一致，参与 (ts,id) 排序）。 */
  ts: string;
  eventType: string;
  memoryId: string | null;
  payload: unknown;
}

function mapDoneRow(r: Record<string, unknown>): DoneStreamEvent {
  let payload: unknown = {};
  try {
    payload = JSON.parse(String(r.payload_json ?? "{}")) as unknown;
  } catch {
    // payload 无法解析时按空对象交付（异常行不致中断整条流）。
  }
  return {
    id: String(r.id),
    ts: String(r.ts),
    eventType: String(r.event_type),
    memoryId: r.memory_id === null ? null : String(r.memory_id),
    payload,
  };
}

/**
 * 读取 (after, 末端] 内 status='done' 且类型匹配的事件（不含 after 自身）。
 * after=null 表示回放全量 done（带过滤）；调用方无游标首连时应先以
 * cursorAtHead 建水位，避免把历史全量 dump 给新订阅者。
 */
export function queryDoneEvents(
  db: SqlDatabase,
  options: {
    after: StreamCursor | null;
    filter: CompiledStreamFilter;
    limit: number;
  },
): DoneStreamEvent[] {
  const { after, filter, limit } = options;
  const cap = Math.max(1, Math.min(500, Math.floor(limit)));
  const typeSql = filter.toSql("event_type");
  let sql =
    "SELECT id, ts, event_type, memory_id, payload_json FROM events " +
    `WHERE status = 'done' AND ${typeSql.where}`;
  const params: Array<string | number> = [...typeSql.params];
  if (after !== null) {
    sql += " AND (ts > ? OR (ts = ? AND id > ?))";
    params.push(after.ts, after.ts, after.id);
  }
  sql += " ORDER BY ts, id LIMIT ?";
  params.push(cap);
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapDoneRow);
}

/** 表内当前最大已完成事件游标（无任何 done 行时为 null）。 */
export function cursorAtHead(db: SqlDatabase): StreamCursor | null {
  const r = db
    .prepare(
      "SELECT ts, id FROM events WHERE status = 'done' ORDER BY ts DESC, id DESC LIMIT 1",
    )
    .get() as { ts: string; id: string } | undefined;
  return r === undefined ? null : { ts: String(r.ts), id: String(r.id) };
}
