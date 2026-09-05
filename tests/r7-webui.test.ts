// r7-webui: R7-2/3 WebUI 验证。
// - view-model 纯函数与 API 视图结构一致；
// - /dsh-memory/memory 页面与 app.js 资源可达且内容完整；
// - 屏幕清单与 http registry 端点契约一致。

import { describe, expect, it } from "vitest";
import type {
  HttpResponseLike,
  HttpRequestLike,
  WebRoute,
  WebServerLike,
} from "../src/cordis/apply.js";
import type { DashboardOverview } from "../src/api/overview.js";
import type { AuditRowView } from "../src/api/reads.js";
import {
  MEMORY_CENTER_SCREENS,
  activityRows,
  memoryRowSummary,
  overviewCards,
} from "../src/webui/models.js";
import { MEMORY_PAGE_BASE, registerMemoryCenterPage } from "../src/webui/page.js";

describe("R7-2 view-models", () => {
  it("屏幕清单契约：库/评审/运维六屏 + 端点与 http registry 对齐", () => {
    const ids = MEMORY_CENTER_SCREENS.map((s) => s.id);
    expect(ids).toEqual([
      "overview",
      "memories",
      "experiences",
      "conflicts",
      "quarantine",
      "system",
    ]);
    const endpoints = MEMORY_CENTER_SCREENS.map((s) => s.endpoint).sort();
    expect(endpoints).toEqual([
      "/conflicts",
      "/experiences",
      "/memories",
      "/overview",
      "/quarantine",
      "/system",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("overviewCards 汇总 8 张主卡", () => {
    const overview = {
      memory: {
        total: 10,
        active: 6,
        quarantinedPending: 2,
        archived: 2,
        byScope: [],
        byType: [],
        bySource: [],
        byTemporal: [],
      },
      experience: { active: 3 },
      review: { conflicts: { open: 1, resolved: 2, discarded: 1 } },
    } as unknown as DashboardOverview;
    const cards = overviewCards(overview);
    expect(cards).toEqual([
      { label: "Memories", value: 10 },
      { label: "Active", value: 6 },
      { label: "Quarantined", value: 2 },
      { label: "Archived", value: 2 },
      { label: "Experiences", value: 3 },
      { label: "Open conflicts", value: 1 },
      { label: "Conflicts resolved", value: 2 },
      { label: "Conflicts discarded", value: 1 },
    ]);
  });

  it("activityRows 投影 audit 行", () => {
    const rows: AuditRowView[] = [
      {
        id: "audit-1",
        ts: "2026-09-04T10:00:00.000Z",
        actor: "user",
        action: "memory.create",
        entityType: "memory",
        entityId: "mem-1",
        before: undefined,
        after: { content: "x" },
      },
    ];
    expect(activityRows(rows)).toEqual([
      {
        ts: "2026-09-04T10:00:00.000Z",
        actor: "user",
        action: "memory.create",
        entityType: "memory",
        entityId: "mem-1",
      },
    ]);
  });

  it("memoryRowSummary 兼容扁平与 row.* 嵌套两种行形态", () => {
    const flat = {
      id: "m1",
      type: "project_knowledge",
      scope: "project",
      projectId: "p1",
      content: "flat row",
      confidence: 0.8,
    };
    const row = memoryRowSummary(flat);
    expect(row?.projectId).toBe("p1");
    expect(row?.content).toBe("flat row");
    expect(row?.importance).toBe("normal");

    const nested = {
      row: {
        id: "m2",
        type: "experience",
        scope: "project",
        project_id: "p2",
        content: "nested row",
        confidence: "0.7",
        temporalState: "current",
      },
    };
    const row2 = memoryRowSummary(nested);
    expect(row2?.id).toBe("m2");
    expect(row2?.projectId).toBe("p2");
    expect(row2?.confidence).toBeCloseTo(0.7, 5);

    expect(memoryRowSummary(null)).toBeNull();
  });
});

describe("R7-2/3 Memory Center 页面", () => {
  function pageServer() {
    const routes: WebRoute[] = [];
    const server: WebServerLike = {
      register: (route) => {
        routes.push(route);
        return undefined;
      },
    };
    registerMemoryCenterPage(server);
    return routes;
  }

  async function getText(routes: WebRoute[], url: string): Promise<{ status: number; text: string }> {
    const route = routes.find((r) => r.kind === "exact" && r.path === url.split("?")[0]);
    if (route === undefined) throw new Error(`no route for ${url}`);
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
    const req = { method: "GET", url } as HttpRequestLike;
    route.handler(req, res);
    return { status, text: payload };
  }

  it("页面与 SPA 资源可达（exact 路由、GET 文本返回）", async () => {
    const routes = pageServer();
    expect(routes.map((r) => r.path)).toContain(MEMORY_PAGE_BASE);
    expect(routes.map((r) => r.path)).toContain(`${MEMORY_PAGE_BASE}/app.js`);

    const html = await getText(routes, MEMORY_PAGE_BASE);
    expect(html.status).toBe(200);
    expect(html.text).toContain("Memory Center");
    expect(html.text).toContain('<div id="mc-root"></div>');
    expect(html.text).toContain(`${MEMORY_PAGE_BASE}/app.js`);
    expect(html.text).toContain('"id":"memories"');
    expect(html.text).toContain('"id":"conflicts"');

    const js = await getText(routes, `${MEMORY_PAGE_BASE}/app.js`);
    expect(js.status).toBe(200);
    expect(js.text).toContain("/dsh-memory/api");
    expect(js.text).toContain("renderOverview");
    expect(js.text).toContain("renderConflicts");
    expect(js.text).toContain("renderQuarantine");
    // 评审与运维动作统一指向 R7-1 registry 的动作端点。
    expect(js.text).toContain("/conflicts\" + idPath + \"/resolve");
    expect(js.text).toContain("/quarantine\" + idPath + \"/promote");
    expect(js.text).toContain("/system/validation");
    expect(js.text).toContain("/system/consolidation");
    expect(js.text).toContain("/system/cache/clear");
    expect(js.text).toContain("/system/projection/rebuild");
  });

  it("页面只读：非 GET 返回 405", async () => {
    const routes = pageServer();
    const route = routes.find((r) => r.path === MEMORY_PAGE_BASE);
    expect(route).toBeDefined();
    let status = 0;
    const res: HttpResponseLike = {
      writeHead: (code) => {
        status = code;
      },
      end: () => undefined,
    };
    route?.handler({ method: "POST", url: MEMORY_PAGE_BASE } as HttpRequestLike, res);
    expect(status).toBe(405);
  });
});
