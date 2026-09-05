import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "./sqlite.js";

export interface TelemetryRow {
  id: string;
  ts: string;
  kind: string;
  key: string;
  value_json: string;
  actor: string;
}

export interface TelemetryEntry {
  /** 类别：budget / retrieval / lifecycle / worker / job。 */
  kind: string;
  key: string;
  value: unknown;
  actor?: string;
}

export interface TelemetryStats {
  rows: number;
  byKind: Array<{ kind: string; count: number }>;
}

/** 写入一条遥测（预算/检索档位/生命周期等；供调试与一致性证据）。 */
export function writeTelemetry(
  db: SqlDatabase,
  entry: TelemetryEntry,
  ts?: string,
): string {
  const id = randomUUID();
  const at = ts ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO telemetry (id, ts, kind, key, value_json, actor) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, at, entry.kind, entry.key, JSON.stringify(entry.value ?? {}), entry.actor ?? "system");
  return id;
}

export function listTelemetry(
  db: SqlDatabase,
  opts: { kind?: string; limit?: number } = {},
): TelemetryRow[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const params: Array<string> = [];
  let sql = "SELECT id, ts, kind, key, value_json, actor FROM telemetry";
  if (opts.kind !== undefined) {
    sql += " WHERE kind = ?";
    params.push(opts.kind);
  }
  sql += " ORDER BY ts DESC, id DESC LIMIT ?";
  params.push(String(limit));
  return db.prepare(sql).all(...params) as unknown as TelemetryRow[];
}

export function telemetryStats(db: SqlDatabase): TelemetryStats {
  const rows = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM telemetry").get() as { c: number }).c,
  );
  const byKind = db
    .prepare(
      "SELECT kind, COUNT(*) AS count FROM telemetry GROUP BY kind ORDER BY count DESC",
    )
    .all() as Array<{ kind: string; count: number }>;
  return { rows, byKind };
}
