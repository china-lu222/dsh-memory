import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { openSqlite, type SqlDatabase } from "../store/sqlite.js";

export interface EventWaterMark {
  id: string;
  ts: string;
}

export interface StoreMeta {
  schemaVersion: number;
  memoryCount: number;
  eventCount: number;
  eventHighWater: EventWaterMark | null;
}

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  schemaVersion: number;
  memoryCount: number;
  eventCount: number;
  sizeBytes: number;
  error?: string;
}

function quoteLiteral(p: string): string {
  return "'" + p.replace(/'/g, "''") + "'";
}

function countOf(db: SqlDatabase, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

/** 读取库的一致性元数据（schema 版本 / 记忆数 / 事件数 / 事件高水位）。 */
export function readStoreMeta(db: SqlDatabase): StoreMeta {
  const schemaVersion = Number(
    (
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
        v: number | null;
      }
    ).v ?? 0,
  );
  const last = db
    .prepare("SELECT id, ts FROM events ORDER BY rowid DESC LIMIT 1")
    .get() as { id: string; ts: string } | undefined;
  return {
    schemaVersion,
    memoryCount: countOf(db, "memory_items"),
    eventCount: countOf(db, "events"),
    eventHighWater: last ? { id: last.id, ts: last.ts } : null,
  };
}

/** 一致性拷贝：VACUUM INTO 产出独立、无半写状态的一致性库文件（WAL 安全）。 */
export function consistentCopyInto(db: SqlDatabase, destFile: string): void {
  db.exec(`VACUUM INTO ${quoteLiteral(destFile)}`);
}

export function sha256File(file: string): string {
  const data = readFileSync(file);
  return createHash("sha256").update(data).digest("hex");
}

export function fileSizeBytes(file: string): number {
  return statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

/** 只读打开文件做 integrity/schema 校验（不迁移，不写主库）。 */
export function verifySqliteFile(file: string): VerifyResult {
  try {
    const { db } = openSqlite(file);
    try {
      const rows = db.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check: string;
      }>;
      const integrity = rows.map((r) => String(r.integrity_check)).join("; ");
      const meta = readStoreMeta(db);
      const ok = integrity === "ok" && meta.schemaVersion >= 1;
      return {
        ok,
        integrity,
        schemaVersion: meta.schemaVersion,
        memoryCount: meta.memoryCount,
        eventCount: meta.eventCount,
        sizeBytes: fileSizeBytes(file),
        ...(ok ? {} : { error: integrity }),
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ok: false,
      integrity: "cannot-open",
      schemaVersion: 0,
      memoryCount: 0,
      eventCount: 0,
      sizeBytes: 0,
      error: (err as Error).message,
    };
  }
}
