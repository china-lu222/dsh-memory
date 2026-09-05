/**
 * SqliteVecStore（R4）：基于 sqlite-vec（vec0 虚拟表）+ Node 内建 node:sqlite。
 *
 * 运行前提（Q 系列探针实测）：
 *  - Node ≥22.5（22 需 --experimental-sqlite），`new DatabaseSync(file,
 *    { allowExtension: true })`；
 *  - `SQLITE_EXTENSION_DIR` 指向 sqlite-vec 平台包的目录，且 loadExtension
 *    使用绝对路径 —— 本实现构造时若该 env 未设置会自行填充（需在 DatabaseSync
 *    构造前设置，实测进程内设置有效）。
 *
 * 次要元数据（vec_meta/vec_info）与向量表同库存放：vec_meta 存版本号
 * （投影增量去重用）、vec_info 存 modelKey/dimension —— 启动时发现模型或
 * 维度变更会自动 DROP 重建（向量索引必须整表重建）。
 *
 * 任一前提不满足时本对象不抛错，而是 `health().available=false` 并携带
 * reason，由检索编排层透明降级为关键词模式。
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { VectorSearchHit, VectorStore, VectorStoreHealth } from "./types.js";

interface RawStmt {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStmt;
  loadExtension(path: string): void;
  close(): void;
}

export interface SqliteVecStoreOptions {
  /** 向量库文件路径（独立于主 memory.db） */
  file: string;
  /** 向量维度（虚拟表维度，变更需重建） */
  dimension: number;
  /** embedding 模型标识（缓存/降级判断；变更需重建） */
  modelId: string;
}

function tryLoadablePath(): { ok: true; loadablePath: string } | { ok: false; reason: string } {
  try {
    const require = createRequire(import.meta.url);
    const sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
    return { ok: true, loadablePath: sqliteVec.getLoadablePath() };
  } catch (err) {
    return { ok: false, reason: `sqlite-vec 不可用: ${(err as Error).message}` };
  }
}

export class SqliteVecStore implements VectorStore {
  readonly id = "sqlite-vec";
  readonly dimension: number;
  readonly modelId: string;

  private readonly file: string;
  private db: RawDb | null = null;
  private failure: string | undefined;
  private countCache = 0;

  constructor(opts: SqliteVecStoreOptions) {
    this.file = opts.file;
    this.dimension = opts.dimension;
    this.modelId = opts.modelId;
    try {
      this.openAndEnsureCompatible();
    } catch (err) {
      this.db = null;
      this.failure = err instanceof Error ? err.message : String(err);
    }
  }

  private openAndEnsureCompatible(): void {
    const lp = tryLoadablePath();
    if (!lp.ok) throw new Error(lp.reason);
    // env 需在 DatabaseSync 前设置（进程内设置实测有效）。
    if (process.env.SQLITE_EXTENSION_DIR === undefined) {
      process.env.SQLITE_EXTENSION_DIR = path.dirname(lp.loadablePath);
    }
    let mod: { DatabaseSync: new (file: string, opts?: object) => RawDb };
    try {
      const require = createRequire(import.meta.url);
      mod = require("node:sqlite") as typeof mod;
    } catch (err) {
      throw new Error(`node:sqlite 不可用（Node<22.5 或未启用）: ${(err as Error).message}`);
    }
    const db = new mod.DatabaseSync(this.file, { allowExtension: true });
    try {
      db.loadExtension(lp.loadablePath);
    } catch (err) {
      db.close();
      throw new Error(`loadExtension(vec0) 失败: ${(err as Error).message}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS vec_info(k TEXT PRIMARY KEY, v TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS vec_meta(
      memory_id TEXT PRIMARY KEY, version INTEGER, updated_at TEXT NOT NULL)`);
    const info = (k: string): string | null => {
      const row = db.prepare("SELECT v FROM vec_info WHERE k = ?").get(k);
      return (row?.v as string | undefined) ?? null;
    };
    const storedDim = info("dimension");
    const storedModel = info("modelId");
    const compatible =
      storedDim === String(this.dimension) && storedModel === this.modelId;
    if (storedDim === null && storedModel === null) {
      db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(
        memory_id TEXT PRIMARY KEY, embedding float[${this.dimension}])`);
      db.prepare("INSERT INTO vec_info(k, v) VALUES (?, ?)").run("dimension", String(this.dimension));
      db.prepare("INSERT INTO vec_info(k, v) VALUES (?, ?)").run("modelId", this.modelId);
    } else if (!compatible) {
      // 模型/维度变更：向量表无法 ALTER，整表重建。
      db.exec("DROP TABLE IF EXISTS vec_items");
      db.exec("DROP TABLE IF EXISTS vec_meta");
      db.exec("DELETE FROM vec_info");
      db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(
        memory_id TEXT PRIMARY KEY, embedding float[${this.dimension}])`);
      db.exec(`CREATE TABLE IF NOT EXISTS vec_meta(
        memory_id TEXT PRIMARY KEY, version INTEGER, updated_at TEXT NOT NULL)`);
      db.prepare("INSERT INTO vec_info(k, v) VALUES (?, ?)").run("dimension", String(this.dimension));
      db.prepare("INSERT INTO vec_info(k, v) VALUES (?, ?)").run("modelId", this.modelId);
    }
    this.db = db;
    this.countCache = this.readCount();
  }

  private readCount(): number {
    if (this.db === null) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM vec_meta").get();
    return Number(row?.c ?? 0);
  }

  private vector(vals: number[]): Float32Array {
    if (vals.length !== this.dimension) {
      throw new Error(`向量维度不符：表 ${this.dimension}，实收 ${vals.length}`);
    }
    return new Float32Array(vals);
  }

  health(): VectorStoreHealth {
    if (this.db === null) {
      return {
        available: false,
        engine: this.id,
        count: 0,
        reason: this.failure ?? "store 未就绪",
      };
    }
    return {
      available: true,
      engine: this.id,
      modelId: this.modelId,
      dimension: this.dimension,
      count: this.countCache,
    };
  }

  upsert(memoryId: string, embedding: number[], version?: number): void {
    if (this.db === null) return;
    const arr = this.vector(embedding);
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM vec_items WHERE memory_id = ?").run(memoryId);
    this.db
      .prepare("INSERT INTO vec_items(memory_id, embedding) VALUES (?, ?)")
      .run(memoryId, arr);
    this.db
      .prepare(
        "INSERT INTO vec_meta(memory_id, version, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(memory_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at",
      )
      .run(memoryId, version === undefined ? null : version, now);
    this.countCache = this.readCount();
  }

  versionOf(memoryId: string): number | null {
    if (this.db === null) return null;
    const row = this.db.prepare("SELECT version FROM vec_meta WHERE memory_id = ?").get(memoryId);
    const v = row?.version;
    return typeof v === "number" ? v : null;
  }

  remove(memoryId: string): void {
    if (this.db === null) return;
    this.db.prepare("DELETE FROM vec_items WHERE memory_id = ?").run(memoryId);
    this.db.prepare("DELETE FROM vec_meta WHERE memory_id = ?").run(memoryId);
    this.countCache = this.readCount();
  }

  search(embedding: number[], topK: number): VectorSearchHit[] {
    if (this.db === null || topK <= 0) return [];
    const rows = this.db
      .prepare(
        "SELECT memory_id AS memoryId, distance FROM vec_items " +
          "WHERE embedding MATCH ? AND k = ?",
      )
      .all(this.vector(embedding), Math.floor(topK));
    return rows.map((r) => {
      const distance = Number(r.distance ?? 0);
      return {
        memoryId: String(r.memoryId),
        distance,
        similarity: 1 / (1 + distance),
      };
    });
  }

  ids(): string[] {
    if (this.db === null) return [];
    const rows = this.db.prepare("SELECT memory_id FROM vec_meta").all();
    return rows.map((r) => String(r.memory_id));
  }

  count(): number {
    return this.db === null ? 0 : this.countCache;
  }

  clear(): void {
    if (this.db === null) return;
    this.db.exec("DELETE FROM vec_items");
    this.db.exec("DELETE FROM vec_meta");
    this.countCache = 0;
  }

  close(): void {
    if (this.db !== null) {
      try {
        this.db.close();
      } finally {
        this.db = null;
      }
    }
  }
}
