import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store/db.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import {
  insertMemoryItem,
  listMemoryItems,
} from "../src/store/repository.js";
import { openSqlite } from "../src/store/sqlite.js";

describe("structured memory store", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-test-"));
    file = path.join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies migrations and reports schema version", () => {
    const store = openStore({ file });
    try {
      expect(["better-sqlite3", "node:sqlite"]).toContain(store.driver);
      const tables = (
        store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((t) => t.name);
      for (const t of [
        "schema_migrations",
        "documents",
        "chunks",
        "memory_items",
        "memory_evidence",
        "memory_lineage",
        "audit_log",
        "events",
      ]) {
        expect(tables).toContain(t);
      }
      const ver = store.db
        .prepare("SELECT MAX(version) AS v FROM schema_migrations")
        .get() as { v: number };
      expect(ver.v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    } finally {
      store.db.close();
    }
  });

  it("migration body 幂等：同一库上二次 up() 不因对象已存在而报错", () => {
    // 回归取证：真实库曾因更早一次非事务运行留下对象、schema_migrations 无记录，
    // 后续任何 migrate 都在 up() 内以 “index idx_evidence_memory already exists” 中断。
    const raw = openSqlite(file);
    try {
      MIGRATIONS[0]!.up(raw.db);
      expect(() => MIGRATIONS[0]!.up(raw.db)).not.toThrow();
    } finally {
      raw.db.close();
    }
    const store = openStore({ file });
    try {
      const ver = store.db
        .prepare("SELECT MAX(version) AS v FROM schema_migrations")
        .get() as { v: number };
      expect(ver.v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    } finally {
      store.db.close();
    }
  });

  it("残留对象库可恢复：DDL 已提交但 schema_migrations 无记录时，migrate 补齐版本且保留既有数据", () => {
    // 构造与真实中断一致的取证场景：对象已提交、无版本记录、带既有行。
    const raw = openSqlite(file);
    try {
      MIGRATIONS[0]!.up(raw.db);
    } finally {
      raw.db.close();
    }
    const seeded = openSqlite(file);
    try {
      seeded.db
        .prepare(
          `INSERT INTO memory_items (id,type,scope,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          "residual-1",
          "personal",
          "global",
          "残留库里的既有记忆",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        );
    } finally {
      seeded.db.close();
    }

    const store = openStore({ file });
    try {
      const ver = store.db
        .prepare("SELECT MAX(version) AS v FROM schema_migrations")
        .get() as { v: number };
      expect(ver.v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
      const rows = listMemoryItems(store.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("residual-1");
      expect(rows[0]!.content).toBe("残留库里的既有记忆");
    } finally {
      store.db.close();
    }
    // 关闭后再次打开仍正常（迁移已落记录，进入 early-return 幂等路径）
    const reopened = openStore({ file });
    try {
      expect(listMemoryItems(reopened.db)).toHaveLength(1);
    } finally {
      reopened.db.close();
    }
  });

  it("persists a memory item with Q104 orthogonal states", () => {
    const store = openStore({ file });
    try {
      const row = insertMemoryItem(store.db, {
        type: "experience",
        scope: "project",
        projectId: "proj-1",
        content: "修复 sqlite-vec 原生加载失败：改用 better-sqlite3 扩展加载。",
        sourceKind: "explicit",
        confidence: 0.9,
        importance: "high",
        experiencePhase: "solution-found",
        temporalState: "current",
      });
      expect(row.id).toBeTruthy();
      expect(row.experiencePhase).toBe("solution-found");
      expect(row.temporalState).toBe("current");
      expect(row.lifecycleStatus).toBeNull();
      expect(row.userEdited).toBe(0);

      const audit = store.db
        .prepare(
          "SELECT COUNT(*) AS c FROM audit_log WHERE entity_type='memory_item'",
        )
        .get() as { c: number };
      expect(audit.c).toBe(1);

      const all = listMemoryItems(store.db);
      expect(all).toHaveLength(1);
    } finally {
      store.db.close();
    }
  });

  it("enforces enum constraints (bad temporal_state rejected)", () => {
    const store = openStore({ file });
    try {
      const stmt = store.db.prepare(`
        INSERT INTO memory_items
          (id,type,scope,content,importance,confidence,source_kind,temporal_state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `);
      expect(() =>
        stmt.run(
          "x",
          "personal",
          "global",
          "c",
          "normal",
          0.5,
          "derived",
          "not-a-state",
          new Date().toISOString(),
          new Date().toISOString(),
        ),
      ).toThrow();
    } finally {
      store.db.close();
    }
  });
});
