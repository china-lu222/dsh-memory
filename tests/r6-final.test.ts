/**
 * R6 Finalization 验收测试（宿主生命周期接线 + Memory Cache + Cost/Budget + Validation）。
 *
 * 覆盖：
 *   1. Cordis apply 启动 Worker（排队事件 → done）
 *   2. dispose 后 Worker 停止（不再消费新事件）
 *   3. scheduled consolidation 注册（interval 入队 + 小时幂等）
 *   4. Continuous Validation 执行并写 validation_runs
 *   5. Memory Cache hit
 *   6. Memory Cache invalidation（watermark/显式）
 *   7. Cost/Budget 决策（retrieve telemetry + telemetry 行）
 *   8. 重启后状态恢复（残留队列事件在重启后被 Worker 消费）
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCache, makeMemoryCacheContext } from "../src/cache/memory-cache.js";
import { apply, type PluginConfig } from "../src/cordis/apply.js";
import { openStore } from "../src/store/db.js";
import { insertMemoryItem } from "../src/store/repository.js";
import type { SqlDatabase } from "../src/store/sqlite.js";
import { retrieve } from "../src/retrieval/pipeline.js";

const POLL_MS = 10;

function storeFile(dir: string): string {
  return join(dir, "memory.db");
}

function openDb(dir: string): SqlDatabase {
  return openStore({ file: storeFile(dir) }).db;
}

function baseConfig(dir: string, overrides: PluginConfig = {}): PluginConfig {
  return {
    dataDir: dir,
    dbFile: "memory.db",
    markdownEnabled: false,
    announceToAgent: false,
    vector: { enabled: false },
    worker: { enabled: true, pollMs: POLL_MS },
    consolidation: { enabled: false },
    validation: { enabled: false },
    cache: { enabled: true },
    budget: { enabled: true },
    ...overrides,
  };
}

interface Host {
  /** 触发宿主 dispose（apply 注册的 handler；worker 停止/关库在其内部异步完成）。 */
  dispose(): void;
}

function startHost(cfg: PluginConfig): Host {
  let disposeHandler: (() => void) | undefined;
  const ctx = {
    logger: undefined,
    on: (event: string, fn: unknown) => {
      if (event === "dispose") disposeHandler = fn as () => void;
    },
    systemPrompt: undefined,
    inject: undefined,
  };
  apply(ctx as never, cfg);
  if (disposeHandler === undefined) {
    throw new Error("apply did not register a dispose handler (ctx.on missing?)");
  }
  return { dispose: () => disposeHandler!() };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await cond();
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${message}`);
    await sleep(15);
  }
}

function eventCounts(db: SqlDatabase, eventType: string): Record<string, number> {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS c FROM events WHERE event_type = ? GROUP BY status")
    .all(eventType) as Array<{ status: string; c: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = Number(row.c);
  return out;
}

function insertProjectMemory(db: SqlDatabase, content: string): string {
  return insertMemoryItem(db, {
    content,
    type: "project_knowledge",
    importance: "high",
    scope: "global",
    sourceKind: "explicit",
    temporalState: "current",
  }).id;
}

function validationRuns(db: SqlDatabase): Array<{ run_id: string; kind: string; actor: string; scanned: number; changed: number; dry_run: number; status: string }> {
  return db
    .prepare(
      "SELECT run_id, kind, actor, scanned, changed, dry_run, status FROM validation_runs ORDER BY started_at",
    )
    .all() as Array<{
      run_id: string;
      kind: string;
      actor: string;
      scanned: number;
      changed: number;
      dry_run: number;
      status: string;
    }>;
}

function readMemoryStates(db: SqlDatabase): Array<{ id: string; temporal_state: string }> {
  return db.prepare("SELECT id, temporal_state FROM memory_items").all() as Array<{
    id: string;
    temporal_state: string;
  }>;
}

function isOpen(db: SqlDatabase): boolean {
  try {
    (db as unknown as { prepare(sql: string): unknown }).prepare("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

let liveDbs: SqlDatabase[] = [];
let liveDirs: string[] = [];

function registerDb(db: SqlDatabase): SqlDatabase {
  liveDbs.push(db);
  return db;
}

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mem-r6f-"));
  liveDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of liveDbs) {
    try {
      if (isOpen(db)) db.close();
    } catch {
      // ignore
    }
  }
  liveDbs = [];
  for (const dir of liveDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时忽略
    }
  }
  liveDirs = [];
});

describe("R6 Finalization — host lifecycle wiring", () => {
  it("1. Cordis apply 启动 Worker：排队事件被消费为 done", async () => {
    const dir = newDir();
    const db = registerDb(openDb(dir));
    const host = startHost(baseConfig(dir));

    insertProjectMemory(db, "alpha project deadline moved to next Friday");
    await waitFor(
      () => (eventCounts(db, "memory.create").done ?? 0) >= 1,
      "memory.created done",
    );

    const counts = eventCounts(db, "memory.create");
    expect(counts.done).toBeGreaterThanOrEqual(1);

    host.dispose();
    await sleep(200);
  });

  it("2. dispose 后 Worker 停止：慢轮询下残留事件不被消费", async () => {
    const dir = newDir();
    const db = registerDb(openDb(dir));
    const host = startHost(
      baseConfig(dir, { worker: { enabled: true, pollMs: 60_000 } }),
    );
    await sleep(80); // 确保启动时首轮 drain 已结束（此时无事件）

    insertProjectMemory(db, "beta release candidate candidate");
    await sleep(120); // 远小于 60s 轮询间隔 → 事件仍 queued
    host.dispose();
    await sleep(250); // 等待 worker stop + release + store close

    // dispose 后 Worker 已停止：事件在重启前保持 queued，不会变 done。
    const counts = eventCounts(db, "memory.create");
    expect(counts.done ?? 0).toBe(0);
    expect((counts.queued ?? 0) + (counts.processing ?? 0)).toBe(1);
  });

  it("3. scheduled consolidation 注册：interval 入队且小时幂等", async () => {
    const dir = newDir();
    const db = registerDb(openDb(dir));
    const host = startHost(
      baseConfig(dir, {
        worker: { enabled: true, pollMs: POLL_MS },
        consolidation: { enabled: true, intervalMs: 40 },
      }),
    );

    await waitFor(
      () => (eventCounts(db, "consolidation.scheduled").done ?? 0) >= 1,
      "consolidation.scheduled done (worker consumed)",
    );

    // 幂等：同一小时多次 interval 触发只产生一条（done + queued 合计=1）。
    const counts = eventCounts(db, "consolidation.scheduled");
    expect(counts.done ?? 0).toBeGreaterThanOrEqual(1);
    expect((counts.done ?? 0) + (counts.queued ?? 0)).toBe(1);

    host.dispose();
    await sleep(250);
  });

  it("4. Continuous Validation 定时入口：执行并写 validation_runs", async () => {
    const dir = newDir();
    const db = registerDb(openDb(dir));
    const host = startHost(
      baseConfig(dir, {
        worker: { enabled: false },
        validation: { enabled: true, intervalMs: 25, dryRun: false },
      }),
    );

    const expiredInPast = new Date(Date.now() - 60_000).toISOString();
    insertProjectMemory(db, "expired memory alpha should be swept");
    db.prepare("UPDATE memory_items SET valid_until = ? WHERE content LIKE 'expired memory%'").run(
      expiredInPast,
    );

    await waitFor(
      () => validationRuns(db).some((r) => Number(r.changed) >= 1),
      "validation_runs hygiene row with changes",
    );

    const runs = validationRuns(db);
    const row = runs[runs.length - 1]!;
    expect(row.kind).toBe("hygiene");
    expect(row.actor).toBe("host:validator");
    expect(row.status).toBe("succeeded");
    expect(Number(row.changed)).toBeGreaterThanOrEqual(1);

    // dryRun=false → 过期记忆确实转 expired。
    const states = readMemoryStates(db);
    expect(states.some((s) => s.temporal_state === "expired")).toBe(true);

    host.dispose();
    await sleep(200);
  });

  it("8. 重启后状态恢复：残留 queued 事件在重启后被 Worker 消费", async () => {
    const dir = newDir();
    // “宕机”会话：仅写库（无 worker），事件保留 queued。
    const down = registerDb(openDb(dir));
    insertProjectMemory(down, "gamma incident follow up");
    const beforeCounts = eventCounts(down, "memory.create");
    expect(beforeCounts.queued ?? 0).toBe(1);
    down.close();

    // 重启会话：apply 启动 Worker 应认领并消费残留事件。
    const host = startHost(baseConfig(dir));
    const db = registerDb(openDb(dir));
    await waitFor(
      () => (eventCounts(db, "memory.create").done ?? 0) >= 1,
      "leftover event consumed after restart",
    );
    const afterCounts = eventCounts(db, "memory.create");
    expect(afterCounts.done).toBe(1);

    host.dispose();
    await sleep(250);
  });
});

describe("R6 Finalization — Memory Cache + Cost/Budget", () => {
  it("5. Memory Cache hit：同 query 第二次直接命中缓存", () => {
    const dir = newDir();
    const db = registerDb(openDb(dir));
    insertProjectMemory(db, "delta plan freeze this week alpha");

    const cache = new MemoryCache(db, {});
    const request = { query: "alpha plan freeze", filter: undefined, limit: 3 };

    const first = retrieve(db, request, { cache });
    expect(first.cacheHit).toBe(false);

    const second = retrieve(db, request, { cache });
    expect(second.cacheHit).toBe(true);
    expect(second.context).toEqual(first.context);
  });

  it("6. Memory Cache invalidation：watermark 变化与显式 invalidate 均失效", () => {
    const dir = newDir();
    const db = registerDb(openDb(dir));
    insertProjectMemory(db, "epsilon launch window chosen");
    const cache = new MemoryCache(db, {});
    const request = { query: "epsilon launch window", filter: undefined, limit: 3 };

    expect(retrieve(db, request, { cache }).cacheHit).toBe(false);
    expect(retrieve(db, request, { cache }).cacheHit).toBe(true);

    // 写入新记忆 → watermark 变化 → 旧指纹失效。
    insertProjectMemory(db, "epsilon launch scope expanded to two phases");
    expect(retrieve(db, request, { cache }).cacheHit).toBe(false);

    // 显式 invalidate（同查询上下文）→ 下一请求 miss 并重新入库。
    const ctx = makeMemoryCacheContext("epsilon launch window", undefined, 3, {
      kind: "keyword",
    });
    cache.invalidate(ctx);
    expect(cache.get(ctx).hit).toBe(false);
    expect(retrieve(db, request, { cache }).cacheHit).toBe(false);
    expect(retrieve(db, request, { cache }).cacheHit).toBe(true);
  });

  it("7. Cost/Budget 决策：记录 query/context/compression 决策并写 telemetry", () => {
    const dir = newDir();
    const db = registerDb(openDb(dir));
    insertProjectMemory(db, "zeta ship blocker resolved in planning review");

    const result = retrieve(
      db,
      { query: "zeta ship blocker", filter: undefined, limit: 3 },
      { budget: { taskKind: "planning", actor: "tester" } },
    );
    expect(result.cacheHit).toBe(false);
    expect(result.telemetry.budget?.enabled).toBe(true);
    expect(result.telemetry.budget?.contextBudgetTokens).toBeGreaterThan(0);
    expect(result.telemetry.budget?.estimateTokens).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.telemetry.budget?.reason)).toBe(true);

    // telemetry 表写有 kind=budget 决策行（NOT ENABLED 由 config 视图显式呈现）。
    const rows = db
      .prepare("SELECT kind FROM telemetry WHERE kind = 'budget'")
      .all() as Array<{ kind: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
