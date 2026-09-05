/**
 * Memory Center 系统/状态 API（R7）：只读健康信息 + 运行时动作钩子。
 * 运行时快照与动作由宿主 apply 注入；未注入时自动降级为纯 store 数据。
 */

import { attempt, type Result } from "./common.js";
import type { ApiContext, ApiRuntimeSnapshot } from "./context.js";
import { countRows } from "./reads.js";

export interface SystemInfoView {
  schemaVersion: number;
  storePath: string;
  markdownRoot: string | null;
  runtime: ApiRuntimeSnapshot | null;
  cacheRows: number | null;
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
    return {
      schemaVersion: Number(versionRow?.v ?? 0),
      storePath: ctx.storePath,
      markdownRoot: ctx.markdownRoot ?? null,
      runtime: ctx.runtime?.() ?? null,
      cacheRows,
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

export function runValidation(
  ctx: ApiContext,
  options: { dryRun?: boolean } = {},
): Result<{ accepted: boolean; reason?: string }> {
  const run = ctx.actions?.runValidation;
  if (run === undefined) {
    return { ok: false, error: "validation runner is not wired in this runtime" };
  }
  return attempt(() => {
    const accepted = run(options.dryRun === true);
    return { accepted, reason: accepted ? undefined : "a validation run is already in progress" };
  });
}

export function runConsolidation(ctx: ApiContext): Result<{ accepted: boolean }> {
  const run = ctx.actions?.consolidate;
  if (run === undefined) {
    return { ok: false, error: "consolidation runner is not wired in this runtime" };
  }
  return attempt(() => ({ accepted: run() }));
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
