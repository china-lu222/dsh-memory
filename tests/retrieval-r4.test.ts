// R4：Hybrid 检索链测试。
// 覆盖：hash embedding 确定性、sqlite-vec KNN 与重建、vector-only 召回、
// 归档清理、metadata 过滤、融合+多因子重排、embedding 缓存、null-provider
// 回退（keyword-only === R3 语义）、宿主 /api/search/hybrid 与 /api/config。
//
// sqlite-vec 为可选能力：环境不具备（加载/扩展失败）时跳过向量侧用例，
// 纯逻辑用例（H1/H6/H9）在任何环境都运行。

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/cordis/apply.js";
import {
  HashEmbeddingProvider,
  type EmbeddingHealth,
  type EmbeddingKind,
  type EmbeddingProvider,
} from "../src/embedding/provider.js";
import { DefaultReranker } from "../src/rerank/provider.js";
import { fuse } from "../src/retrieval/fusion.js";
import { LruEmbeddingCache } from "../src/retrieval/cache.js";
import { retrieveHybrid, type HybridRuntime } from "../src/retrieval/hybrid.js";
import { openStore } from "../src/store/db.js";
import {
  archiveMemoryItem,
  insertMemoryItem,
  type MemoryItemRow,
} from "../src/store/repository.js";
import type { SqlDatabase } from "../src/store/sqlite.js";
import { VectorProjectionService } from "../src/vector/projection.js";
import { SqliteVecStore } from "../src/vector/sqlite-vec-store.js";

/** 进程内一次 sqlite-vec 自检（模块加载时执行一次）。 */
function detectVecAvailable(): boolean {
  try {
    const probe = new SqliteVecStore({
      file: ":memory:",
      dimension: 8,
      modelId: "r4-probe",
    });
    const ok = probe.health().available;
    probe.close();
    return ok;
  } catch {
    return false;
  }
}
const VEC_AVAILABLE = detectVecAvailable();

/** 单位基向量（第 at 维为 1）。 */
function unitAxis(dimension: number, at: number): number[] {
  const v = new Array<number>(dimension).fill(0);
  v[at] = 1;
  return v;
}

/** 测试用语义桩：子串命中返回对应概念向量（模拟语义 embedding 的跨词召回）。 */
class ConceptEmbedding implements EmbeddingProvider {
  readonly kind: EmbeddingKind = "local-hash";
  readonly modelId = "test-concept-v1";
  readonly dimension = 8;
  private readonly rules: Array<{ needle: string; vector: number[] }>;
  private readonly fallback: number[];

  constructor(
    rules: Array<{ needle: string; vector: number[] }>,
    fallback = unitAxis(8, 7),
  ) {
    this.rules = rules;
    this.fallback = fallback;
  }

  health(): EmbeddingHealth {
    return {
      available: true,
      kind: this.kind,
      modelId: this.modelId,
      dimension: this.dimension,
    };
  }

  embedText(text: string): Promise<number[]> {
    const hit = this.rules.find((r) => text.includes(r.needle));
    return Promise.resolve(hit ? hit.vector : this.fallback);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedText(t)));
  }
}

async function until(
  fn: () => boolean,
  label: string,
  timeoutMs = 1500,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("R4 embedding + fusion + reranker (environment-independent)", () => {
  let dir: string;
  let file: string;
  let db: SqlDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dshm-r4-"));
    file = path.join(dir, "memory.db");
    db = openStore({ file }).db;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (
    content: string,
    extra: Partial<Parameters<typeof insertMemoryItem>[1]> = {},
  ) =>
    insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content,
      sourceKind: "explicit",
      ...extra,
    });

  it("H1: hash embedding 确定性 + 维度 + L2 归一", async () => {
    const provider = new HashEmbeddingProvider(64);
    expect(provider.health().available).toBe(true);
    const a = await provider.embedText("TypeScript plugin architecture");
    const b = await provider.embedText("TypeScript plugin architecture");
    expect(a).toHaveLength(64);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("H6: weighted/rrf 融合去重并保留源标记", () => {
    const both = seed("both-hit memory");
    const kwOnly = seed("keyword-only memory");
    const vecOnly = seed("vector-only memory");
    const kw = [
      { row: both, score: 0.8 },
      { row: kwOnly, score: 0.6 },
    ];
    const vec = [
      { row: both, score: 0.7 },
      { row: vecOnly, score: 0.9 },
    ];
    const weighted = fuse(kw, vec, "weighted");
    expect(weighted).toHaveLength(3);
    expect(weighted[0]!.row.id).toBe(vecOnly.id); // 单源 vec 0.9 最高
    const bothFused = weighted.find((c) => c.row.id === both.id)!;
    expect(bothFused.sources.sort()).toEqual(["keyword", "vector"]);
    expect(bothFused.keywordScore).toBeCloseTo(0.8, 5);
    expect(bothFused.vectorScore).toBeCloseTo(0.7, 5);
    expect(bothFused.score).toBeCloseTo(0.75, 5); // (0.5*0.8 + 0.5*0.7)

    const rrf = fuse(kw, vec, "rrf");
    expect(rrf).toHaveLength(3);
    expect(rrf[0]!.row.id).toBe(both.id); // 双源 rank1 分数最高
    const bothRrf = rrf.find((c) => c.row.id === both.id)!;
    expect(bothRrf.sources).toContain("keyword");
    expect(bothRrf.sources).toContain("vector");
  });

  it("H6b: DefaultReranker 多因子排序（rel 相同 → 更新鲜靠前）", () => {
    const base = seed("relevance memory", { importance: "low", confidence: 0.5 });
    const old: MemoryItemRow = {
      ...base,
      createdAt: new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const fresh: MemoryItemRow = {
      ...base,
      createdAt: new Date().toISOString(),
    };
    const reranker = new DefaultReranker();
    const ranked = reranker.rerank(
      [
        { row: old, fusedScore: 0.5 },
        { row: fresh, fusedScore: 0.5 },
      ],
      { now: Date.now() },
    );
    expect(ranked[0]!.row.id).toBe(fresh.id);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("H9: embedding/store 均 null 时回退关键词（keyword-only 保 R3 语义）", async () => {
    seed("User mainly uses TypeScript");
    const runtime: HybridRuntime = {
      embedding: null,
      vectorStore: null,
      reranker: null,
    };
    const res = await retrieveHybrid(db, { query: "typescript" }, runtime);
    expect(res.telemetry.hybrid.mode).toBe("keyword-only");
    expect(res.telemetry.hybrid.vector.enabled).toBe(false);
    expect(res.telemetry.hybrid.vector.available).toBe(false);
    expect(res.telemetry.hybrid.rerank.enabled).toBe(false);
    expect(res.telemetry.candidateCount).toBeGreaterThanOrEqual(1);
    expect(
      res.context.profile.some((m) => m.row.content.includes("TypeScript")),
    ).toBe(true);
  });

  it("H7a: embedding LRU 缓存键含 modelId/dimension、按容量驱逐", () => {
    const cache = new LruEmbeddingCache(2);
    expect(cache.get("x", "m1", 8)).toBeUndefined();
    cache.set("x", "m1", 8, [1]);
    cache.set("x", "m1", 9, [2]); // dimension 不同 → 不同键
    expect(cache.get("x", "m1", 8)).toEqual([1]);
    expect(cache.get("x", "m1", 9)).toEqual([2]);
    expect(cache.hits).toBe(2);
    cache.set("y", "m1", 8, [3]);
    cache.set("z", "m1", 8, [4]); // 容量 2 → 驱逐最早键 x(m1,8)
    expect(cache.get("x", "m1", 8)).toBeUndefined();
  });
});

describe.skipIf(!VEC_AVAILABLE)("R4 vector store + hybrid retrieval", () => {
  let dir: string;
  let file: string;
  let db: SqlDatabase;
  let store: SqliteVecStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dshm-r4vec-"));
    file = path.join(dir, "memory.db");
    db = openStore({ file }).db;
    store = undefined;
  });

  afterEach(() => {
    store?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (
    content: string,
    extra: Partial<Parameters<typeof insertMemoryItem>[1]> = {},
  ) =>
    insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content,
      sourceKind: "explicit",
      ...extra,
    });

  const newStore = (dimension: number, modelId: string) => {
    store = new SqliteVecStore({
      file: path.join(dir, `vec-${modelId}-${dimension}.db`),
      dimension,
      modelId,
    });
    return store;
  };

  it("H2: sqlite-vec KNN 检索与 version/remove", () => {
    const s = newStore(8, "h2");
    expect(s.health().available).toBe(true);
    s.upsert("a", unitAxis(8, 0), 5);
    s.upsert("b", unitAxis(8, 1), 1);
    expect(s.versionOf("a")).toBe(5);
    expect(s.ids().sort()).toEqual(["a", "b"]);
    const hits = s.search(unitAxis(8, 0), 3);
    expect(hits[0]!.memoryId).toBe("a");
    expect(hits[0]!.distance).toBeCloseTo(0, 5);
    expect(hits[0]!.similarity).toBeCloseTo(1, 5);
    // 覆盖 upsert（delete + insert）后版本推进、规模不变。
    s.upsert("a", unitAxis(8, 0), 6);
    expect(s.versionOf("a")).toBe(6);
    expect(s.count()).toBe(2);
    s.remove("b");
    expect(s.ids()).toEqual(["a"]);
  });

  it("H3: vector-only 召回（keyword 无命中、向量命中）", async () => {
    const s = newStore(8, "h3");
    const provider = new ConceptEmbedding([
      { needle: "zzqx", vector: unitAxis(8, 0) },
      { needle: "quantum teleportation research", vector: unitAxis(8, 0) },
    ]);
    const row = seed("quantum teleportation research in alpine observatory");
    const svc = new VectorProjectionService(db, s, provider);
    await svc.resyncAll();
    expect(s.ids()).toContain(row.id);

    const res = await retrieveHybrid(
      db,
      { query: "zzqx" },
      { embedding: provider, vectorStore: s, reranker: new DefaultReranker() },
    );
    expect(res.telemetry.hybrid.mode).toBe("vector-only");
    expect(res.telemetry.hybrid.keyword.candidateCount).toBe(0);
    expect(res.telemetry.hybrid.vector.candidateCount).toBe(1);
    expect(res.telemetry.candidateCount).toBe(1);
    expect(res.context.profile.some((m) => m.row.id === row.id)).toBe(true);
    svc.dispose();
  });

  it("H4: 归档即时移除 + resync 不复活（事件路径一致性）", async () => {
    const s = newStore(16, "h4");
    const provider = new HashEmbeddingProvider(16, "h4");
    const svc = new VectorProjectionService(db, s, provider);
    const row = seed("archive me after indexing");
    svc.start();
    await svc.ensureReady();
    await until(() => s.ids().includes(row.id), "create-event projection");
    expect(s.count()).toBe(1);

    archiveMemoryItem(db, row.id); // 事件同步移除
    expect(s.ids()).not.toContain(row.id);

    // 重启等价：resyncAll 不得把已归档条目重新写回。
    await svc.resyncAll();
    expect(s.ids()).not.toContain(row.id);
    expect(s.count()).toBe(0);
    svc.dispose();
  });

  it("H5: 向量命中同样执行 metadata 过滤（projectId）", async () => {
    const s = newStore(8, "h5");
    const provider = new ConceptEmbedding([
      { needle: "zzqx", vector: unitAxis(8, 0) },
      { needle: "neural accelerator", vector: unitAxis(8, 0) },
    ]);
    const p1 = seed("neural accelerator headplane config", {
      type: "project_knowledge",
      scope: "project",
      projectId: "p1",
    });
    seed("neural accelerator backplane config", {
      type: "project_knowledge",
      scope: "project",
      projectId: "p2",
    });
    const svc = new VectorProjectionService(db, s, provider);
    await svc.resyncAll();
    expect(s.count()).toBe(2);

    const res = await retrieveHybrid(
      db,
      { query: "zzqx", filter: { projectId: "p1" } },
      { embedding: provider, vectorStore: s, reranker: new DefaultReranker() },
    );
    expect(res.telemetry.hybrid.vector.candidateCount).toBe(1);
    expect(res.telemetry.candidateCount).toBe(1);
    expect(
      res.context.projectState.some((m) => m.row.id === p1.id),
    ).toBe(true);
    svc.dispose();
  });

  it("H7b: 共享缓存命中查询 embedding（第二次检索 cacheHits>0）", async () => {
    const s = newStore(32, "hash-ngram-v1");
    const provider = new HashEmbeddingProvider(32, "hash-ngram-v1");
    seed("vectorlab hybrid search topic");
    const svc = new VectorProjectionService(db, s, provider);
    await svc.resyncAll();

    const cache = new LruEmbeddingCache(64);
    const runtime: HybridRuntime = {
      embedding: provider,
      vectorStore: s,
      reranker: new DefaultReranker(),
      cache,
    };
    const first = await retrieveHybrid(db, { query: "vectorlab" }, runtime);
    const second = await retrieveHybrid(db, { query: "vectorlab" }, runtime);
    expect(first.telemetry.hybrid.mode).toBe("hybrid");
    expect(first.telemetry.hybrid.vector.cacheHits).toBe(0);
    expect(first.telemetry.hybrid.vector.cacheMisses).toBeGreaterThanOrEqual(1);
    expect(second.telemetry.hybrid.vector.cacheHits).toBeGreaterThanOrEqual(1);
    expect(second.telemetry.candidateCount).toBeGreaterThanOrEqual(1);
    svc.dispose();
  });

  it("H8: 模型/维度变更整表重建（旧索引清空，新维度可用）", async () => {
    const s8 = newStore(8, "h8");
    s8.upsert("legacy", unitAxis(8, 0), 1);
    expect(s8.count()).toBe(1);
    s8.close();
    store = undefined;

    const s16 = newStore(16, "h8");
    expect(s16.health().dimension).toBe(16);
    expect(s16.count()).toBe(0); // 维度变更触发 DROP+重建，旧数据不残留
    expect(s16.ids()).toEqual([]);
    s16.upsert("fresh", unitAxis(16, 3), 1);
    const hits = s16.search(unitAxis(16, 3), 2);
    expect(hits[0]!.memoryId).toBe("fresh");
    expect(hits[0]!.distance).toBeCloseTo(0, 5);
  });
});

describe.skipIf(!VEC_AVAILABLE)("R4 host routes (vector enabled)", () => {
  let dir: string;
  let file: string;
  const disposeListeners: Array<() => void> = [];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dshm-r4host-"));
    file = path.join(dir, "memory.db");
    disposeListeners.length = 0;
  });

  // R6：apply 持有时序上异步关库（Worker 可能在 dispose 时仍在收尾），
  // 清理目录需容忍短暂句柄残留（先等待再重试）。
  afterEach(async () => {
    for (const dispose of disposeListeners) dispose(); // 先释放句柄再删目录
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("H10: /api/search/hybrid 与 /api/config 暴露 vector 视图", async () => {
    interface FakeRoute {
      path: string;
      handler: (
        req: { method?: string; url?: string },
        res: {
          writeHead: (status: number) => void;
          end: (chunk?: string) => void;
        },
      ) => void;
    }
    // 先造数据（独立连接写入后关闭，apply 再接管同库）。
    const s0 = openStore({ file });
    insertMemoryItem(s0.db, {
      type: "personal",
      scope: "global",
      content: "vectorlab hybrid search topic",
      sourceKind: "explicit",
    });
    s0.db.close();

    const routes: FakeRoute[] = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on: (event: string, l: () => void) => {
        if (event === "dispose") disposeListeners.push(l);
      },
      inject: (
        _services: string[],
        cb: (scope: { webServer: { register: (r: FakeRoute) => void } }) => void,
      ) => {
        cb({ webServer: { register: (r: FakeRoute) => routes.push(r) } });
      },
      systemPrompt: { section: () => () => {} },
    } as unknown as Parameters<typeof apply>[0];
    apply(ctx, {
      dataDir: dir,
      markdownEnabled: false,
      vector: { enabled: true, provider: "hash", dimension: 32 },
    });

    const configRoute = routes.find(
      (r) => r.path === "/dsh-memory/api/config",
    );
    const hybridRoute = routes.find(
      (r) => r.path === "/dsh-memory/api/search/hybrid",
    );
    expect(configRoute).toBeDefined();
    expect(hybridRoute).toBeDefined();

    const call = (
      route: FakeRoute,
      url: string,
    ): Promise<{ status: number; body: unknown }> =>
      new Promise((resolve) => {
        let status = 0;
        let payload = "";
        route.handler(
          { method: "GET", url },
          {
            writeHead: (n) => {
              status = n;
            },
            end: (c) => {
              payload = c ?? "";
              resolve({ status, body: JSON.parse(payload) as unknown });
            },
          },
        );
      });

    const cfg = await call(configRoute!, "/dsh-memory/api/config");
    expect(cfg.status).toBe(200);
    const cfgData = (cfg.body as { data: { vector: { enabled: boolean; provider: string; available: boolean } } }).data;
    expect(cfgData.vector.enabled).toBe(true);
    // 视图 provider = 有效 embedding kind（hash 为黑盒非语义实现，如实暴露）。
    expect(cfgData.vector.provider).toBe("local-hash");
    expect(cfgData.vector.available).toBe(true);

    const search = await call(
      hybridRoute!,
      "/dsh-memory/api/search/hybrid?query=vectorlab",
    );
    expect(search.status).toBe(200);
    const searchData = (
      search.body as {
        ok: boolean;
        data: {
          telemetry: {
            candidateCount: number;
            hybrid: {
              mode: string;
              vector: { cacheHits: number; storeCount: number };
            };
          };
        };
      }
    ).data;
    expect(searchData.telemetry.hybrid.mode).toBe("hybrid");
    expect(searchData.telemetry.candidateCount).toBeGreaterThanOrEqual(1);
    expect(searchData.telemetry.hybrid.vector.storeCount).toBeGreaterThanOrEqual(
      1,
    );
  });
});
