/**
 * Durable Event Worker（R6，Q100/Q101）。
 *
 * 常驻进程内轮询认领 `events` 表中 queued/租约过期的行（store/queue.ts），
 * 派发给注册 handler 执行派生工作（投影/向量/缓存失效/验证/整合等），
 * 成功后 done，失败按退避重试，超阈值 dead。持久性来自 SQLite 队列本身：
 * 进程退出后事件保留，重启后可 resume（租约过期行会被重新认领）。
 *
 * 防御：
 *  - 同一 SqlDatabase 实例禁止重复启动 Worker（防 duplicate worker）；
 *  - 同一事件只能被成功消费一次（claim 原子 + complete 前置状态判定）；
 *  - handler 未注册的事件不会被静默丢弃：按普通失败处理并最终 dead，由 heal
 *    审计暴露“写了事件却没有消费者”的接线漏洞。
 */

import { claimDue, completeEvent, failEvent } from "../store/queue.js";
import type { DurableEventRow } from "../store/events.js";
import type { SqlDatabase } from "../store/sqlite.js";

/** 事件消费处理器。抛错 → 重试/退避/dead。 */
export type EventHandler = (
  ev: DurableEventRow,
  ctx: WorkerContext,
) => void | Promise<void>;

export interface WorkerContext {
  db: SqlDatabase;
  /** 本批循环内的顺序号（0 起）；便于 handler 做批内幂等。 */
  seq: number;
}

export interface DurableWorkerOptions {
  /** 轮询间隔（毫秒）。 */
  pollMs?: number;
  /** 认领租约（毫秒）。 */
  leaseMs?: number;
  /** 重试上限；达上限转 dead。 */
  maxAttempts?: number;
  /** 首次退避基数（毫秒）。 */
  baseBackoffMs?: number;
  /** 单轮循环最多处理条数（0 = 不限）。 */
  maxPerBatch?: number;
  /** 未注册 handler 的事件如何处理：'fail'（默认，重试后 dead）| 'ignore'（直接 done）。 */
  onUnhandled?: "fail" | "ignore";
  /** 事件 dead-letter 时回调（日志/告警）。 */
  onDead?: (ev: DurableEventRow, message: string) => void;
  /** 每批处理完成回调。 */
  onBatch?: (result: DrainResult) => void;
}

export interface DrainResult {
  processed: number;
  failed: number;
  dead: number;
  unhandled: number;
  drained: boolean;
}

export type ConsumerMap = Record<string, EventHandler>;

const activeWorkers = new WeakSet<SqlDatabase>();

/** 最长前缀匹配：feedback.apply → feedback.apply / feedback. / feedback（按长度降序）。 */
function resolveHandler(
  consumers: ConsumerMap,
  type: string,
): EventHandler | undefined {
  if (consumers[type] !== undefined) return consumers[type];
  const parts = type.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join(".");
    const hit = consumers[`${prefix}.*`];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export class DurableWorker {
  private readonly consumers: ConsumerMap;
  private readonly options: Required<Omit<DurableWorkerOptions, "onDead" | "onBatch">> & {
    onDead?: (ev: DurableEventRow, message: string) => void;
    onBatch?: (result: DrainResult) => void;
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopping = false;
  private busy = false;
  private readonly db: SqlDatabase;
  /** 最后一次 drain 结果（health/view 用）。 */
  lastResult: DrainResult | null = null;
  /** 累计处理数（进程内）。 */
  processedTotal = 0;

  constructor(
    db: SqlDatabase,
    consumers: ConsumerMap,
    options: DurableWorkerOptions = {},
  ) {
    if (activeWorkers.has(db)) {
      throw new Error("duplicate DurableWorker: 同一 SqlDatabase 已有一个活跃 Worker");
    }
    activeWorkers.add(db);
    this.db = db;
    this.consumers = consumers;
    this.options = {
      pollMs: options.pollMs ?? 100,
      leaseMs: options.leaseMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 5,
      baseBackoffMs: options.baseBackoffMs ?? 250,
      maxPerBatch: options.maxPerBatch ?? 0,
      onUnhandled: options.onUnhandled ?? "fail",
      onDead: options.onDead,
      onBatch: options.onBatch,
    };
  }

  /** 启动轮询（异步 drain；timer unref，不阻碍宿主退出）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.drain();
    this.timer = setInterval(() => {
      void this.drain();
    }, this.options.pollMs);
    this.timer.unref?.();
  }

  /** 优雅停止：不再接受新轮询，等待当前批完成。 */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 等待正在执行的批次结束。
    while (this.busy) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** 当前是否在运行。 */
  isRunning(): boolean {
    return this.running || this.busy;
  }

  /** 单次排空：持续认领处理到队列空或达批上限。供测试/CLI/宿主手动触发。 */
  async drain(): Promise<DrainResult> {
    if (this.busy) return this.lastResult ?? { processed: 0, failed: 0, dead: 0, unhandled: 0, drained: false };
    this.busy = true;
    const result: DrainResult = { processed: 0, failed: 0, dead: 0, unhandled: 0, drained: false };
    try {
      let guard = 0;
      const maxBatch = this.options.maxPerBatch;
      const manual = !this.running;
      while (true) {
        if (manual) {
          // 手动排空：跑到队列空或达批上限为止。
          if (maxBatch > 0 && result.processed + result.failed + result.unhandled >= maxBatch) break;
        } else if (this.stopping || !this.running) {
          // 轮询循环：收到 stop 或已停止即让出。
          break;
        }
        const ev = claimDue(this.db, { leaseMs: this.options.leaseMs });
        if (ev === null) break;
        guard++;
        const handler = resolveHandler(this.consumers, ev.eventType);
        const ctx: WorkerContext = { db: this.db, seq: guard - 1 };
        if (handler === undefined) {
          if (this.options.onUnhandled === "ignore") {
            completeEvent(this.db, ev.id);
            result.unhandled++;
          } else {
            const outcome = failEvent(this.db, ev.id, new Error(`no consumer for event: ${ev.eventType}`), {
              maxAttempts: this.options.maxAttempts,
              baseBackoffMs: this.options.baseBackoffMs,
            });
            result.unhandled++;
            if (outcome === "dead") {
              result.dead++;
              this.options.onDead?.(ev, "no consumer for event: " + ev.eventType);
            }
          }
          continue;
        }
        try {
          await handler(ev, ctx);
          completeEvent(this.db, ev.id);
          result.processed++;
          this.processedTotal++;
        } catch (err) {
          result.failed++;
          const message = err instanceof Error ? err.message : String(err);
          const outcome = failEvent(this.db, ev.id, err, {
            maxAttempts: this.options.maxAttempts,
            baseBackoffMs: this.options.baseBackoffMs,
          });
          if (outcome === "dead") {
            result.dead++;
            this.options.onDead?.(ev, message);
          }
        }
      }
      result.drained = guard > 0;
      this.lastResult = result;
      if (result.processed > 0 || result.failed > 0 || result.dead > 0) {
        this.options.onBatch?.(result);
      }
      return result;
    } finally {
      this.busy = false;
    }
  }

  /** 释放 worker 占用标记（stop 后调用；正常宿主销毁流程）。 */
  release(): void {
    activeWorkers.delete(this.db);
  }
}
