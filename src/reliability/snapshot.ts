import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SqlDatabase } from "../store/sqlite.js";
import { writeTelemetry } from "../store/telemetry.js";
import {
  consistentCopyInto,
  fileSizeBytes,
  readStoreMeta,
  sha256File,
  verifySqliteFile,
} from "./common.js";

export interface SnapshotRecord {
  id: string;
  kind: string;
  path: string;
  sourcePath: string;
  schemaVersion: number;
  memoryCount: number;
  eventCount: number;
  highWater: string | null;
  checksum: string;
  sizeBytes: number;
  verified: boolean;
  note: string | null;
  createdAt: string;
}

export interface SnapshotOptions {
  /** 主库文件路径（注册 source_path 用）。 */
  file: string;
  /** 快照目录；缺省为 <db 目录>/snapshots。 */
  dir?: string;
  note?: string;
}

function defaultSnapshotsDir(file: string): string {
  return join(dirname(file), "snapshots");
}

function newId(): string {
  return `snap_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

/** 创建一致性快照：VACUUM INTO → checksum/verify → 登记清单。 */
export function createSnapshot(db: SqlDatabase, opts: SnapshotOptions): SnapshotRecord {
  const dir = opts.dir ?? defaultSnapshotsDir(opts.file);
  mkdirSync(dir, { recursive: true });
  const id = newId();
  const dest = join(dir, `${id}.db`);
  const meta = readStoreMeta(db);
  consistentCopyInto(db, dest);
  const checksum = sha256File(dest);
  const sizeBytes = fileSizeBytes(dest);
  const verified = verifySqliteFile(dest);
  const createdAt = new Date().toISOString();
  const highWater = meta.eventHighWater
    ? JSON.stringify(meta.eventHighWater)
    : null;
  db.prepare(
    `INSERT INTO snapshots
       (snapshot_id, kind, path, source_path, event_count, event_high_water, size_bytes,
        verified, note, created_at, schema_version, checksum, memory_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "full",
    dest,
    opts.file,
    meta.eventCount,
    highWater,
    sizeBytes,
    verified.ok ? 1 : 0,
    opts.note ?? null,
    createdAt,
    meta.schemaVersion,
    checksum,
    meta.memoryCount,
  );
  writeTelemetry(db, {
    kind: "lifecycle",
    key: "snapshot.created",
    value: { id, verified: verified.ok, eventCount: meta.eventCount },
  });
  return toRecord(db, id);
}

function toRecord(db: SqlDatabase, id: string): SnapshotRecord {
  const row = db
    .prepare(
      `SELECT snapshot_id AS id, kind, path, source_path AS sourcePath, event_count AS eventCount,
              event_high_water AS highWater, size_bytes AS sizeBytes, verified,
              note, created_at AS createdAt, schema_version AS schemaVersion,
              checksum, memory_count AS memoryCount
       FROM snapshots WHERE snapshot_id = ?`,
    )
    .get(id) as Record<string, unknown>;
  return normalize(row);
}

function normalize(row: Record<string, unknown>): SnapshotRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    path: String(row.path),
    sourcePath: String(row.sourcePath),
    schemaVersion: Number(row.schemaVersion ?? 0),
    memoryCount: Number(row.memoryCount ?? 0),
    eventCount: Number(row.eventCount ?? 0),
    highWater: row.highWater === null || row.highWater === undefined
      ? null
      : String(row.highWater),
    checksum: row.checksum === null || row.checksum === undefined
      ? ""
      : String(row.checksum),
    sizeBytes: Number(row.sizeBytes ?? 0),
    verified: Number(row.verified) === 1,
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdAt: String(row.createdAt),
  };
}

export function listSnapshots(db: SqlDatabase, limit = 50): SnapshotRecord[] {
  const rows = db
    .prepare(
      `SELECT snapshot_id AS id, kind, path, source_path AS sourcePath, event_count AS eventCount,
              event_high_water AS highWater, size_bytes AS sizeBytes, verified,
              note, created_at AS createdAt, schema_version AS schemaVersion,
              checksum, memory_count AS memoryCount
       FROM snapshots ORDER BY created_at DESC, snapshot_id DESC LIMIT ?`,
    )
    .all(String(Math.max(1, Math.min(500, limit)))) as Array<Record<string, unknown>>;
  return rows.map(normalize);
}

export function getSnapshot(db: SqlDatabase, id: string): SnapshotRecord | null {
  const row = db
    .prepare(
      `SELECT snapshot_id AS id, kind, path, source_path AS sourcePath, event_count AS eventCount,
              event_high_water AS highWater, size_bytes AS sizeBytes, verified,
              note, created_at AS createdAt, schema_version AS schemaVersion,
              checksum, memory_count AS memoryCount
       FROM snapshots WHERE snapshot_id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? normalize(row) : null;
}
