/**
 * Durable Event Queue（R6，Q100/Q101/Q103）。
 *
 * `events` 表是唯一事实源：结构化提交在事务内入队（见 repository/域模块），
 * Worker 以“认领-租约”模型消费：
 *  - claimDue：原子认领到期 queued 行（并把租约过期的 processing 行重新认领，支持
 *    “进程退出后 resume”）；
 *  - completeEvent：成功 → done；
 *  - failEvent：失败 → 按 attempts 指数退避回 queued，超过 maxAttempts → dead。
 *
 * 幂等消费由调用方 handler 保证；enqueue 幂等由 idempotency_key 唯一约束保证。
 */

import {
  eventCounts,
  getEvent,
  type DurableEventRow,
  type EventCounts,
} from "./events.js";
import type { SqlDatabase } from "./sqlite.js";
import { withTransaction } from "./sqlite.js";

export interface ClaimOptions {
  /** 认领租约（毫秒）：processing 行超过该时长视为中断，可被重新认领。 */
  leaseMs?: number;
  now?: string;
}

export interface FailOptions {
  /** 达到该次数后转入 dead，不再自动重试。 */
  maxAttempts?: number;
  /** 首次退避基数（毫秒）；第 n 次失败后等待 base * 2^(n-1)。 */
  baseBackoffMs?: number;
}

const isoAt = (date = new Date()) => date.toISOString();

/** 认领下一条到期事件；无可用事件返回 null。认领 = status→processing + attempts+1。 */
export function claimDue(db: SqlDatabase, options: ClaimOptions = {}): DurableEventRow | null {
  const now = isoAt(new Date(options.now ?? new Date().toISOString()));
  const leaseMs = options.leaseMs ?? 30_000;
  const staleAt = new Date(Date.now() - leaseMs).toISOString();

  const candidate = db
    .prepare(
      `SELECT id FROM events
        WHERE (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (status = 'processing' AND claimed_at IS NOT NULL AND claimed_at <= ?)
       ORDER BY ts, id LIMIT 1`,
    )
    .get(now, staleAt) as { id: string } | undefined;
  if (candidate === undefined) return null;

  let claimed = false;
  withTransaction(db, () => {
    const res = db
      .prepare(
        `UPDATE events
            SET status = 'processing', claimed_at = ?, next_attempt_at = NULL,
                attempts = attempts + 1
          WHERE id = ? AND (
            status = 'queued'
            OR (status = 'processing' AND claimed_at IS NOT NULL AND claimed_at <= ?)
          )`,
      )
      .run(now, candidate.id, staleAt);
    claimed = res.changes > 0;
  });
  return claimed ? getEvent(db, candidate.id) : claimDue(db, options);
}

/** 消费成功：标记 done。 */
export function completeEvent(db: SqlDatabase, id: string, at?: string): void {
  db.prepare(
    "UPDATE events SET status = 'done', processed_at = ?, claimed_at = NULL, error_json = NULL WHERE id = ?",
  ).run(isoAt(new Date(at ?? new Date().toISOString())), id);
}

/**
 * 消费失败：重试回退或 dead-letter。
 * @returns 新状态：'queued'（将重试）| 'dead'（已死信）。
 */
export function failEvent(
  db: SqlDatabase,
  id: string,
  error: unknown,
  options: FailOptions = {},
): "queued" | "dead" {
  const ev = getEvent(db, id);
  if (ev === null) return "dead";
  const maxAttempts = options.maxAttempts ?? 5;
  const baseBackoffMs = options.baseBackoffMs ?? 250;
  const attempts = ev.attempts;
  const message = error instanceof Error ? error.message : String(error);
  const errorJson = JSON.stringify({ message, at: isoAt() });

  if (attempts >= maxAttempts) {
    db.prepare(
      "UPDATE events SET status = 'dead', claimed_at = NULL, error_json = ? WHERE id = ?",
    ).run(errorJson, id);
    return "dead";
  }
  const delay = baseBackoffMs * 2 ** Math.max(0, attempts - 1);
  const nextAt = new Date(Date.now() + delay).toISOString();
  db.prepare(
    `UPDATE events
        SET status = 'queued', next_attempt_at = ?, claimed_at = NULL, error_json = ?
      WHERE id = ?`,
  ).run(nextAt, errorJson, id);
  return "queued";
}

/** 将 dead 事件重新入队（人工/自愈：清零重试计数，立刻可执行）。 */
export function requeueDead(db: SqlDatabase, id: string, note = "manual requeue"): void {
  const now = isoAt();
  db.prepare(
    `UPDATE events
        SET status = 'queued', attempts = 0, next_attempt_at = ?, claimed_at = NULL,
            error_json = ?
      WHERE id = ? AND status = 'dead'`,
  ).run(now, JSON.stringify({ note, at: now }), id);
}

/** 队列统计（workers / CLI / heal 用）。 */
export function queueStats(db: SqlDatabase): EventCounts {
  return eventCounts(db);
}

/** 重放辅助：取某条事件及其后续事件（按 ts,id 序；snapshot/replay 水位用）。 */
export function eventsAfter(
  db: SqlDatabase,
  highWaterId: string | null,
  limit = 1000,
): DurableEventRow[] {
  const rows = highWaterId === null
    ? db
        .prepare("SELECT * FROM events ORDER BY ts, id LIMIT ?")
        .all(limit)
    : db
        .prepare("SELECT * FROM events WHERE (ts, id) > (SELECT ts, id FROM events WHERE id = ?) ORDER BY ts, id LIMIT ?")
        .all(highWaterId, limit);
  return (rows as Array<Record<string, unknown>>).map((r) =>
    getEvent(db, String(r.id)),
  ).filter((e): e is DurableEventRow => e !== null);
}
