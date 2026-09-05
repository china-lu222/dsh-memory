/**
 * benchmark_runs 表（schema migration v8）的读写。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import type { BenchmarkReport, BenchmarkRunRecord } from "./types.js";

/** 将一次运行持久化为一行（时间/配置/结果分列存储）。 */
export function insertBenchmarkRun(db: SqlDatabase, report: BenchmarkReport): void {
  const summary = {
    runId: report.runId,
    status: report.status,
    scenarios: report.scenarios.map((s) => ({ name: s.name, status: s.status })),
  };
  db.prepare(
    `INSERT INTO benchmark_runs
       (run_id, kind, config_json, results_json, summary_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    report.runId,
    report.kind,
    JSON.stringify(report.config),
    JSON.stringify(report.scenarios),
    JSON.stringify(summary),
    report.startedAt,
    report.finishedAt,
  );
}

/** 最近 N 次运行的记录（按时间倒序）。 */
export function listBenchmarkRuns(
  db: SqlDatabase,
  limit = 10,
): Array<{ run_id: string; kind: string; status: string; started_at: string }> {
  const rows = db
    .prepare(
      `SELECT run_id, kind, summary_json AS summary, started_at
       FROM benchmark_runs
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ run_id: string; kind: string; summary: string; started_at: string }>;
  return rows.map((r) => {
    let status = "unknown";
    try {
      const parsed = JSON.parse(r.summary) as { status?: string };
      status = parsed.status ?? "unknown";
    } catch {
      // 空/损坏的 summary 不影响列表。
    }
    return { run_id: r.run_id, kind: r.kind, status, started_at: r.started_at };
  });
}

export type { BenchmarkRunRecord };
