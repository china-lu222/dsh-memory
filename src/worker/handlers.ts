import { enqueueEvent } from "../store/events.js";
import { runDeepConsolidation } from "../memory/consolidation.js";
import { runGeneralization } from "../memory/generalize.js";
import { autoLearn } from "../auto/service.js";
import { persistTaskExperience } from "../auto/experience.js";
import { toAutoLearnRequest, toTaskExperienceRequest } from "../auto/task.js";
import type { ConsumerMap } from "./worker.js";

/**
 * 已完成同步派生的域事件：进入队列仅作 durable ledger（重放/审计水位），
 * Worker 侧直接 ack。真正需要后台执行的只有 scheduled deep job 与 auto.learn
 * 自动学习任务（阶段 3，见 src/auto/task.ts）。
 */
const ack = (): void => {};

const HOUR_MS = 60 * 60 * 1000;

/**
 * 默认消费者集：memory/experience/conflict/generalize 前缀 ack；
 * consolidation.scheduled 执行 深合并 → 泛化晋升 一轮；
 * auto.learn 后台执行自动学习（payload 非法/执行失败抛错 → 退避重试/dead）；
 * auto.task-experience 把边界已校验的经验候选落成 experience（幂等）。
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
    "auto.learn": (ev, ctx) => {
      autoLearn(ctx.db, toAutoLearnRequest(ev.payload));
    },
    "auto.task-experience": (ev, ctx) => {
      const request = toTaskExperienceRequest(ev.payload);
      persistTaskExperience(ctx.db, request.candidate, request.provenance);
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
