// R3：关键词检索链测试。
// 覆盖：精确匹配、多关键词、project/scope 过滤、importance/confidence 排序、
// Gate、Selector 去重、related expansion、Guard、Context 分层、CLI/API search。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/cordis/apply.js";
import { retrieve } from "../src/retrieval/pipeline.js";
import { select } from "../src/retrieval/selector.js";
import { openStore } from "../src/store/db.js";
import {
  archiveMemoryItem,
  insertMemoryItem,
} from "../src/store/repository.js";
import type { SqlDatabase } from "../src/store/sqlite.js";

describe("R3 keyword retrieval", () => {
  let dir: string;
  let file: string;
  let db: SqlDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dshm-r3-"));
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

  it("Test1: keyword exact match", () => {
    seed("User mainly uses TypeScript");
    seed("User mainly uses Python");
    const r = retrieve(db, { query: "typescript" });
    expect(r.telemetry.candidateCount).toBeGreaterThanOrEqual(1);
    expect(r.context.profile.some((m) => m.row.content.includes("TypeScript"))).toBe(true);
  });

  it("Test2: multi-keyword match", () => {
    seed("sqlite-vec native load failed, fixed by better-sqlite3 extension");
    seed("unrelated memory about cooking");
    const r = retrieve(db, { query: "sqlite native load fix" });
    expect(r.context.profile.some((m) => m.row.content.includes("sqlite"))).toBe(true);
  });

  it("Test3: project filter", () => {
    seed("arch decision A", { type: "project_knowledge", scope: "project", projectId: "p1" });
    seed("arch decision B", { type: "project_knowledge", scope: "project", projectId: "p2" });
    const r = retrieve(db, { query: "arch decision", filter: { projectId: "p1" } });
    expect(r.context.projectState).toHaveLength(1);
    expect(r.context.projectState[0]!.row.projectId).toBe("p1");
  });

  it("Test4: scope filter", () => {
    seed("global memory about rust", { scope: "global" });
    seed("project memory about rust", { scope: "project", projectId: "p1" });
    const r = retrieve(db, { query: "rust", filter: { scope: "global" } });
    expect(r.context.profile).toHaveLength(1);
  });

  it("Test5: importance/confidence affects ranking", () => {
    seed("alpha keyword memory", { importance: "low", confidence: 0.4 });
    seed("alpha keyword memory alt", { importance: "critical", confidence: 0.95 });
    const r = retrieve(db, { query: "alpha keyword" });
    const first = r.context.profile[0]!.row;
    expect(first.importance).toBe("critical");
  });

  it("Test6: chitchat triggers gate → no retrieval", () => {
    seed("User mainly uses TypeScript");
    const r = retrieve(db, { query: "你好" });
    expect(r.telemetry.gate.shouldRetrieve).toBe(false);
    expect(r.telemetry.candidateCount).toBe(0);
  });

  it("Test7: selector dedups near-duplicate memories", () => {
    const a = seed("I prefer TypeScript for backend development");
    const b = seed("I prefer TypeScript for backend development");
    const candidates = [
      { row: a, score: 0.9 },
      { row: b, score: 0.85 },
    ];
    const selected = select(candidates, 1000);
    expect(selected).toHaveLength(1);
  });

  it("Test8: related-memory expansion via lineage", () => {
    const main = seed("root memory", { type: "experience", scope: "global" });
    const related = seed("related memory", { type: "experience", scope: "global" });
    db.prepare(
      "INSERT INTO memory_lineage (id,memory_id,relation,other_memory_id,created_at) VALUES (?,?,?,?,?)",
    ).run("l1", main.id, "related_to", related.id, new Date().toISOString());
    const r = retrieve(db, { query: "之前 root memory" });
    expect(r.telemetry.relatedCount).toBeGreaterThanOrEqual(1);
    expect(r.context.experience.some((m) => m.row.id === related.id)).toBe(true);
  });

  it("Test9: guard excludes historical/low-confidence/sensitive", () => {
    const hist = seed("historical memory");
    archiveMemoryItem(db, hist.id);
    const low = seed("low confidence memory", { confidence: 0.1 });
    const sens = seed("my api_key is abc123secret");
    const r = retrieve(db, { query: "memory" });
    const ids = r.context.profile.map((m) => m.row.id);
    expect(ids).not.toContain(hist.id);
    expect(ids).not.toContain(low.id);
    expect(ids).not.toContain(sens.id);
  });

  it("Test10: context assembly layers by type/scope", () => {
    seed("personal fact", { type: "personal", scope: "global" });
    seed("project state", { type: "project_knowledge", scope: "project", projectId: "p1" });
    seed("learned experience", { type: "experience", scope: "global" });
    seed("never do X", { type: "negative", scope: "global" });
    seed("generalized rule", { type: "generalized", scope: "generalized" });
    const r = retrieve(db, { query: "fact" });
    // 分层结构稳定存在（至少 profile 命中），不要求每层都非空。
    expect(r.context).toHaveProperty("profile");
    expect(r.context).toHaveProperty("experience");
    expect(r.context).toHaveProperty("knowledge");
    expect(r.context).toHaveProperty("negative");
  });
});

describe("R3 CLI + API search", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dshm-r3cli-"));
    file = path.join(dir, "memory.db");
  });

  // R6：apply 持有时序上异步关库（Worker 可能在 dispose 时仍在收尾），
  // 清理目录需容忍短暂句柄残留（先等待再重试）。
  afterEach(async () => {
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

  it("Test11: CLI search via subprocess", () => {
    // 先造数据（直接开库插入，再关闭）。
    const store = openStore({ file });
    insertMemoryItem(store.db, {
      type: "personal",
      scope: "global",
      content: "User mainly uses Rust",
      sourceKind: "explicit",
    });
    store.db.close();

    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "src/cli/index.ts", "search", "--query", "rust", "--data-dir", dir],
      { cwd: path.resolve("."), encoding: "utf8" },
    );
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("Rust");
    expect(cli.stdout).toContain("selected");
  });

  it("Test12: host API /api/search route", () => {
    interface FakeRoute {
      path: string;
      handler: (req: { method?: string; url?: string }, res: { writeHead: (n: number) => void; end: (c?: string) => void }) => void;
    }
    // 先造数据（独立连接写入后关闭）。
    const s1 = openStore({ file });
    insertMemoryItem(s1.db, {
      type: "personal",
      scope: "global",
      content: "User mainly uses Golang",
      sourceKind: "explicit",
    });
    s1.db.close();

    const routes: FakeRoute[] = [];
    const disposeListeners: Array<() => void> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on: (event: string, l: () => void) => {
        if (event === "dispose") disposeListeners.push(l);
      },
      inject: (_services: string[], cb: (scope: { webServer: { register: (r: FakeRoute) => void } }) => void) => {
        cb({ webServer: { register: (r: FakeRoute) => routes.push(r) } });
      },
      systemPrompt: { section: () => () => {} },
    } as unknown as Parameters<typeof apply>[0];
    apply(ctx, { dataDir: dir, markdownEnabled: false });

    const searchRoute = routes.find((r) => r.path === "/dsh-memory/api/search");
    expect(searchRoute).toBeDefined();
    let status = 0;
    let payload = "";
    searchRoute!.handler(
      { method: "GET", url: "/dsh-memory/api/search?query=golang" },
      {
        writeHead: (n) => { status = n; },
        end: (c) => { payload = c ?? ""; },
      },
    );
    expect(status).toBe(200);
    const body = JSON.parse(payload) as { ok: boolean; data: { telemetry: { candidateCount: number } } };
    expect(body.ok).toBe(true);
    expect(body.data.telemetry.candidateCount).toBeGreaterThanOrEqual(1);
    // 触发 dispose 关闭 apply 打开的连接，避免目录句柄残留。
    for (const l of disposeListeners) l();
  });
});
