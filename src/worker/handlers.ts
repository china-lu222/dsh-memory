import { enqueueEvent } from "../store/events.js";
import { runDeepConsolidation } from "../memory/consolidation.js";
import { runGeneralization } from "../memory/generalize.js";
import type { ConsumerMap } from "./worker.js";

/**
 * 已完成同步派生的域事件：进入队列仅作 durable ledger（重放/审计水位），
 * Worker 侧直接 ack。真正需要后台执行的只有 scheduled deep job。
 */
const ack = (): void => {};

const HOUR_MS = 60 * 60 * 1000;

/**
 * 默认消费者集：memory/experience/conflict/generalize 前缀 ack；
 * consolidation.scheduled 执行 深合并 → 泛化晋升 一轮。
 */
export function defaultWorkerConsumers(): ConsumerMap {
  return {
    "memory.*": ack,
    "experience.*": ack,
    "conflict.*": ack,
    "generalize.*": ack,
    "consolidation.scheduled": (_ev, ctx) => {
      runDeepConsolidation(ctx.db, { actor: "worker" });
      runGeneralization(ctx.db, { actor: "worker" });
    },
  };
}

/**
 * 入队一轮 scheduled deep consolidation（按整点幂等，每小时至多一条待执行）。
 * @returns 新事件 id；该小时内已存在待执行任务则返回 null。
 */
export function scheduleDeepConsolidation(
  db: import("../store/sqlite.js").SqlDatabase,
  afterMs = 0,
): string | null {
  const now = Date.now();
  const bucket = Math.floor(now / HOUR_MS);
  return enqueueEvent(db, {
    type: "consolidation.scheduled",
    idempotencyKey: `consolidation.scheduled:${bucket}`,
    nextAttemptAt: new Date(now + afterMs).toISOString(),
  });
}
