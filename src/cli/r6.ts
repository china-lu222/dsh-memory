/**
 * R6 CLI：durable events/queue 可视化与维护、consolidation、generalization。
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStoreFile } from "../paths.js";
import { openStore } from "../store/db.js";
import { eventCounts, eventCountByType, listEvents } from "../store/events.js";
import { requeueDead } from "../store/queue.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { runDeepConsolidation, runRealtimeLocalDedup } from "../memory/consolidation.js";
import { runGeneralization } from "../memory/generalize.js";
import { runHygieneScan } from "../memory/validation.js";
import { defaultWorkerConsumers } from "../worker/handlers.js";
import { DurableWorker } from "../worker/worker.js";
import { createSnapshot, getSnapshot, listSnapshots } from "../reliability/snapshot.js";
import { createBackup, getBackup, listBackups } from "../reliability/backup.js";
import { restoreFile } from "../reliability/restore.js";
import { runReplay } from "../reliability/replay.js";
import { verifySqliteFile } from "../reliability/common.js";

export const R6_USAGE = `
R6 commands:
  events [--limit <n>] [--status <queued|processing|done|dead>]
                    队列统计 + 事件列表（by type 汇总）
  queue drain       认领到期事件并执行默认消费者（scheduled 深合并等）
  consolidate [--jaccard <0..1>] [--deep]
                    实时本地去重（近似重复转评审）；--deep 追加深合并/聚簇
  generalize        运行一轮 pattern 发现 → 登记 → 晋升
  heal [--requeue]  报告 dead/未消费事件；--requeue 将 dead 全部重新入队
  snapshot          创建一致性快照并登记（--note <备注>）
  snapshot --list   列出快照清单（--limit <n>）
  backup            创建一致性备份并登记（--note <备注>）
  backup --list     列出备份清单（--limit <n>）
  restore <snapshot|backup> <id> [--to <file>] [--verify-only]
                    校验并恢复清单制品（默认恢复到 <db 目录>/restored-<id>.db；
                    --to 指定目标文件；--verify-only 只做 staged 校验不落盘）
  replay [--dry-run] [--rebuild-md <root>]
                    重放入口：默认 rebuild（DB→Markdown 幂等重建）；
                    --dry-run 只扫描出计划；--rebuild-md 指定 MD 根目录
  verify <file>     对离线 SQLite 文件执行 integrity/schema/计数校验
  validate [--dry-run]
                    连续校验（hygiene 扫描）：过期 validUntil 的记忆转 expired；
                    --dry-run 只扫描并记录（validation_runs），不改写记忆
`;

interface R6Args {
  dataDir?: string;
  dbFile?: string;
  limit?: string;
  status?: string;
  jaccard?: string;
  deep: boolean;
  requeue: boolean;
  note?: string;
  verifyOnly: boolean;
  dryRun: boolean;
  to?: string;
}

function parseArgs(args: string[]): R6Args {
  const out: R6Args = { deep: false, requeue: false, verifyOnly: false, dryRun: false };
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
  };
  out.dataDir = take("--data-dir");
  out.dbFile = take("--db-file");
  out.limit = take("--limit");
  out.status = take("--status");
  out.jaccard = take("--jaccard");
  out.deep = args.includes("--deep");
  out.requeue = args.includes("--requeue");
  out.note = take("--note");
  out.verifyOnly = args.includes("--verify-only");
  out.dryRun = args.includes("--dry-run");
  out.to = take("--to");
  return out;
}

/** 解析 `restore <snapshot|backup> <id>` 的位置参数（任意 --flag 顺序均可）。 */
function parseArtifactArgs(
  args: string[],
): { kind: "snapshot" | "backup"; id: string } | { kind: null; id: null } {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "snapshot" || t === "backup") {
      const id = args[i + 1];
      if (id !== undefined && !id.startsWith("--")) {
        return { kind: t, id };
      }
      return { kind: null, id: null };
    }
  }
  return { kind: null, id: null };
}

function open(args: string[]): { db: SqlDatabase; file: string } {
  const opts = parseArgs(args);
  const file = resolveStoreFile(opts);
  return { db: openStore({ file }).db, file };
}

export function cmdEvents(args: string[]): void {
  const { db, file } = open(args);
  try {
    const opts = parseArgs(args);
    const counts = eventCounts(db);
    console.log(`store file : ${file}`);
    console.log(
      `counts     : queued=${counts.queued} processing=${counts.processing} done=${counts.done} dead=${counts.dead} total=${counts.total}`,
    );
    const byType = eventCountByType(db, {
      status: opts.status,
      limit: 20,
    });
    console.log(`by type    :`);
    for (const t of byType) {
      console.log(`  ${t.eventType}: ${t.count}`);
    }
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 10));
    const rows = listEvents(db, { status: opts.status, limit });
    if (rows.length > 0) {
      console.log(`recent     :`);
      for (const r of rows) {
        console.log(
          `  ${r.status.padEnd(10)} ${r.eventType.padEnd(24)} ${r.memoryId ?? "-"} v${r.entityVersion ?? "-"} @${r.ts}`,
        );
      }
    }
  } finally {
    db.close();
  }
}

export async function cmdQueueDrain(args: string[]): Promise<void> {
  const { db, file } = open(args);
  try {
    const before = eventCounts(db);
    const worker = new DurableWorker(db, defaultWorkerConsumers(), {
      onUnhandled: "fail",
    });
    const res = await worker.drain();
    const after = eventCounts(db);
    console.log(`store file : ${file}`);
    console.log(`processed  : ${res.processed}`);
    console.log(`failed     : ${res.failed}`);
    console.log(`dead       : ${res.dead}`);
    console.log(`unhandled  : ${res.unhandled}`);
    console.log(`drained    : ${res.drained}`);
    console.log(
      `counts     : queued ${before.queued}→${after.queued}, done ${before.done}→${after.done}, dead ${before.dead}→${after.dead}`,
    );
  } finally {
    db.close();
  }
}

export function cmdConsolidate(args: string[]): void {
  const { db, file } = open(args);
  try {
    const opts = parseArgs(args);
    const raw = opts.jaccard;
    const jaccard = raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    if (opts.deep) {
      const s = runDeepConsolidation(db, { actor: "cli", minJaccard: jaccard });
      console.log(`deep consolidation at ${file}`);
      console.log(`scanned=${s.scanned} candidates=${s.candidates}`);
      console.log(`merged=${s.merged} reviewsOpened=${s.reviewsOpened} skipped=${s.skipped}`);
      console.log(`promotionCandidates=${s.promotionCandidates}`);
    } else {
      const s = runRealtimeLocalDedup(db, { actor: "cli", minJaccard: jaccard });
      console.log(`realtime dedup at ${file}`);
      console.log(`scanned=${s.scanned} candidates=${s.candidates}`);
      console.log(`merged=${s.merged} reviewsOpened=${s.reviewsOpened} skipped=${s.skipped}`);
    }
  } finally {
    db.close();
  }
}

export function cmdGeneralize(args: string[]): void {
  const { db, file } = open(args);
  try {
    const report = runGeneralization(db, { actor: "cli" });
    console.log(`generalize at ${file}`);
    console.log(`discovered=${report.discovered} registered=${report.registered} promoted=${report.promoted}`);
  } finally {
    db.close();
  }
}

export function cmdHeal(args: string[]): void {
  const { db, file } = open(args);
  try {
    const counts = eventCounts(db);
    console.log(`store file : ${file}`);
    console.log(`counts     : queued=${counts.queued} processing=${counts.processing} done=${counts.done} dead=${counts.dead}`);
    const dead = listEvents(db, { status: "dead", limit: 200 });
    console.log(`dead events: ${dead.length}`);
    if (parseArgs(args).requeue) {
      let requeued = 0;
      for (const ev of dead) {
        requeueDead(db, ev.id, "cli heal");
        requeued++;
      }
      console.log(`requeued   : ${requeued}`);
    }
  } finally {
    db.close();
  }
}

export function cmdValidate(args: string[]): void {
  const { db, file } = open(args);
  try {
    const opts = parseArgs(args);
    const run = runHygieneScan(db, { actor: "cli", dryRun: opts.dryRun });
    console.log(`store file : ${file}`);
    console.log(`run id     : ${run.runId}`);
    console.log(`dry-run    : ${run.dryRun ? "yes" : "no"}`);
    console.log(`status     : ${run.status}`);
    console.log(`scanned    : ${run.scanned}`);
    console.log(`changed    : ${run.changed}`);
    console.log(`events     : ${run.events}`);
    console.log(`skipped    : ${run.skipped}`);
  } finally {
    db.close();
  }
}

export function cmdSnapshot(args: string[]): void {
  const { db, file } = open(args);
  try {
    if (args.includes("--list")) {
      const opts = parseArgs(args);
      const limit = Number(opts.limit) || 20;
      const rows = listSnapshots(db, limit);
      console.log(`store file : ${file}`);
      console.log(`snapshots  : ${rows.length}`);
      for (const s of rows) {
        console.log(
          `  ${s.id} verified=${s.verified ? "yes" : "no"} events=${s.eventCount} memory=${s.memoryCount} @${s.createdAt}`,
        );
      }
      return;
    }
    const opts = parseArgs(args);
    const rec = createSnapshot(db, { file, note: opts.note });
    console.log(`store file : ${file}`);
    console.log(`snapshot   : ${rec.id}`);
    console.log(`path       : ${rec.path}`);
    console.log(`verified   : ${rec.verified ? "yes" : "no"}`);
    console.log(`events     : ${rec.eventCount}`);
    console.log(`memory     : ${rec.memoryCount}`);
    console.log(`checksum   : ${rec.checksum.slice(0, 16)}...`);
  } finally {
    db.close();
  }
}

export function cmdBackup(args: string[]): void {
  const { db, file } = open(args);
  try {
    if (args.includes("--list")) {
      const opts = parseArgs(args);
      const limit = Number(opts.limit) || 20;
      const rows = listBackups(db, limit);
      console.log(`store file : ${file}`);
      console.log(`backups    : ${rows.length}`);
      for (const b of rows) {
        console.log(
          `  ${b.id} verified=${b.verified ? "yes" : "no"} events=${b.eventCount} @${b.createdAt}`,
        );
      }
      return;
    }
    const opts = parseArgs(args);
    const rec = createBackup(db, { file, note: opts.note });
    console.log(`store file : ${file}`);
    console.log(`backup     : ${rec.id}`);
    console.log(`path       : ${rec.path}`);
    console.log(`verified   : ${rec.verified ? "yes" : "no"}`);
    console.log(`events     : ${rec.eventCount}`);
    console.log(`checksum   : ${rec.checksum.slice(0, 16)}...`);
  } finally {
    db.close();
  }
}

export function cmdRestore(args: string[]): void {
  const parsed = parseArtifactArgs(args);
  if (parsed.kind === null) {
    console.error("restore 需要 <snapshot|backup> <id>");
    return;
  }
  const opts = parseArgs(args);
  const { db, file } = open(args);
  let sourcePath: string | null = null;
  let expectedMemoryCount: number | undefined;
  try {
    if (parsed.kind === "snapshot") {
      const rec = getSnapshot(db, parsed.id);
      if (rec) {
        sourcePath = rec.path;
        expectedMemoryCount = rec.memoryCount;
      }
    } else {
      const rec = getBackup(db, parsed.id);
      if (rec) sourcePath = rec.path;
    }
    if (sourcePath === null) {
      console.log(`unknown ${parsed.kind}: ${parsed.id}`);
      return;
    }
  } finally {
    db.close();
  }

  const target = opts.to ?? join(dirname(file), `restored-${parsed.id}.db`);
  const result = restoreFile({
    sourcePath,
    targetFile: target,
    expectedMemoryCount,
    verifyOnly: opts.verifyOnly,
  });
  console.log(`restore    : ${result.ok ? "ok" : "FAILED"}`);
  console.log(`source     : ${result.sourcePath}`);
  console.log(
    `stage      : integrity=${result.stageVerify.integrity} schema=${result.stageVerify.schemaVersion} ` +
      `memory=${result.stageVerify.memoryCount} events=${result.stageVerify.eventCount}`,
  );
  if (result.promoted) {
    console.log(`promoted   : ${target}`);
    console.log(`previous   : ${result.previousPath ?? "-"}`);
  }
  if (opts.verifyOnly) {
    console.log(`mode       : verify-only（未落盘）`);
  }
  if (result.restoredVerify) {
    console.log(
      `restored   : integrity=${result.restoredVerify.integrity} schema=${result.restoredVerify.schemaVersion} ` +
        `memory=${result.restoredVerify.memoryCount} events=${result.restoredVerify.eventCount}`,
    );
  }
  for (const w of result.warnings) {
    console.log(`warning    : ${w}`);
  }
  if (result.error) {
    console.log(`error      : ${result.error}`);
  }
}

export function cmdReplay(args: string[]): void {
  const { db, file } = open(args);
  try {
    const opts = parseArgs(args);
    const mdRoot = (() => {
      const i = args.indexOf("--rebuild-md");
      return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
    })();
    const report = runReplay(db, {
      dryRun: opts.dryRun,
      rebuildMarkdown: !opts.dryRun && mdRoot !== undefined,
      mdRoot,
      actor: "cli",
    });
    console.log(`store file : ${file}`);
    console.log(`mode       : ${report.mode}`);
    console.log(`scanned    : ${report.scanned}`);
    console.log(`processed  : ${report.processed}`);
    console.log(`failures   : ${report.failures}`);
    console.log(`status     : ${report.status}`);
    if (report.mdFileCount !== null) {
      console.log(`md files   : ${report.mdFileCount}`);
    }
    if (report.error) {
      console.log(`error      : ${report.error}`);
    }
  } finally {
    db.close();
  }
}

export function cmdVerify(args: string[]): void {
  const target = args.find((a) => !a.startsWith("--"));
  if (target === undefined) {
    console.error("verify 需要 <file>");
    return;
  }
  const v = verifySqliteFile(target);
  console.log(`file       : ${target}`);
  console.log(`ok         : ${v.ok ? "yes" : "no"}`);
  console.log(`integrity  : ${v.integrity}`);
  console.log(`schema     : ${v.schemaVersion}`);
  console.log(`memory     : ${v.memoryCount}`);
  console.log(`events     : ${v.eventCount}`);
  console.log(`size       : ${v.sizeBytes}`);
  if (v.error) {
    console.log(`error      : ${v.error}`);
  }
}
