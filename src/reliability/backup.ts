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

export interface BackupRecord {
  id: string;
  kind: string;
  path: string;
  sourcePath: string;
  schemaVersion: number;
  eventCount: number;
  highWater: string | null;
  checksum: string;
  sizeBytes: number;
  verified: boolean;
  note: string | null;
  createdAt: string;
}

export interface BackupOptions {
  file: string;
  dir?: string;
  note?: string;
}

function defaultBackupsDir(file: string): string {
  return join(dirname(file), "backups");
}

/** 创建一致性备份（保留原库不动）：VACUUM INTO → checksum/verify → 登记。 */
export function createBackup(db: SqlDatabase, opts: BackupOptions): BackupRecord {
  const dir = opts.dir ?? defaultBackupsDir(opts.file);
  mkdirSync(dir, { recursive: true });
  const id = `bk_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const dest = join(dir, `${id}.db`);
  const meta = readStoreMeta(db);
  consistentCopyInto(db, dest);
  const checksum = sha256File(dest);
  const sizeBytes = fileSizeBytes(dest);
  const verified = verifySqliteFile(dest);
  const createdAt = new Date().toISOString();
  const highWater = meta.eventHighWater ? JSON.stringify(meta.eventHighWater) : null;
  db.prepare(
    `INSERT INTO backups
       (backup_id, kind, path, source_path, schema_version, size_bytes, checksum,
        verified, note, created_at, event_count, event_high_water)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "full",
    dest,
    opts.file,
    meta.schemaVersion,
    sizeBytes,
    checksum,
    verified.ok ? 1 : 0,
    opts.note ?? null,
    createdAt,
    meta.eventCount,
    highWater,
  );
  writeTelemetry(db, {
    kind: "lifecycle",
    key: "backup.created",
    value: { id, verified: verified.ok },
  });
  return toRecord(db, id);
}

interface BackupRow extends Record<string, unknown> {}

function toRecord(db: SqlDatabase, id: string): BackupRecord {
  return normalize(
    db
      .prepare(
        `SELECT backup_id AS id, kind, path, source_path AS sourcePath, schema_version AS schemaVersion,
                event_count AS eventCount, event_high_water AS highWater,
                checksum, size_bytes AS sizeBytes, verified, note,
                created_at AS createdAt
         FROM backups WHERE backup_id = ?`,
      )
      .get(id) as BackupRow,
  );
}

function normalize(row: BackupRow): BackupRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    path: String(row.path),
    sourcePath: String(row.sourcePath),
    schemaVersion: Number(row.schemaVersion ?? 0),
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

export function listBackups(db: SqlDatabase, limit = 50): BackupRecord[] {
  const rows = db
    .prepare(
      `SELECT backup_id AS id, kind, path, source_path AS sourcePath, schema_version AS schemaVersion,
              event_count AS eventCount, event_high_water AS highWater, checksum,
              size_bytes AS sizeBytes, verified, note, created_at AS createdAt
       FROM backups ORDER BY created_at DESC, backup_id DESC LIMIT ?`,
    )
    .all(String(Math.max(1, Math.min(500, limit)))) as BackupRow[];
  return rows.map(normalize);
}

export function getBackup(db: SqlDatabase, id: string): BackupRecord | null {
  const row = db
    .prepare(
      `SELECT backup_id AS id, kind, path, source_path AS sourcePath, schema_version AS schemaVersion,
              event_count AS eventCount, event_high_water AS highWater, checksum,
              size_bytes AS sizeBytes, verified, note, created_at AS createdAt
       FROM backups WHERE backup_id = ?`,
    )
    .get(id) as BackupRow | undefined;
  return row ? normalize(row) : null;
}
