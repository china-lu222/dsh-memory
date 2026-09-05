/**
 * Store 事件层（R2 内存总线 + R6 Durable Outbox）。
 *
 * 分层：
 *  - `enqueueEvent`：在调用方事务内（或独立）向 `events` 表写 queued 行。行即
 *    Durable Event Log / Queue，含 idempotency_key（同 key 再次入队为空操作）、
 *    memory_id/entity_version、next_attempt_at，由 Worker 认领消费。结构层提交后
 *    事件才可见，因此“commit 失败 → 无事件”，符合 Q102 ChangeSet 语义。
 *  - `publishMemoryEvent`：进程内即时广播（R2 同步投影的既有契约）。它不承载
 *    持久性承诺，也不替代 Durable 队列；R1–R5 订阅方若同时由 Worker 驱动同一
 *    派生工作，必须二选一以避免重复执行。
 */

import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "./sqlite.js";

export type MemoryEventType =
  | "memory.create"
  | "memory.update"
  | "memory.archive"
  | "memory.restore";

export interface MemoryEvent {
  type: MemoryEventType;
  memoryId: string;
  version: number;
  at: string;
}

export type MemoryEventListener = (event: MemoryEvent) => void;

export interface EnqueueEventInput {
  /** 事件类型；memory.* 用 MemoryEventType，域事件可自由命名（如 feedback.apply）。 */
  type: string;
  /** 聚合/记忆 id（可选，域事件可无）。 */
  memoryId?: string;
  /** 聚合版本（可选，域事件可无）。 */
  entityVersion?: number;
  payload?: unknown;
  /**
   * 幂等键。缺省派生规则：
   *  - 有 memoryId：`${type}:${memoryId}:${entityVersion ?? "any"}`
   *  - 无 memoryId：`${type}:${at}`（同类型同刻只会入队一次）
   * 重复（同键已存在）入队为 no-op，返回 null。
   */
  idempotencyKey?: string;
  /** 事件时间（缺省 now）。 */
  at?: string;
  /** 首跳可执行时间（缺省 now）；调用方可借此做延迟任务。 */
  nextAttemptAt?: string;
}

export interface DurableEventRow {
  id: string;
  ts: string;
  eventType: string;
  memoryId: string | null;
  entityVersion: number | null;
  payload: unknown;
  status: "queued" | "processing" | "done" | "dead";
  attempts: number;
  idempotencyKey: string | null;
  nextAttemptAt: string | null;
  claimedAt: string | null;
  processedAt: string | null;
  lastError: string | null;
}

const iso = (d = new Date()) => d.toISOString();

const EVENT_COLS =
  "id, ts, event_type, memory_id, entity_version, payload_json, status, " +
  "attempts, idempotency_key, next_attempt_at, claimed_at, processed_at, last_error";

function mapEventRow(r: Record<string, unknown>): DurableEventRow {
  return {
    id: String(r.id),
    ts: String(r.ts),
    eventType: String(r.event_type),
    memoryId: r.memory_id === null ? null : String(r.memory_id),
    entityVersion: r.entity_version === null ? null : Number(r.entity_version),
    payload: parseJson(String(r.payload_json ?? "{}")),
    status: r.status as DurableEventRow["status"],
    attempts: Number(r.attempts ?? 0),
    idempotencyKey: r.idempotency_key === null ? null : String(r.idempotency_key),
    nextAttemptAt: r.next_attempt_at === null ? null : String(r.next_attempt_at),
    claimedAt: r.claimed_at === null ? null : String(r.claimed_at),
    processedAt: r.processed_at === null ? null : String(r.processed_at),
    lastError: r.last_error === null ? null : String(r.last_error),
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

export interface EventCounts {
  queued: number;
  processing: number;
  done: number;
  dead: number;
  total: number;
}

/**
 * 入队一个 durable 事件（INSERT OR IGNORE：同 idempotency_key 已存在则 no-op）。
 * @returns 新事件 id；重复入队（同键已存在）返回 null。
 */
export function enqueueEvent(db: SqlDatabase, input: EnqueueEventInput): string | null {
  const at = input.at ?? iso();
  const key =
    input.idempotencyKey ??
    (input.memoryId !== undefined
      ? `${input.type}:${input.memoryId}:${input.entityVersion ?? "any"}`
      : `${input.type}:${at}`);
  const id = randomUUID();
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO events
        (id, ts, event_type, memory_id, entity_version, payload_json, status,
         attempts, idempotency_key, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    )
    .run(
      id,
      at,
      input.type,
      input.memoryId ?? null,
      input.entityVersion ?? null,
      JSON.stringify(input.payload ?? {}),
      key,
      input.nextAttemptAt ?? at,
    );
  return res.changes > 0 ? id : null;
}

export function getEvent(db: SqlDatabase, id: string): DurableEventRow | null {
  const r = db.prepare(`SELECT ${EVENT_COLS} FROM events WHERE id = ?`).get(id);
  return r === undefined ? null : mapEventRow(r);
}

export function listEvents(
  db: SqlDatabase,
  options: { status?: string; limit?: number; offset?: number } = {},
): DurableEventRow[] {
  const status = options.status;
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const offset = Math.max(0, options.offset ?? 0);
  let sql = `SELECT ${EVENT_COLS} FROM events`;
  const params: Array<string | number> = [];
  if (status !== undefined) {
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " ORDER BY ts, id LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(mapEventRow);
}

export function eventCounts(db: SqlDatabase): EventCounts {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS c FROM events GROUP BY status")
    .all() as Array<{ status: string; c: number }>;
  const base: EventCounts = { queued: 0, processing: 0, done: 0, dead: 0, total: 0 };
  for (const r of rows) {
    if (r.status === "queued" || r.status === "processing" || r.status === "done" || r.status === "dead") {
      base[r.status] = Number(r.c);
    }
    base.total += Number(r.c);
  }
  return base;
}

export function eventCountByType(
  db: SqlDatabase,
  options: { status?: string; limit?: number } = {},
): Array<{ eventType: string; count: number }> {
  const status = options.status;
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  let sql = "SELECT event_type AS eventType, COUNT(*) AS count FROM events";
  const params: Array<string> = [];
  if (status !== undefined) {
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " GROUP BY event_type ORDER BY count DESC LIMIT ?";
  params.push(String(limit));
  return db.prepare(sql).all(...params) as Array<{ eventType: string; count: number }>;
}

const listeners = new Set<MemoryEventListener>();

/** 订阅 store 变更事件（进程内即时广播，R2 契约）；返回取消订阅函数。 */
export function subscribeMemoryEvents(listener: MemoryEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 广播一次变更（异常隔离：单个监听器失败不阻断其余）。 */
export function publishMemoryEvent(event: MemoryEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // 投影/消费方异常不得阻断 store 提交路径。
    }
  }
}

/** 内存订阅数量（诊断/测试用）。 */
export function memoryListenerCount(): number {
  return listeners.size;
}
