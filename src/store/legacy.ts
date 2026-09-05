import { existsSync } from "node:fs";
import path from "node:path";
import type { SqlDatabase } from "./sqlite.js";

/**
 * 旧版 JS 插件（legacy-js/）存储库的“同文件升级、安全迁移”（决策 B）。
 *
 * 原则：
 *  - 不创建第二个正式 DB，也不 rm+重建；TS Store 直接在原 memory.db 上建新 schema。
 *  - 旧表（meta/memories/evidence/audit/session_runs）永不删除，保留为无损回滚底版；
 *    TS schema（schema_migrations 驱动）与旧表名无交集，可安全共存。
 *  - 写任何 DDL 之前：备份（VACUUM INTO → <file>.pre-ts-r1.backup，仅首次创建）→
 *    integrity_check → 记录 schema_version 与旧表行数；失败即中止，禁止继续迁移。
 *  - 迁移后校验：旧表行数不变 + 新 schema 关键表存在；否则抛出并回滚语义留给操作者
 *    （DB 本身可随时由备份或旧表恢复）。
 */

export const LEGACY_BACKUP_SUFFIX = ".pre-ts-r1.backup";

/** 旧 JS 插件建的表（白名单：行数校验只针对这些表，防注入） */
const LEGACY_TABLES = ["memories", "evidence", "audit", "session_runs"] as const;

/** TS schema 关键表（迁移后校验用） */
const TS_CORE_TABLES = [
  "schema_migrations",
  "memory_items",
  "memory_evidence",
  "memory_lineage",
  "audit_log",
  "events",
] as const;

export interface LegacyTakeoverReport {
  /** 文件是否含旧插件存储（以 memories 表为信号） */
  detected: boolean;
  /** 旧 meta.schema_version（存在时） */
  schemaVersion?: number;
  /** integrity_check 是否通过 */
  integrityOk: boolean;
  integrityMessage: string;
  /** 备份文件路径（detected 时给出；可能已存在而本轮未重建） */
  backupPath?: string;
  backupCreated: boolean;
  legacyTables: string[];
  legacyRowCounts: Record<string, number>;
}

/** 当前文件里所有用户表名（不含 sqlite_* 内部表） */
export function tableNamesOf(db: SqlDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** 旧插件表（交集过滤） */
export function legacyTablesOf(db: SqlDatabase): string[] {
  const names = new Set(tableNamesOf(db));
  return LEGACY_TABLES.filter((t) => names.has(t));
}

/** 旧插件存储信号：memories 表存在 */
export function isLegacyStore(db: SqlDatabase): boolean {
  return legacyTablesOf(db).includes("memories");
}

/** 读取旧 meta.schema_version（无 meta 表或无该键时返回 undefined） */
export function legacySchemaVersionOf(db: SqlDatabase): number | undefined {
  const names = new Set(tableNamesOf(db));
  if (!names.has("meta")) return undefined;
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: unknown } | undefined;
  if (row === undefined) return undefined;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : undefined;
}

/** integrity_check 结果；ok 表示全部通过，否则 message 汇总失败明细 */
export function integrityOf(db: SqlDatabase): {
  ok: boolean;
  message: string;
} {
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check: string;
  }>;
  const bad = rows.filter((r) => String(r.integrity_check).trim() !== "ok");
  if (bad.length === 0) return { ok: true, message: "ok" };
  return {
    ok: false,
    message: bad.map((r) => String(r.integrity_check)).join(" | "),
  };
}

/** 旧插件表行数快照（只统计实际存在的表） */
export function legacyRowCounts(db: SqlDatabase): Record<string, number> {
  const names = new Set(tableNamesOf(db));
  const out: Record<string, number> = {};
  for (const t of LEGACY_TABLES) {
    if (!names.has(t)) continue;
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM ${t}`)
      .get() as { c: number };
    out[t] = Number(row.c);
  }
  return out;
}

/** SQL 字符串字面量转义（备份路径） */
function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/**
 * 为旧文件创建一次性备份：`<file>.pre-ts-r1.backup`（VACUUM INTO 一致性快照）。
 * 目标已存在则不重建，返回 created=false。
 */
export function createLegacyBackup(
  db: SqlDatabase,
  file: string,
): { backupPath: string; created: boolean } {
  const backupPath = `${path.resolve(file)}${LEGACY_BACKUP_SUFFIX}`;
  if (existsSync(backupPath)) {
    return { backupPath, created: false };
  }
  db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  return { backupPath, created: true };
}

/**
 * 在写任何 TS DDL 前执行的安全接管（备份 + integrity + 记录 schema_version/行数）。
 * 非旧库直接返回 detected=false。integrity 失败会抛错，绝不继续迁移。
 */
export function runLegacyTakeover(
  db: SqlDatabase,
  file: string,
): LegacyTakeoverReport {
  const legacyTables = legacyTablesOf(db);
  const detected = legacyTables.includes("memories");
  const integrity = integrityOf(db);
  if (!detected) {
    return {
      detected: false,
      integrityOk: integrity.ok,
      integrityMessage: integrity.message,
      legacyTables,
      legacyRowCounts: {},
      backupCreated: false,
    };
  }
  if (!integrity.ok) {
    throw new Error(
      `旧库 integrity_check 未通过（${path.resolve(file)}）：${integrity.message}` +
        `。请先用已有备份恢复，禁止继续迁移（未做任何修改）。`,
    );
  }
  const backup = createLegacyBackup(db, file);
  return {
    detected: true,
    schemaVersion: legacySchemaVersionOf(db),
    integrityOk: true,
    integrityMessage: "ok",
    backupPath: backup.backupPath,
    backupCreated: backup.created,
    legacyTables,
    legacyRowCounts: legacyRowCounts(db),
  };
}

/** 迁移后校验：旧表行数不变且 TS 关键表齐全 */
export function validateTakeover(
  db: SqlDatabase,
  before: LegacyTakeoverReport,
): void {
  if (!before.detected) return;
  const after = legacyRowCounts(db);
  for (const t of Object.keys(before.legacyRowCounts)) {
    if (after[t] !== before.legacyRowCounts[t]) {
      throw new Error(
        `旧表 ${t} 行数在迁移后发生变化（${before.legacyRowCounts[t]} → ${after[t]}）` +
          `，迁移未保持旧数据无损，已中止。`,
      );
    }
  }
  const names = new Set(tableNamesOf(db));
  const missing = TS_CORE_TABLES.filter((t) => !names.has(t));
  if (missing.length > 0) {
    throw new Error(
      `TS schema 关键表缺失：${missing.join(", ")}。可用备份恢复后重试。`,
    );
  }
}
