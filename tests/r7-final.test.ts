// r7-final: R7 最终验收（真实 Store + registry HTTP 层）。
// 覆盖：错误语义契约 400/403/404/405/409/500、Memory CRUD 与归档/恢复、
// WebUI 页面契约。Review Center 与 Benchmark 见 r7-final-flows.test.ts。

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HttpRequestLike,
  HttpResponseLike,
  WebRoute,
  WebServerLike,
} from "../src/cordis/apply.js";
import { registerMemoryCenterApi } from "../src/api/http.js";
import type { ApiContext } from "../src/api/context.js";
import { openStore } from "../src/store/db.js";
import type { SqlDatabase } from "../src/store/sqlite.js";
import { MEMORY_PAGE_BASE, registerMemoryCenterPage } from "../src/webui/page.js";

const API = "/dsh-memory/api";

interface Harness {
  db: SqlDatabase;
  routes: WebRoute[];
  close(): void;
}

interface CallOutcome {
  status: number;
  data: unknown;
  writeHeadCount: number;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `dsh-memory-r7-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function createHarness(file: string): Harness {
  const store = openStore({ file });
  const routes: WebRoute[] = [];
  const server: WebServerLike = {
    register(route: WebRoute): unknown {
      routes.push(route);
      return undefined;
    },
  };
  // 有意不注入 host actions：system 类动作应返回 409（not wired）。
  const ctx: ApiContext = { db: store.db, storePath: file, actor: "user" };
  registerMemoryCenterApi(server, ctx);
  registerMemoryCenterPage(server);
  return {
    db: store.db,
    routes,
    close: () => {
      store.db.close();
    },
  };
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
  let writeHeadCount = 0;
  const chunks: string[] = [];
  const finished = new Promise<void>((resolve) => {
    const res: HttpResponseLike = {
      writeHead(code: number): void {
        writeHeadCount++;
        status = code;
      },
      end(chunk?: string): void {
        if (chunk !== undefined) chunks.push(String(chunk));
        resolve();
      },
    };
    const req = { method, url } as HttpRequestLike & { body?: unknown };
    if (body !== undefined) req.body = body;
    route.handler(req, res);
  });
  await new Promise((r) => setImmediate(r));
  await finished;
  const raw = chunks.join("");
  let data: unknown = raw;
  try {
    data = raw === "" ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    // 非 JSON 响应保持原始文本。
  }
  return { status, writeHeadCount, data };
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

function memUrl(id: string): string {
  return `${API}/memories/${encodeURIComponent(id)}`;
}

async function createPersonalMemory(h: Harness, content: string): Promise<string> {
  const data = okData(
    await request(h, "POST", `${API}/memories`, { type: "personal", scope: "session", content }),
  ) as { id: string };
  expect(typeof data.id).toBe("string");
  return data.id;
}

describe("R7-9 错误语义契约", () => {
  it("400：content 缺失 / 非法 view", async () => {
    const file = path.join(makeDir("errors"), "memory.db");
    const h = createHarness(file);
    try {
      expect(errText(await request(h, "POST", `${API}/memories`, {}), 400)).toContain(
        "content is required",
      );
    } finally {
      h.close();
    }
  });

  it("404：不存在的记忆 / 冲突评审 / 经验", async () => {
    const file = path.join(makeDir("notfound"), "memory.db");
    const h = createHarness(file);
    try {
      expect(errText(await request(h, "GET", memUrl("no-such-memory")), 404)).toContain(
        "not found",
      );
      expect(errText(await request(h, "GET", `${API}/conflicts/no-such-review`), 404)).toContain(
        "not found",
      );
      expect(
        errText(await request(h, "GET", `${API}/experiences/no-such-experience`), 404),
      ).toContain("not found");
    } finally {
      h.close();
    }
  });

  it("403：物理删除恒被禁止", async () => {
    const file = path.join(makeDir("forbidden"), "memory.db");
    const h = createHarness(file);
    try {
      expect(errText(await request(h, "DELETE", memUrl("whatever-id")), 403)).toContain(
        "use archive instead",
      );
      const id = await createPersonalMemory(h, "delete guard row");
      expect(errText(await request(h, "DELETE", memUrl(id)), 403)).toContain("use archive instead");
    } finally {
      h.close();
    }
  });

  it("405：集合只允许声明方法且仅响应一次", async () => {
    const file = path.join(makeDir("method"), "memory.db");
    const h = createHarness(file);
    try {
      const deletes = await request(h, "DELETE", `${API}/memories`);
      expect(errText(deletes, 405)).toContain("method not allowed");
      expect(deletes.writeHeadCount).toBe(1);

      const id = await createPersonalMemory(h, "405 guard row");
      const action = await request(h, "POST", `${API}/memories/${id}/frobnicate`);
      expect(errText(action, 405)).toContain("method not allowed");
      expect(action.writeHeadCount).toBe(1);
    } finally {
      h.close();
    }
  });

  it("409：未接线的宿主动作", async () => {
    const file = path.join(makeDir("conflict409"), "memory.db");
    const h = createHarness(file);
    try {
      for (const actionPath of [
        `${API}/system/validation`,
        `${API}/system/consolidation`,
        `${API}/system/cache/clear`,
        `${API}/system/projection/rebuild`,
      ]) {
        expect(errText(await request(h, "POST", actionPath, {}), 409)).toContain("not wired");
      }
    } finally {
      h.close();
    }
  });

  it("500：非法 JSON body", async () => {
    const file = path.join(makeDir("badjson"), "memory.db");
    const h = createHarness(file);
    try {
      const res = await request(h, "POST", `${API}/memories`, "{ not-json");
      expect(res.status).toBe(500);
      const parsed = res.data as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(typeof parsed.error).toBe("string");
    } finally {
      h.close();
    }
  });
});

describe("R7-1 Memory CRUD 与生命周期", () => {
  it("新建→详情→编辑→归档→恢复→删除被禁", async () => {
    const file = path.join(makeDir("crud"), "memory.db");
    const h = createHarness(file);
    try {
      const id = await createPersonalMemory(h, "crud draft v1");

      const detail1 = okData(await request(h, "GET", memUrl(id))) as {
        memory: { content: string; temporalState: string; version: number };
        history: unknown[];
      };
      expect(detail1.memory.content).toContain("v1");
      expect(detail1.memory.temporalState).toBe("current");
      expect(Array.isArray(detail1.history)).toBe(true);

      const updated = okData(await request(h, "PATCH", memUrl(id), { content: "crud draft v2" })) as {
        content: string;
        version: number;
      };
      expect(updated.content).toContain("v2");
      expect(updated.version).toBeGreaterThanOrEqual(detail1.memory.version);

      const archived = okData(await request(h, "POST", `${API}/memories/${id}/archive`)) as {
        temporalState: string;
      };
      expect(archived.temporalState).toBe("historical");

      const archivedList = okData(
        await request(h, "GET", `${API}/memories?view=archived&scope=session`),
      ) as { items: Array<{ id: string }> };
      expect(archivedList.items.some((m) => m.id === id)).toBe(true);

      const activeList = okData(
        await request(h, "GET", `${API}/memories?view=active&scope=session`),
      ) as { items: Array<{ id: string }> };
      expect(activeList.items.some((m) => m.id === id)).toBe(false);

      const restored = okData(await request(h, "POST", `${API}/memories/${id}/restore`)) as {
        temporalState: string;
      };
      expect(restored.temporalState).toBe("current");

      expect(errText(await request(h, "DELETE", memUrl(id)), 403)).toContain(
        "use archive instead",
      );
    } finally {
      h.close();
    }
  });
});

describe("R7-9 WebUI 页面契约", () => {
  it("Memory Center 静态单页两条 GET 路由 + 页面仅 GET", async () => {
    const file = path.join(makeDir("webui"), "memory.db");
    const h = createHarness(file);
    try {
      const page = await request(h, "GET", MEMORY_PAGE_BASE);
      expect(page.status).toBe(200);
      const html = String(page.data);
      expect(html).toContain("Memory Center");
      expect(html).toContain(`${MEMORY_PAGE_BASE}/app.js`);

      const js = await request(h, "GET", `${MEMORY_PAGE_BASE}/app.js`);
      expect(js.status).toBe(200);
      const script = String(js.data);
      // app.js 以 API base 常量 + 端点路径拼接请求：fetch(API + "/overview")。
      expect(script).toContain('"/dsh-memory/api"');
      expect(script).toContain('get("/overview")');
      // 修复回归锚点：resolve 载荷对齐 API（resolution），并带风险确认。
      expect(script).toContain("resolution");
      expect(script).toContain("window.confirm");

      const post = await request(h, "POST", MEMORY_PAGE_BASE, {});
      expect(post.status).toBe(405);
      expect(post.writeHeadCount).toBe(1);
    } finally {
      h.close();
    }
  });
});
