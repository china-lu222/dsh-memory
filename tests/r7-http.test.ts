// r7-http: R7 接线层（registerMemoryCenterApi）行为验证。
// - 用结构等价的假 Cordis Context + 假 webServer 驱动 apply()，再按真实 URL 分派路由。
// - 断言 admin 数据路由可达、动作路由的 4xx 语义（403/404/405）正确。

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  type CordisContext,
  type CordisLogger,
  type HttpResponseLike,
  type HttpRequestLike,
  type WebRoute,
  type WebServerLike,
} from "../src/cordis/apply.js";

const API_BASE = "/dsh-memory/api";

interface FakeCtx {
  ctx: CordisContext;
  routes: WebRoute[];
  dispose(): void;
}

function makeFakeCtx(): FakeCtx {
  const routes: WebRoute[] = [];
  const disposeListeners: Array<() => void> = [];
  const logger: CordisLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const ctx: CordisContext = {
    on: (event, listener) => {
      if (event === "dispose") disposeListeners.push(listener as () => void);
      return undefined;
    },
    inject: (_services, callback) => {
      const webServer: WebServerLike = {
        register: (route) => {
          routes.push(route);
          return undefined;
        },
      };
      callback({ webServer });
    },
    logger,
  } as CordisContext;
  return {
    ctx,
    routes,
    dispose: () => {
      for (const listener of disposeListeners) listener();
    },
  };
}

interface Reply {
  status: number;
  body: { ok?: boolean; data?: unknown; error?: string };
}

async function dispatch(
  fake: FakeCtx,
  method: string,
  url: string,
  body?: unknown,
): Promise<Reply> {
  const requestPath = url.split("?")[0] ?? url;
  const route = fake.routes.find((r) =>
    r.kind === "exact" ? r.path === requestPath : requestPath.startsWith(r.path),
  );
  if (route === undefined) throw new Error(`no route for ${method} ${url}`);
  let status = 0;
  let payload = "";
  const res: HttpResponseLike = {
    writeHead: (code) => {
      status = code;
    },
    end: (chunk) => {
      payload = typeof chunk === "string" ? chunk : String(chunk);
    },
  };
  const req = { method, url } as HttpRequestLike;
  if (body !== undefined) Object.assign(req, { body: JSON.stringify(body) });
  route.handler(req, res);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { status, body: JSON.parse(payload || "null") as Reply["body"] };
}

describe("R7 HTTP 接线层（registerMemoryCenterApi 经 apply 注入）", () => {
  let dir: string;
  let fake: FakeCtx;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r7-"));
    fake = makeFakeCtx();
    apply(fake.ctx, { dataDir: dir, markdownEnabled: false });
  });

  afterEach(() => {
    fake.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("admin 路由均已注册（exact + 子资源 prefix）", () => {
    const paths = fake.routes.map((r) => r.path);
    for (const p of [
      `${API_BASE}/overview`,
      `${API_BASE}/system`,
      `${API_BASE}/system/validation`,
      `${API_BASE}/memories`,
      `${API_BASE}/memories/`,
      `${API_BASE}/conflicts`,
      `${API_BASE}/quarantine`,
      `${API_BASE}/quarantine/`,
      `${API_BASE}/experiences`,
    ]) {
      expect(paths).toContain(p);
    }
  });

  it("overview / system / 各列表数据路由返回 ok:true", async () => {
    const overview = await dispatch(fake, "GET", `${API_BASE}/overview`);
    expect(overview.status).toBe(200);
    expect(overview.body.ok).toBe(true);

    const system = await dispatch(fake, "GET", `${API_BASE}/system`);
    expect(system.status).toBe(200);
    expect(system.body.ok).toBe(true);

    for (const endpoint of [
      `${API_BASE}/memories`,
      `${API_BASE}/conflicts`,
      `${API_BASE}/quarantine`,
      `${API_BASE}/experiences`,
    ]) {
      const reply = await dispatch(fake, "GET", endpoint);
      expect(reply.status).toBe(200);
      expect(reply.body.ok).toBe(true);
    }
  });

  it("validation 动作可同步执行（worker 无关）", async () => {
    const reply = await dispatch(fake, "POST", `${API_BASE}/system/validation`, {});
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(true);
  });

  it("物理删除走 403（物理删除被域层禁止）", async () => {
    const reply = await dispatch(fake, "DELETE", `${API_BASE}/memories/some-id`);
    expect(reply.status).toBe(403);
    expect(reply.body.ok).toBe(false);
  });

  it("detail 资源路由转发域错误（404 语义由错误消息映射）", async () => {
    const reply = await dispatch(fake, "GET", `${API_BASE}/memories/not-exists`);
    expect(reply.body.ok).toBe(false);
    expect(reply.status).toBeGreaterThanOrEqual(400);
  });

  it("未知子动作与非法集合方法返回 405", async () => {
    const unknownAction = await dispatch(
      fake,
      "POST",
      `${API_BASE}/memories/some-id/frobnicate`,
    );
    expect(unknownAction.status).toBe(405);

    const collectionDelete = await dispatch(fake, "DELETE", `${API_BASE}/memories`);
    expect(collectionDelete.status).toBe(405);
  });
});
