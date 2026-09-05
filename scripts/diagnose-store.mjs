#!/usr/bin/env node
/**
 * dsh-memory — 真实库只读诊断（取证用，绝不修改源库）。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/diagnose-store.mjs <db-file> [--json <out.json>]
 *
 * 行为：
 *  1. 先把源库（连同 -wal / -shm / -journal 伴随文件，若有）复制到系统临时目录；
 *  2. 只对临时副本执行查询（integrity_check / tables / indexes / triggers /
 *     schema_migrations / meta / 行数 / 与 R1 v1 目标 DDL 的 schema 差异）；
 *  3. 打印人类可读报告；给定 --json 时另写一份 JSON 快照；
 *  4. 删除临时副本。源库自始至终只被读取用于复制。
 *
 * 与 R1 目标 DDL（src/store/migrations.ts v1）的差异是诊断重点：
 *  哪些目标对象缺失、哪些已存在表缺列/多列，供真实库接管前人工裁决。
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/* ---------------- R1 v1 目标 schema（与 src/store/migrations.ts 同步） ---------------- */

const TARGET_TABLES = {
  schema_migrations: ["version", "name", "applied_at"],
  documents: ["id", "uri", "kind", "title", "meta_json", "created_at", "updated_at"],
  chunks: [
    "id", "document_id", "seq", "content", "heading", "token_count", "meta_json", "created_at",
  ],
  memory_items: [
    "id", "type", "scope", "project_id", "content", "importance", "confidence", "source_kind",
    "experience_phase", "temporal_state", "lifecycle_status", "user_edited", "hidden",
    "observed_at", "valid_from", "valid_until", "last_verified_at", "last_used_at",
    "created_at", "updated_at",
  ],
  memory_evidence: [
    "id", "memory_id", "kind", "session_ref", "event_ref", "evidence_ref", "evidence_summary",
    "created_at",
  ],
  memory_lineage: ["id", "memory_id", "relation", "other_memory_id", "note", "created_at"],
  audit_log: [
    "id", "ts", "actor", "action", "entity_type", "entity_id", "before_json", "after_json",
  ],
  events: [
    "id", "ts", "event_type", "payload_json", "idempotency_key", "status", "attempts",
    "last_error",
  ],
};

const TARGET_INDEXES = {
  memory_items: ["ts_memory_scope", "ts_memory_type", "ts_memory_project", "ts_memory_phase"],
  memory_evidence: ["ts_evidence_memory"],
  memory_lineage: ["ts_lineage_memory"],
  audit_log: ["ts_audit_entity"],
  events: ["ts_events_status"],
};

/** 旧 JS 插件（legacy-js/）的表名集合；仅用于行数报告与差异摘要提示 */
const LEGACY_TABLES = new Set(["meta", "memories", "evidence", "audit", "session_runs"]);

/* ---------------- 小工具 ---------------- */

function cloneFile(source, dest) {
  if (!existsSync(source)) return false;
  copyFileSync(source, dest);
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const sourceFile = args[0];
  if (!sourceFile) {
    console.error("usage: diagnose-store.mjs <db-file> [--json <out.json>]");
    process.exit(2);
  }
  let jsonOut;
  const jsonIdx = args.indexOf("--json");
  if (jsonIdx >= 0) jsonOut = args[jsonIdx + 1];

  if (!existsSync(sourceFile)) {
    console.error(`source db not found: ${sourceFile}`);
    process.exit(1);
  }

  // 1) 复制到临时目录（含 WAL 伴随文件）
  const staging = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-diagnose-"));
  const copy = path.join(staging, path.basename(sourceFile));
  try {
    cloneFile(sourceFile, copy);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const companion = `${sourceFile}${suffix}`;
      if (existsSync(companion)) cloneFile(companion, `${copy}${suffix}`);
    }

    // 2) 只读查询
    const db = new DatabaseSync(copy);
    const report = inspect(db, sourceFile);
    db.close();

    // 3) 输出
    const text = renderText(report);
    console.log(text);
    if (jsonOut) {
      writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\n[json snapshot] ${path.resolve(jsonOut)}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function inspect(db, sourceFile) {
  const tableNames = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((r) => r.name);
  const present = new Set(tableNames);

  const integrityRows = db.prepare("PRAGMA integrity_check").all();
  const integrityFailures = integrityRows
    .map((r) => r.integrity_check)
    .filter((v) => String(v).trim() !== "ok");

  const indexes = db
    .prepare(
      `SELECT name, tbl_name FROM sqlite_master
       WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`,
    )
    .all()
    .map((r) => ({ name: r.name, table: r.tbl_name }));

  const triggers = db
    .prepare(
      `SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
    )
    .all()
    .map((r) => ({ name: r.name, table: r.tbl_name }));

  const rowsOf = (sql) =>
    db
      .prepare(sql)
      .all()
      .map((r) => Object.fromEntries(Object.entries(r)));

  const schemaMigrations = present.has("schema_migrations")
    ? rowsOf("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
    : null;
  const meta = present.has("meta")
    ? rowsOf("SELECT key, value FROM meta ORDER BY key")
    : null;

  const rowCounts = {};
  for (const t of tableNames) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get();
      rowCounts[t] = Number(r.c);
    } catch {
      rowCounts[t] = null; // 视图等无法 COUNT 时置 null
    }
  }

  // 4) 与 R1 v1 目标 DDL 的差异
  const missingTables = Object.keys(TARGET_TABLES).filter((t) => !present.has(t));
  const tableDiffs = {};
  for (const [table, expected] of Object.entries(TARGET_TABLES)) {
    if (!present.has(table)) continue;
    const actual = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((r) => r.name);
    const exp = new Set(expected);
    const act = new Set(actual);
    const missingColumns = expected.filter((c) => !act.has(c));
    const extraColumns = actual.filter((c) => !exp.has(c));
    if (missingColumns.length || extraColumns.length) {
      tableDiffs[table] = { actual: actual.length, expected: expected.length, missingColumns, extraColumns };
    }
  }
  const missingIndexes = {};
  for (const [table, expectedIdx] of Object.entries(TARGET_INDEXES)) {
    if (!present.has(table)) continue;
    const actualIdx = new Set(
      indexes.filter((i) => i.table === table).map((i) => i.name),
    );
    const missing = expectedIdx.filter((n) => !actualIdx.has(n));
    if (missing.length) missingIndexes[table] = missing;
  }

  return {
    sourceFile: path.resolve(sourceFile),
    analysisOnCopy: true,
    sqliteVersion: db.prepare("SELECT sqlite_version() AS v").get().v,
    journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
    integrityCheck: {
      ok: integrityFailures.length === 0,
      message: integrityFailures.length ? integrityFailures.join(" | ") : "ok",
    },
    tables: tableNames,
    legacyTablesPresent: tableNames.filter((t) => LEGACY_TABLES.has(t)),
    indexes,
    triggers,
    schemaMigrations,
    meta,
    rowCounts,
    diff: {
      targetTables: Object.keys(TARGET_TABLES),
      missingTables,
      missingIndexes,
      tableDiffs,
    },
  };
}

function renderText(r) {
  const out = [];
  out.push(`source        : ${r.sourceFile}`);
  out.push(`(copy-only)   : ${r.analysisOnCopy}`);
  out.push(`sqlite        : ${r.sqliteVersion} (journal_mode=${r.journalMode})`);
  out.push(`integrity     : ${r.integrityCheck.ok ? "ok" : `FAILED: ${r.integrityCheck.message}`}`);
  out.push(`tables (${r.tables.length}): ${r.tables.join(", ")}`);
  out.push(`legacy tables : ${r.legacyTablesPresent.join(", ") || "-"}`);
  out.push(`indexes       : ${r.indexes.map((i) => `${i.name}→${i.table}`).join(", ") || "-"}`);
  out.push(`triggers      : ${r.triggers.map((t) => `${t.name}→${t.table}`).join(", ") || "-"}`);
  if (r.schemaMigrations === null) {
    out.push(`migrations    : schema_migrations 表不存在`);
  } else if (r.schemaMigrations.length === 0) {
    out.push(`migrations    : schema_migrations 存在但为空（MAX(version)=0）`);
  } else {
    out.push(`migrations    : ${r.schemaMigrations.map((m) => `v${m.version} ${m.name} @ ${m.applied_at}`).join("; ")}`);
  }
  if (r.meta !== null) {
    out.push(`meta          : ${r.meta.map((kv) => `${kv.key}=${kv.value}`).join(", ") || "(空)"}`);
  }
  out.push(`row counts    : ${Object.entries(r.rowCounts).map(([t, n]) => `${t}=${n}`).join(", ") || "-"}`);
  out.push(`--- R1 v1 schema 差异 ---`);
  out.push(`missing tables: ${r.diff.missingTables.join(", ") || "-"}`);
  out.push(`missing idx   : ${Object.entries(r.diff.missingIndexes).map(([t, ix]) => `${t}: ${ix.join(", ")}`).join("; ") || "-"}`);
  if (Object.keys(r.diff.tableDiffs).length === 0) {
    out.push(`table diffs   : 现有目标表列与 R1 v1 DDL 一致`);
  } else {
    for (const [t, d] of Object.entries(r.diff.tableDiffs)) {
      out.push(
        `table ${t} diff: actual=${d.actual}, expected=${d.expected}` +
          (d.missingColumns.length ? `; missing=[${d.missingColumns.join(", ")}]` : "") +
          (d.extraColumns.length ? `; extra=[${d.extraColumns.join(", ")}]` : ""),
      );
    }
  }
  return out.join("\n");
}

main();
