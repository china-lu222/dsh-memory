// r7-final-flows: R7 最终验收 —— Review Center 全链路 + Benchmark 隔离。
//  - Conflict Review：近似重复种子 → 开评审 → resolve / discard；
//  - Quarantine 管理：隔离（域函数播种）→ promote / reject；
//  - Experience 推进：candidate→verified 及非法跳跃拒绝；
//  - Benchmark：种子事务回滚，用户记忆零污染、benchmark_runs 落库。

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebRoute, WebServerLike } from "../src/cordis/apply.js";
import { registerMemoryCenterApi } from "../src/api/http.js";
import type { ApiContext } from "../src/api/context.js";
import { runBenchmark } from "../src/benchmark/run.js";
import { runRealtimeLocalDedup } from "../src/memory/consolidation.js";
import { createExperience } from "../src/memory/experience.js";
import { quarantineMemory } from "../src/memory/quarantine.js";
import { openStore } from "../src/store/db.js";
import type { SqlDatabase } from "../src/store/sqlite.js";

const API = "/dsh-memory/api";

interface Harness {
  db: SqlDatabase;
  routes: WebRoute[];
  close(): void;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHarness(file: string): Harness {
  const store = openStore({ file });
  const routes: WebRoute[] = [];
  const server: WebServerLike = {
    register(route: WebRoute): unknown {
      routes.push(route);
      return undefined;
    },
  };
  registerMemoryCenterApi(server, { db: store.db, storePath: file, actor: "user" } satisfies ApiContext);
  return { db: store.db, routes, close: () => store.db.close() };
}

interface CallOutcome {
  status: number;
  data: unknown;
}

async function request(h: Harness, method: string, url: string, body?: unknown): Promise<CallOutcome> {
  // http.ts 按 pathname 匹配路由、再以 paramsOf(url) 解析 query，
  // 故匹配前需剥离 query 段（与 r7-http.test.ts 一致）。
  const requestPath = url.split("?")[0] ?? url;
  const route = h.routes.find((r) =>
    r.kind === "exact" ? r.path === requestPath : requestPath.startsWith(r.path),
  );
  if (route === undefined) throw new Error(`no route for ${url}`);
  let status = 0;
  const chunks: string[] = [];
  const finished = new Promise<void>((resolve) => {
    const res = {
      writeHead(code: number): void {
        status = code;
      },
      end(chunk?: string): void {
        if (chunk !== undefined) chunks.push(String(chunk));
        resolve();
      },
    };
    const req = { method, url } as { method: string; url: string; body?: unknown };
    if (body !== undefined) req.body = body;
    route.handler(req as never, res as never);
  });
  await new Promise((r) => setImmediate(r));
  await finished;
  const raw = chunks.join("");
  let data: unknown = raw;
  try {
    data = raw === "" ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    // 非 JSON 原样返回。
  }
  return { status, data };
}

function okData(outcome: CallOutcome): unknown {
  expect(outcome.status).toBe(200);
  const parsed = outcome.data as { ok: boolean; data?: unknown };
  expect(parsed.ok).toBe(true);
  return parsed.data;
}

function errText(outcome: CallOutcome, status: number): string {
  expect(outcome.status).toBe(status);
  const parsed = outcome.data as { ok: boolean; error: string };
  expect(parsed.ok).toBe(false);
  return parsed.error;
}

async function createMemory(h: Harness, content: string): Promise<string> {
  const data = okData(
    await request(h, "POST", `${API}/memories`, { type: "personal", scope: "session", content }),
  ) as { id: string };
  return data.id;
}

/** 开一条冲突评审：两条近重复记忆（同 scope/type，无 projectId）。 */
async function openReviewForNearDuplicates(h: Harness): Promise<{ a: string; b: string }> {
  // 近重复：B 仅比 A 多一个修饰词，token Jaccard ≈ 0.89 ≥ 0.85 阈值。
  const a = await createMemory(h, "reuse existing database connections through the factory pattern");
  const b = await createMemory(
    h,
    "reuse existing database connections through the factory pattern lazily",
  );
  const summary = runRealtimeLocalDedup(h.db, { actor: "user", minJaccard: 0.85 });
  expect(summary.reviewsOpened).toBeGreaterThanOrEqual(1);
  return { a, b };
}

function findReviewId(
  items: Array<{ id: string; memoryAId: string; memoryBId: string }>,
  a: string,
  b: string,
): string {
  const found = items.find(
    (r) => (r.memoryAId === a && r.memoryBId === b) || (r.memoryAId === b && r.memoryBId === a),
  );
  if (found === undefined) throw new Error("open review not found");
  return found.id;
}

function sameMemory(pair: { a: string; b: string }, id: string): boolean {
  return pair.a === id || pair.b === id;
}

describe("R7-2/3 Review Center：Conflict Review", () => {
  it("近似重复 → 开评审 → supersede resolve → 关闭", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r7f-conflict-")), "memory.db");
    tmpDirs.push(path.dirname(file));
    const h = makeHarness(file);
    try {
      const pair = await openReviewForNearDuplicates(h);

      const list = okData(await request(h, "GET", `${API}/conflicts`)) as {
        items: Array<{ id: string; memoryAId: string; memoryBId: string }>;
        total: number;
      };
      expect(list.total).toBeGreaterThanOrEqual(1);
      const reviewId = findReviewId(list.items, pair.a, pair.b);

      const detail = okData(await request(h, "GET", `${API}/conflicts/${reviewId}`)) as {
        memoryA: { id: string } | null;
        memoryB: { id: string } | null;
      };
      expect(detail.memoryA?.id).toBeTruthy();
      expect(detail.memoryB?.id).toBeTruthy();

      const resolved = okData(
        await request(h, "POST", `${API}/conflicts/${reviewId}/resolve`, {
          resolution: "supersede",
          decisionNote: "final acceptance",
        }),
      ) as { status: string; resolution: string };
      expect(resolved.status).toBe("resolved");
      expect(resolved.resolution).toBe("supersede");

      const open = okData(await request(h, "GET", `${API}/conflicts?status=open`)) as {
        items: Array<{ id: string }>;
      };
      expect(open.items.some((r) => r.id === reviewId)).toBe(false);
      const resolvedList = okData(await request(h, "GET", `${API}/conflicts?status=resolved`)) as {
        items: Array<{ id: string }>;
      };
      expect(resolvedList.items.some((r) => r.id === reviewId)).toBe(true);
    } finally {
      h.close();
    }
  });

  it("开评审 → discard → 标记 discarded 且不动记忆", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r7f-conflict-")), "memory.db");
    tmpDirs.push(path.dirname(file));
    const h = makeHarness(file);
    try {
      const pair = await openReviewForNearDuplicates(h);
      const list = okData(await request(h, "GET", `${API}/conflicts`)) as {
        items: Array<{ id: string; memoryAId: string; memoryBId: string }>;
      };
      const reviewId = findReviewId(list.items, pair.a, pair.b);

      const discarded = okData(
        await request(h, "POST", `${API}/conflicts/${reviewId}/discard`),
      ) as { status: string };
      expect(discarded.status).toBe("discarded");

      const open = okData(await request(h, "GET", `${API}/conflicts?status=open`)) as {
        items: Array<{ id: string }>;
      };
      expect(open.items.some((r) => r.id === reviewId)).toBe(false);

      // 记忆原样保留：仍是 current 且可读。
      const detailA = okData(await request(h, "GET", `${API}/memories/${pair.a}`)) as {
        memory: { temporalState: string };
      };
      expect(detailA.memory.temporalState).toBe("current");
    } finally {
      h.close();
    }
  });

  it("非法 resolution 值返回 400", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r7f-conflict-")), "memory.db");
    tmpDirs.push(path.dirname(file));
    const h = makeHarness(file);
    try {
      const pair = await openReviewForNearDuplicates(h);
      const list = okData(await request(h, "GET", `${API}/conflicts`)) as {
        items: Array<{ id: string; memoryAId: string; memoryBId: string }>;
      };
      const reviewId = findReviewId(list.items, pair.a, pair.b);
      const bad = await request(h, "POST", `${API}/conflicts/${reviewId}/resolve`, {
        resolution: "replace-all",
      });
      expect(errText(bad, 400)).toContain("invalid resolution");
    } finally {
      h.close();
    }
  });
});

describe("R7-2/3 Review Center：Quarantine 管理", () => {
  it("隔离 → promote → 离开隔离区且置信提升", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r7f-quar-")), "memory.db");
    tmpDirs.push(path.dirname(file));
    const h = makeHarness(file);
    try {
      const id = await createMemory(h, "low confidence inferred fact about module boundaries");
      quarantineMemory(h.db, id, "final acceptance seed", "system");

      const pending = okData(await request(h, "GET", `${API}/quarantine`)) as {
        items: Array<{ id: string }>;
      };
      expect(pending.items.some((m) => m.id === id)).toBe(true);

      const promoted = okData(await request(h, "POST", `${API}/quarantine/${id}/promote`)) as {
        hidden: 0 | 1;
        confidence: number;
      };
      expect(promoted.hidden).toBe(0);
      expect(promoted.confidence).toBeGreaterThanOrEqual(0.7);

      const after = okData(await request(h, "GET", `${API}/quarantine`)) as {
        items: Array<{ id: string }>;
      };
      expect(after.items.some((m) => m.id === id)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("隔离 → reject → historical 归档（默认列表排除、includeRejected 可见）", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r7f-quar-")), "memory.db");
    tmpDirs.push(path.dirname(file));
    const h = makeHarness(file);
    try {
      const id = await createMemory(h, "uncertain inferred claim about async scheduling");
      quarantineMemory(h.db, id, "final acceptance seed", "system");

      const rejected = okData(
        await request(h, "POST", `${API}/quarantine/${id}/reject`, { note: "no evidence" }),
      ) as { temporalState: string; utility: number };
      expect(rejected.temporalState).toBe("historical");
      expect(rejected.utility).toBeLessThan(0.1);

      const pending = okData(await request(h, "GET", `${API}/quarantine`)) as {
        items: Array<{ id: string }>;
      };
      expect(pending.items.some((m) => m.id === id)).toBe(false);

      const all = okData(
        await request(h, "GET", `${API}/quarantine?includeRejected=true`),
      ) as { items: Array<{ id: string }> };
      expect(all.items.some((m) => m.id === id)).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe("R7-2/3 Review Center：Experience 推进", () => {
  it("创建经验 → 列表 → advance 跳级 verified → 非法跳跃被拒", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r7f-exp-")), "memory.db");
    tmpDirs.push(path.dirname(file));
    const h = makeHarness(file);
    try {
      const created = createExperience(
        h.db,
        {
          summary: "lazy db connections via factory are released on shutdown",
          problem: "connections were leaked when services stopped",
          projectId: "proj-r7-final",
          scope: "project",
          experiencePhase: "candidate",
          sourceKind: "explicit",
          confidence: 0.8,
        },
        "user",
      );

      const list = okData(
        await request(h, "GET", `${API}/experiences?projectId=proj-r7-final`),
      ) as { items: Array<{ memory: { id: string; experiencePhase: string } }>; total: number };
      expect(list.total).toBe(1);
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.memory.id).toBe(created.id);
      expect(list.items[0]?.memory.experiencePhase).toBe("candidate");

      const advanced = okData(
        await request(h, "POST", `${API}/experiences/${created.id}/advance`, { next: "verified" }),
      );
      expect(advanced).toBe("verified");

      const detail = okData(await request(h, "GET", `${API}/experiences/${created.id}`)) as {
        memory: { id: string; experiencePhase: string };
      };
      expect(detail.memory.experiencePhase).toBe("verified");

      const illegal = await request(h, "POST", `${API}/experiences/${created.id}/advance`, {
        next: "candidate",
      });
      expect(errText(illegal, 400)).toContain("invalid phase transition");
    } finally {
      h.close();
    }
  });
});

describe("R7-4 Benchmark：种子隔离与运行记录", () => {
  it("预置用户记忆不受影响；种子随事务回滚；benchmark_runs 落库", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r7f-bench-")), "memory.db");
    tmpDirs.push(path.dirname(file));

    const h = makeHarness(file);
    const marker = await createMemory(h, "benchmark isolation marker row that must survive");
    h.close();

    const report = await runBenchmark({ dbFile: file, iterations: 1, seedCount: 8 });
    expect(report.status).toBe("ok");
    expect(report.scenarios.map((s) => s.name)).toContain("keyword-retrieval");

    const db = openStore({ file }).db;
    try {
      const memories = db
        .prepare("SELECT id, content FROM memory_items")
        .all() as Array<{ id: string; content: string }>;
      expect(memories).toHaveLength(1);
      expect(memories[0]?.id).toBe(marker);
      expect(memories[0]?.content).toContain("isolation marker");
      const runs = db
        .prepare("SELECT COUNT(*) AS c FROM benchmark_runs")
        .get() as { c: number };
      expect(runs.c).toBe(1);
    } finally {
      db.close();
    }
  });
});
