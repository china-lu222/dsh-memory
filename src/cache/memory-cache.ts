/**
 * Context-aware / Version-aware Memory Cache（R6，Q059/Q092）。
 *
 * 持久化在 `memory_cache` 表；缓存键指纹至少包含：
 *  query（规范化）、scope、project、检索档位、检索实现版本、embedding model、
 *  `memory.watermark`（记忆全局版本水位，repository 内任何 memory_items 写入同事务推进）。
 *
 * 失效规则（不依赖人工清空）：
 *  - 记忆变化 → watermark 变 → 旧指纹不匹配 → 自动 miss（version-aware invalidation）；
 *  - 嵌入模型变化 → 指纹变 → miss（embedding cache 与本缓存互不污染：两者 key
 *    空间与存储分离，本模块只存检索结果文本/上下文载荷）。
 * 另提供按 scope/project 显式 invalidate 与全局 clearAll。
 */

import { createHash } from "node:crypto";
import type { MetadataFilter } from "../retrieval/types.js";
import type { SqlDatabase } from "../store/sqlite.js";

export interface MemoryCacheContext {
  /** 原始查询文本。 */
  query: string;
  /** scope 过滤（personal/project/generalized 等，缺省不含 scope 维）。 */
  scope?: string;
  /** 项目 id（project 维）。 */
  projectId?: string;
  /** 排序/截断参数影响结果，纳入键。 */
  limit?: number;
  /** 检索档位（economy/standard/thorough）或自适应档位。 */
  profile?: string;
  /** embedding 模型标识（仅 hybrid/向量结果使用）。 */
  embeddingModel?: string;
  /** 检索面：keyword / hybrid。 */
  kind: "keyword" | "hybrid";
  /** 其余影响结果的参数（如 type/temporal/fusion 等）序列化串，纳入指纹。 */
  extra?: string;
}

export interface MemoryCacheContextOptions {
  /** 检索面：keyword / hybrid。 */
  kind: "keyword" | "hybrid";
  /** 检索档位（economy/standard/thorough）或自适应档位。 */
  profile?: string;
  /** embedding 模型标识（仅 hybrid/向量结果使用）。 */
  embeddingModel?: string;
  /** hybrid 融合策略；纳入 extra（仅 hybrid 有意义）。 */
  fusion?: string | null;
}

/**
 * 从检索请求构建缓存上下文（版本键的单一来源）。
 *
 * scope/project/limit 放顶层维度；type/temporal/experiencePhase/importance/
 * minConfidence/includeHistorical/fusion 等其余影响结果的过滤维度统一序列化进
 * `extra`，与 fingerprint 的字段顺序解耦（同维度组合总生成同键）。
 */
export function makeMemoryCacheContext(
  query: string,
  filter: MetadataFilter | undefined,
  limit: number | undefined,
  options: MemoryCacheContextOptions,
): MemoryCacheContext {
  return {
    query,
    scope: filter?.scope,
    projectId: filter?.projectId,
    limit,
    profile: options.profile,
    kind: options.kind,
    embeddingModel: options.embeddingModel,
    extra: JSON.stringify({
      type: filter?.type ?? null,
      temporalState: filter?.temporalState ?? null,
      experiencePhase: filter?.experiencePhase ?? null,
      importance: filter?.importance ?? null,
      minConfidence: filter?.minConfidence ?? null,
      includeHistorical: filter?.includeHistorical ?? null,
      fusion: options.fusion ?? null,
    }),
  };
}

export interface MemoryCacheGetResult {
  hit: boolean;
  payload: unknown;
  row: {
    cacheKey: string;
    hits: number;
    updatedAt: string;
  } | null;
}

export interface MemoryCacheStats {
  rows: number;
  totalHits: number;
  totalBytes: number;
  byScope: Array<{ scope: string; count: number }>;
}

/** 检索实现版本（决定同一 SQL/算法变更后缓存失效）。提升版本即全库失效。 */
export const RETRIEVAL_IMPL_VERSION = "r6-cache-1";

function normQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function watermark(db: SqlDatabase): string {
  const r = db
    .prepare("SELECT value FROM system_meta WHERE key = 'memory.watermark'")
    .get() as { value: string } | undefined;
  return r?.value ?? "0";
}

export class MemoryCache {
  constructor(
    private readonly db: SqlDatabase,
    private readonly options: {
      /** 嵌入模型标识缺省值；显式 ctx.embeddingModel 优先。 */
      embeddingModel?: string;
      retrievalVersion?: string;
    } = {},
  ) {}

  private fingerprint(ctx: MemoryCacheContext): string {
    const embedModel = ctx.embeddingModel ?? this.options.embeddingModel ?? "none";
    return sha256hex(
      JSON.stringify({
        query: normQuery(ctx.query),
        scope: ctx.scope ?? "",
        project: ctx.projectId ?? "",
        limit: ctx.limit ?? 0,
        profile: ctx.profile ?? "",
        kind: ctx.kind,
        extra: ctx.extra ?? "",
        embedModel,
        impl: this.options.retrievalVersion ?? RETRIEVAL_IMPL_VERSION,
        wm: watermark(this.db),
      }),
    );
  }

  private cacheKey(ctx: MemoryCacheContext): string {
    const embedModel = ctx.embeddingModel ?? this.options.embeddingModel ?? "none";
    // 常键（不含 watermark）：同查询最新结果覆盖旧行。
    return sha256hex(
      JSON.stringify({
        query: normQuery(ctx.query),
        scope: ctx.scope ?? "",
        project: ctx.projectId ?? "",
        limit: ctx.limit ?? 0,
        profile: ctx.profile ?? "",
        kind: ctx.kind,
        extra: ctx.extra ?? "",
        embedModel,
        impl: this.options.retrievalVersion ?? RETRIEVAL_IMPL_VERSION,
      }),
    );
  }

  get(ctx: MemoryCacheContext): MemoryCacheGetResult {
    const key = this.cacheKey(ctx);
    const fp = this.fingerprint(ctx);
    const row = this.db
      .prepare("SELECT * FROM memory_cache WHERE cache_key = ?")
      .get(key) as
      | {
          cache_key: string;
          payload_json: string;
          hits: number;
          updated_at: string;
          fingerprint: string;
        }
      | undefined;
    if (row === undefined) {
      return { hit: false, payload: undefined, row: null };
    }
    if (row.fingerprint !== fp) {
      // 版本已变化 → 失效。删除旧行以免陈旧载荷被陈旧命中。
      this.db.prepare("DELETE FROM memory_cache WHERE cache_key = ?").run(key);
      return { hit: false, payload: undefined, row: null };
    }
    this.db
      .prepare("UPDATE memory_cache SET hits = hits + 1 WHERE cache_key = ?")
      .run(key);
    return {
      hit: true,
      payload: parsePayload(row.payload_json),
      row: { cacheKey: key, hits: row.hits + 1, updatedAt: row.updated_at },
    };
  }

  put(ctx: MemoryCacheContext, payload: unknown): void {
    const key = this.cacheKey(ctx);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memory_cache
           (cache_key, query, scope, project_id, fingerprint, payload_json,
            embedding_model, hits, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        key,
        ctx.query,
        ctx.scope ?? "global",
        ctx.projectId ?? null,
        this.fingerprint(ctx),
        JSON.stringify(payload),
        ctx.embeddingModel ?? this.options.embeddingModel ?? null,
        now,
        now,
      );
  }

  /** 显式失效：不带任何过滤时全库清空（schema/meta 级变更后手动调用）。 */
  invalidate(options: { scope?: string; projectId?: string } = {}): number {
    let sql = "DELETE FROM memory_cache";
    const params: string[] = [];
    if (options.scope !== undefined) {
      sql += " WHERE scope = ?";
      params.push(options.scope);
    } else if (options.projectId !== undefined) {
      sql += " WHERE project_id = ?";
      params.push(options.projectId);
    }
    return Number(dbChanges(this.db, sql, params));
  }

  clearAll(): number {
    return this.invalidate();
  }

  stats(): MemoryCacheStats {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(hits), 0) AS hits,
                COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM memory_cache`,
      )
      .get() as { rows: number; hits: number; bytes: number };
    const byScope = this.db
      .prepare(
        "SELECT scope, COUNT(*) AS count FROM memory_cache GROUP BY scope ORDER BY count DESC",
      )
      .all() as Array<{ scope: string; count: number }>;
    return {
      rows: Number(agg.rows),
      totalHits: Number(agg.hits),
      totalBytes: Number(agg.bytes),
      byScope,
    };
  }
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function dbChanges(
  db: SqlDatabase,
  sql: string,
  params: string[],
): number {
  return db.prepare(sql).run(...params).changes;
}
