/**
 * R8（阶段 3）CLI：自动学习任务边界演示/维护。
 *
 * `auto learn` 走完整 Task Boundary 闭环：submitAutoLearn 先入队（gate +
 * 敏感预检，不落记忆），默认再用默认消费者集手动 drain 一轮执行 auto.learn
 * 任务（等同宿主常驻 worker 的单次排空），并打印新增 memory.create 数。
 * `--nowait` 只入队返回 task id，供宿主长驻 worker 稍后消费。
 */

import { resolveStoreFile } from "../paths.js";
import { openStore } from "../store/db.js";
import { eventCountByType } from "../store/events.js";
import { submitAutoLearn } from "../auto/task.js";
import { defaultWorkerConsumers } from "../worker/handlers.js";
import { DurableWorker } from "../worker/worker.js";
import type { AutoOrigin } from "../auto/types.js";

export const AUTO_USAGE = `
R8 auto commands:
  auto learn <text> [--origin <remember|conversation|task-end|api>]
               [--project-id <id>] [--actor <actor>] [--source-ref <ref>]
               [--nowait]
              提交自动学习任务（任务边界：gate/敏感预检后入队 auto.learn）；
              默认再 drain 一轮默认消费者执行任务并打印新增记忆数；
              --nowait 只入队并返回 task id（由宿主长驻 worker 消费）；
              存储同其它命令：--data-dir（默认 <插件根>/data）下 --db-file（默认 memory.db）
`;

const ORIGINS: ReadonlySet<AutoOrigin> = new Set([
  "remember",
  "conversation",
  "task-end",
  "api",
]);

interface AutoArgs {
  dataDir?: string;
  dbFile?: string;
  text?: string;
  projectId?: string;
  actor?: string;
  sourceRef?: string;
  origin: AutoOrigin;
  nowait: boolean;
}

function parseArgs(args: string[]): AutoArgs {
  const out: AutoArgs = { origin: "api", nowait: false };
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
  };
  out.dataDir = take("--data-dir");
  out.dbFile = take("--db-file");
  out.text = take("--text");
  out.projectId = take("--project-id");
  out.actor = take("--actor");
  out.sourceRef = take("--source-ref");
  const origin = take("--origin");
  if (origin !== undefined) {
    if (!ORIGINS.has(origin as AutoOrigin)) {
      throw new Error(
        `--origin 非法: ${origin}（允许 ${[...ORIGINS].join("|")}）`,
      );
    }
    out.origin = origin as AutoOrigin;
  }
  out.nowait = args.includes("--nowait");
  // 位置参数（首个非 --flag 值）即文本，兼容 --text 之外的自然用法。
  if (out.text === undefined) {
    const pos = args.find((a) => !a.startsWith("-"));
    out.text = pos;
  }
  return out;
}

export async function cmdAutoLearn(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    console.log(AUTO_USAGE);
    return;
  }
  const sub = args[0];
  if (sub !== "learn") {
    throw new Error(`未知 auto 子命令: ${sub}`);
  }
  const opts = parseArgs(args.slice(1));
  const text = opts.text;
  if (text === undefined || text.trim().length === 0) {
    throw new Error("auto learn 需要 <text> 或 --text <文本>");
  }

  const file = resolveStoreFile(opts);
  const store = openStore({ file });
  try {
    const createdBefore =
      eventCountByType(store.db).find((t) => t.eventType === "memory.create")
        ?.count ?? 0;

    const submit = submitAutoLearn(store.db, {
      text,
      origin: opts.origin,
      projectId: opts.projectId,
      actor: opts.actor,
      sourceRef: opts.sourceRef,
    });
    console.log(`store file : ${file}`);
    console.log(`gate       : ${submit.intent}${submit.reason ? ` (${submit.reason})` : ""}`);
    if (submit.taskId === null) {
      console.log(
        submit.duplicate
          ? "submit     : duplicate（同文本同上下文任务已存在）"
          : `submit     : 未入队${submit.blockedDigest ? `（敏感拦截，audit=${submit.blockedDigest}）` : ""}`,
      );
      return;
    }
    console.log(`submit     : queued (task ${submit.taskId})`);

    if (opts.nowait) {
      console.log("drain      : skipped（--nowait，由宿主 worker 消费）");
      return;
    }

    const worker = new DurableWorker(store.db, defaultWorkerConsumers(), {
      onUnhandled: "fail",
    });
    const res = await worker.drain();
    const createdAfter =
      eventCountByType(store.db).find((t) => t.eventType === "memory.create")
        ?.count ?? 0;
    console.log(`drain      : processed=${res.processed} failed=${res.failed} dead=${res.dead}`);
    console.log(`memories   : +${Math.max(0, createdAfter - createdBefore)} created`);
    if (res.dead > 0) {
      console.log("warning    : 存在 dead 事件，用 `dsh-memory heal --requeue` 审计/重放");
    }
  } finally {
    store.db.close();
  }
}
