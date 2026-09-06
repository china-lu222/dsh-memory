/**
 * Memory Center 系统/状态 API（R7）：只读健康信息 + 运行时动作钩子。
 * 运行时快照与动作由宿主 apply 注入；未注入时自动降级为纯 store 数据。
 */

import { attempt, type Result } from "./common.js";
import type { ApiContext, ApiRuntimeSnapshot } from "./context.js";
import { countRows } from "./reads.js";
import type { SqlDatabase } from "../store/sqlite.js";

export interface StoreView {
  driver: string;
  driverNote: string;
}

export interface QueueView {
  /** 非终态事件（queued + processing）。 */
  pending: number;
  /** 死信事件（重试耗尽）。 */
  dead: number;
}

export interface LastValidationView {
  /** started_at（ISO）。 */
  at: string;
  kind: string;
  actor: string;
  scanned: number;
  changed: number;
  dryRun: boolean;
}

export interface SystemInfoView {
  schemaVersion: number;
  storePath: string;
  markdownRoot: string | null;
  /** store 驱动信息（宿主注入；缺省 null 表示纯 store 场景未提供）。 */
  store: StoreView | null;
  runtime: ApiRuntimeSnapshot | null;
  cacheRows: number | null;
  /** durable 事件队列状态（worker 接线前恒为空表 → 全 0）。 */
  queue: QueueView;
  /** 最近一次连续校验运行记录（无记录为 null）。 */
  lastValidation: LastValidationView | null;
  counts: {
    memoryItems: number;
    conflictsOpen: number;
    experiencesActive: number;
    auditEntries: number;
    eventsTotal: number;
  };
}

export function systemInfo(ctx: ApiContext): Result<SystemInfoView> {
  return attempt(() => {
    const { db } = ctx;
    const versionRow = db
      .prepare("SELECT MAX(version) AS v FROM schema_migrations")
      .get() as { v: number } | undefined;
    let cacheRows: number | null = null;
    try {
      cacheRows = countRows(db, "memory_cache");
    } catch {
      // 旧 store 无缓存表时忽略。
    }
    let eventsTotal = 0;
    try {
      eventsTotal = countRows(db, "events");
    } catch {
      eventsTotal = 0;
    }
    const queue = readQueue(db);
    const lastValidation = readLastValidation(db);
    return {
      schemaVersion: Number(versionRow?.v ?? 0),
      storePath: ctx.storePath,
      markdownRoot: ctx.markdownRoot ?? null,
      store: ctx.store ?? null,
      runtime: ctx.runtime?.() ?? null,
      cacheRows,
      queue,
      lastValidation,
      counts: {
        memoryItems: countRows(db, "memory_items"),
        conflictsOpen: countRows(db, "conflict_reviews", "status = 'open'"),
        experiencesActive: countRows(
          db,
          "memory_items",
          "type = 'experience' AND hidden = 0 AND temporal_state != 'historical'",
        ),
        auditEntries: countRows(db, "audit_log"),
        eventsTotal,
      },
    };
  });
}

function readQueue(db: SqlDatabase): QueueView {
  try {
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) AS dead
         FROM events`,
      )
      .get() as { pending: number; dead: number };
    return { pending: Number(row.pending), dead: Number(row.dead) };
  } catch {
    // 旧 store 无 events 表时忽略。
    return { pending: 0, dead: 0 };
  }
}

function readLastValidation(db: SqlDatabase): LastValidationView | null {
  try {
    const row = db
      .prepare(
        `SELECT kind, actor, scanned, changed, dry_run, started_at
           FROM validation_runs
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .get() as
      | {
          kind: string;
          actor: string;
          scanned: number;
          changed: number;
          dry_run: number;
          started_at: string;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      at: row.started_at,
      kind: row.kind,
      actor: row.actor,
      scanned: Number(row.scanned),
      changed: Number(row.changed),
      dryRun: row.dry_run === 1,
    };
  } catch {
    // 旧 store 无 validation_runs 表时忽略。
    return null;
  }
}

export interface ValidationRunView {
  accepted: boolean;
  /** 预览模式（只扫描不改写记忆）。 */
  dryRun?: boolean;
  /** 扫描发现的应过期条目数。 */
  changed?: number;
  /** 用户手动编辑过、被跳过检查的记忆条数。 */
  skipped?: number;
  reason?: string;
}

export function runValidation(
  ctx: ApiContext,
  options: { dryRun?: boolean } = {},
): Result<ValidationRunView> {
  const run = ctx.actions?.runValidation;
  if (run === undefined) {
    return { ok: false, error: "validation runner is not wired in this runtime" };
  }
  return attempt(() => {
    const outcome = run(options.dryRun === true);
    if (outcome === false) {
      return {
        accepted: false,
        reason: "a validation run is already in progress",
      } satisfies ValidationRunView;
    }
    if (outcome === true) {
      return { accepted: true } satisfies ValidationRunView;
    }
    return {
      accepted: true,
      dryRun: outcome.dryRun,
      changed: outcome.changed,
      skipped: outcome.skipped,
    } satisfies ValidationRunView;
  });
}

export interface ConsolidationRunView {
  accepted: boolean;
  /** 新入队的整合事件 id（accepted=false 时为 null）。 */
  scheduledId?: string | null;
  reason?: string;
}

export function runConsolidation(ctx: ApiContext): Result<ConsolidationRunView> {
  const run = ctx.actions?.consolidate;
  if (run === undefined) {
    return { ok: false, error: "consolidation runner is not wired in this runtime" };
  }
  return attempt(() => {
    const outcome = run();
    const scheduledId = typeof outcome === "boolean" ? null : outcome.scheduledId;
    if (scheduledId === null) {
      return {
        accepted: false,
        scheduledId: null,
        reason: "an identical consolidation is already scheduled for this hour",
      } satisfies ConsolidationRunView;
    }
    return { accepted: true, scheduledId } satisfies ConsolidationRunView;
  });
}

export function clearRetrievalCache(ctx: ApiContext): Result<{ cleared: number | null }> {
  const clear = ctx.actions?.clearCache;
  if (clear === undefined) {
    return { ok: false, error: "cache control is not wired in this runtime" };
  }
  return attempt(() => ({ cleared: clear() }));
}

export function rebuildMarkdownProjection(ctx: ApiContext): Result<{ generated: number | null }> {
  const build = ctx.actions?.rebuildProjection;
  if (build === undefined) {
    return { ok: false, error: "projection rebuild is not wired in this runtime" };
  }
  return attempt(() => ({ generated: build() }));
}

export function setVectorSearch(
  ctx: ApiContext,
  enabled: boolean,
): Result<{ enabled: boolean; restartRequired: boolean }> {
  const set = ctx.actions?.setVectorEnabled;
  if (set === undefined) {
    return { ok: false, error: "vector switch is not wired in this runtime" };
  }
  return attempt(() => set(enabled));
}
