import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * SQLite 驱动适配层（Q107）。
 * 主实现：better-sqlite3；备用：Node 内建 node:sqlite（Node ≥22.5 / 24）。
 * 选择逻辑显式（状态可诊断，见 driverNote），不做静默替换。
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Array<Record<string, unknown>>;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export type StoreDriverName = "better-sqlite3" | "node:sqlite";

export interface OpenedStore {
  db: SqlDatabase;
  driver: StoreDriverName;
  driverNote: string;
}

const require = createRequire(import.meta.url);

/* ---------------- better-sqlite3 适配 ---------------- */

class BetterStmt implements SqlStatement {
  constructor(private readonly stmt: import("better-sqlite3").Statement) {}
  run(...params: SqlValue[]): SqlRunResult {
    return this.stmt.run(...params) as unknown as SqlRunResult;
  }
  get(...params: SqlValue[]): Record<string, unknown> | undefined {
    const r = this.stmt.get(...params);
    return r === undefined ? undefined : (r as Record<string, unknown>);
  }
  all(...params: SqlValue[]): Array<Record<string, unknown>> {
    return this.stmt.all(...params) as Array<Record<string, unknown>>;
  }
}

class BetterDb implements SqlDatabase {
  constructor(private readonly raw: import("better-sqlite3").Database) {}
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  prepare(sql: string): SqlStatement {
    return new BetterStmt(this.raw.prepare(sql));
  }
  close(): void {
    this.raw.close();
  }
}

/* ---------------- node:sqlite 适配（显式备用） ---------------- */
// node:sqlite 的构造器为 private/experimental，宽松类型化以避免版本差异。

interface RawStmt {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface RawSync {
  exec(sql: string): void;
  prepare(sql: string): RawStmt;
  close(): void;
}

class NodeSqliteStmt implements SqlStatement {
  constructor(private readonly stmt: RawStmt) {}
  run(...params: SqlValue[]): SqlRunResult {
    const r = this.stmt.run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  get(...params: SqlValue[]): Record<string, unknown> | undefined {
    const r = this.stmt.get(...params);
    return r === undefined ? undefined : (r as Record<string, unknown>);
  }
  all(...params: SqlValue[]): Array<Record<string, unknown>> {
    return this.stmt.all(...params) as Array<Record<string, unknown>>;
  }
}

class NodeSqliteDb implements SqlDatabase {
  constructor(private readonly raw: RawSync) {}
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  prepare(sql: string): SqlStatement {
    return new NodeSqliteStmt(this.raw.prepare(sql));
  }
  close(): void {
    this.raw.close();
  }
}

/* ---------------- 驱动加载与选择 ---------------- */

function tryLoadBetterSqlite3(file: string): BetterDb {
  const Ctor = require("better-sqlite3") as new (
    path: string,
  ) => import("better-sqlite3").Database;
  return new BetterDb(new Ctor(file));
}

function tryLoadNodeSqlite(file: string): NodeSqliteDb {
  // node:sqlite 的 DatabaseSync 构造器为 private/experimental，经类型断言构造。
  const mod = require("node:sqlite") as {
    DatabaseSync: new (path: string) => RawSync;
  };
  return new NodeSqliteDb(new mod.DatabaseSync(file));
}

/**
 * 打开存储库。返回 OpenedStore（含实际驱动名与说明）。
 * 规则（Q107/Q105）：
 *  - DSH_MEMORY_SQLITE_DRIVER=better-sqlite3|node:sqlite|auto 可显式指定。
 *  - 默认 auto：优先 better-sqlite3；不可用时降级 node:sqlite，并在 driverNote 中显式说明。
 *  - 两者皆不可用（如 Node <22.5 且无 better-sqlite3）时抛出带诊断的错误。
 */
export function openSqlite(file: string): OpenedStore {
  const requested =
    process.env.DSH_MEMORY_SQLITE_DRIVER ?? "auto";
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  if (requested === "better-sqlite3" || requested === "auto") {
    try {
      const db = tryLoadBetterSqlite3(file);
      return { db, driver: "better-sqlite3", driverNote: "better-sqlite3 (主实现)" };
    } catch (err) {
      if (requested === "better-sqlite3") {
        throw new Error(
          `无法加载 better-sqlite3（${file}）。请确认其原生模块已正确安装` +
            `（npm install better-sqlite3 需成功；Windows 需 VS C++ 工具链或预编译二进制）。` +
            `底层错误：${(err as Error).message}`,
          { cause: err },
        );
      }
    }
  }

  if (requested === "node:sqlite" || requested === "auto") {
    try {
      const db = tryLoadNodeSqlite(file);
      return {
        db,
        driver: "node:sqlite",
        driverNote:
          "node:sqlite (显式降级：better-sqlite3 不可用；Node 22 需 --experimental-sqlite，Node 24+ 免 flag)",
      };
    } catch (err) {
      throw new Error(
        `无法加载 node:sqlite 备用驱动（${file}）。请安装 better-sqlite3 或使用 Node ≥22.5` +
          `（Node 22 需 --experimental-sqlite）。底层错误：${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  throw new Error(
    `未知的 DSH_MEMORY_SQLITE_DRIVER：${requested}（允许 better-sqlite3 | node:sqlite | auto）`,
  );
}

/** 轻量事务辅助（兼容两个驱动；Q102 ChangeSet 的先提交语义在业务层） */
export function withTransaction(
  db: SqlDatabase,
  fn: () => void,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
