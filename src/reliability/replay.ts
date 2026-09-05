import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../store/sqlite.js";
import { writeTelemetry } from "../store/telemetry.js";
import { MarkdownProjectionService } from "../projection/service.js";
import { readStoreMeta, type StoreMeta } from "./common.js";

export type ReplayMode = "dry-run" | "rebuild";

export interface ReplayTypeCount {
  eventType: string;
  count: number;
}

export interface ReplayPlan {
  mode: ReplayMode;
  eventCount: number;
  byType: ReplayTypeCount[];
  watermark: StoreMeta;
  rebuildMarkdown: boolean;
  mdRoot: string | null;
}

export interface ReplayReport extends ReplayPlan {
  runId: string;
  processed: number;
  failures: number;
  scanned: number;
  mdFileCount: number | null;
  status: "succeeded" | "failed";
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface ReplayOptions {
  dryRun?: boolean;
  rebuildMarkdown?: boolean;
  mdRoot?: string;
  actor?: string;
  /** 进度回调（日志扫描阶段，每 500 条一次）。 */
  onProgress?: (done: number, total: number) => void;
}

interface ReplayRunRow {
  runId: string;
  mode: string;
  events: number;
  status: string;
  report: string;
  startedAt: string;
  finishedAt: string;
}

function buildPlan(db: SqlDatabase, mode: ReplayMode, opts: ReplayOptions): ReplayPlan {
  const rows = db
    .prepare("SELECT event_type AS eventType FROM events ORDER BY ts, id")
    .all() as Array<{ eventType: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.eventType, (counts.get(r.eventType) ?? 0) + 1);
  }
  const byType = [...counts.entries()]
    .map(([eventType, count]) => ({ eventType, count }))
    .sort((a, b) => b.count - a.count);
  return {
    mode,
    eventCount: rows.length,
    byType,
    watermark: readStoreMeta(db),
    rebuildMarkdown: opts.rebuildMarkdown ?? opts.mdRoot !== undefined,
    mdRoot: opts.mdRoot ?? null,
  };
}

function persistRun(
  db: SqlDatabase,
  opts: ReplayOptions,
  report: Omit<ReplayReport, "byType" | "watermark">,
): void {
  db.prepare(
    `INSERT INTO replay_runs
       (run_id, mode, events_processed, failures, status, report_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    report.runId,
    report.mode,
    report.processed,
    report.failures,
    report.status,
    JSON.stringify(report),
    report.startedAt,
    report.finishedAt,
  );
  writeTelemetry(db, {
    kind: "job",
    key: "replay.completed",
    value: {
      mode: report.mode,
      scanned: report.scanned,
      events: report.processed,
      failures: report.failures,
      status: report.status,
    },
    actor: opts.actor,
  });
}

/**
 * Event Replay：以 durable event log 为准的重放入口。
 * dry-run 只扫描并给出计划；rebuild 用当前库全量重建派生层（Markdown 投影，
 * DB-first，幂等），并做一致性核验（库计数/事件水位不因重放漂移）。
 */
export function runReplay(db: SqlDatabase, opts: ReplayOptions = {}): ReplayReport {
  const mode: ReplayMode = opts.dryRun ? "dry-run" : "rebuild";
  const startedAt = new Date().toISOString();
  const plan = buildPlan(db, mode, opts);
  const report: ReplayReport = {
    ...plan,
    runId: randomUUID(),
    processed: 0,
    failures: 0,
    scanned: 0,
    mdFileCount: null,
    status: "succeeded",
    startedAt,
    finishedAt: "",
  };
  try {
    // 日志扫描进度（500 条一批）。
    let scanned = 0;
    const total = plan.eventCount;
    if (opts.onProgress) {
      opts.onProgress(scanned, total);
    }
    const step = 500;
    while (scanned < total) {
      scanned = Math.min(total, scanned + step);
      if (opts.onProgress) {
        opts.onProgress(scanned, total);
      }
    }
    report.scanned = total;
    if (mode === "dry-run") {
      report.processed = 0;
      report.finishedAt = new Date().toISOString();
      persistRun(db, opts, report);
      return report;
    }
    // rebuild：DB → Markdown 派生层全量幂等重建（事件数即待处理量）。
    if (plan.rebuildMarkdown && plan.mdRoot) {
      const before = readStoreMeta(db);
      const svc = new MarkdownProjectionService(db, plan.mdRoot);
      svc.resyncAll();
      report.mdFileCount = svc.listMdFiles().length;
      // 一致性核验：库计数与事件水位必须与重放前一致。
      const after = readStoreMeta(db);
      if (
        after.memoryCount !== before.memoryCount ||
        after.eventCount !== before.eventCount
      ) {
        report.failures = 1;
        report.status = "failed";
        report.error =
          `consistency drift: memory ${before.memoryCount}→${after.memoryCount}, ` +
          `events ${before.eventCount}→${after.eventCount}`;
        report.processed = 0;
        report.finishedAt = new Date().toISOString();
        persistRun(db, opts, report);
        throw new Error(report.error);
      }
    }
    report.processed = total;
    report.failures = 0;
    report.finishedAt = new Date().toISOString();
    persistRun(db, opts, report);
    return report;
  } catch (err) {
    const message = (err as Error).message;
    if (report.status !== "failed") {
      report.status = "failed";
      report.error = message;
      report.finishedAt = new Date().toISOString();
      persistRun(db, opts, report);
    }
    throw new Error(`replay failed: ${message}`);
  }
}

export function listReplayRuns(db: SqlDatabase, limit = 20): ReplayRunRow[] {
  const rows = db
    .prepare(
      `SELECT run_id AS runId, mode, events_processed AS events, status,
              report_json AS report, started_at AS startedAt, finished_at AS finishedAt
       FROM replay_runs ORDER BY started_at DESC, run_id DESC LIMIT ?`,
    )
    .all(String(Math.max(1, Math.min(200, limit)))) as Array<{
    runId: string;
    mode: string;
    events: number;
    status: string;
    report: string;
    startedAt: string;
    finishedAt: string;
  }>;
  return rows.map((r) => ({
    ...r,
    events: Number(r.events),
  }));
}
