/**
 * R7 HTTP 接线层：把 webServer registry 的 /dsh-memory/api/* 路由
 * 映射到 api/* 模块（memories/reviews/system/overview）。本文件只做协议适配
 * （method / path / query / JSON body → api 调用），域规则、参数校验与分页
 * 钳制全部由 api 层完成；未通过 Result 的异常统一回 500。
 *
 * 路由表（均带 ok/data 包装；错误 { ok:false, error }）：
 * - GET  /dsh-memory/api/overview
 * - GET  /dsh-memory/api/system
 * - POST /dsh-memory/api/system/validation          body { dryRun? }
 * - POST /dsh-memory/api/system/vector              body { enabled: boolean }（重启宿主后生效）
 * - POST /dsh-memory/api/system/consolidation
 * - POST /dsh-memory/api/system/cache/clear
 * - POST /dsh-memory/api/system/projection/rebuild
 * - GET  /dsh-memory/api/memories?view&scope&projectId&q&sort&order&limit&offset
 * - POST /dsh-memory/api/memories                    body CreateMemoryInput
 * - GET/PATCH/PUT/DELETE /dsh-memory/api/memories/:id   （DELETE 恒为物理删除禁止）
 * - POST /dsh-memory/api/memories/:id/archive|restore
 * - GET  /dsh-memory/api/conflicts?status&limit&offset
 * - GET  /dsh-memory/api/conflicts/:id
 * - POST /dsh-memory/api/conflicts/:id/resolve       body ResolveConflictInput
 * - POST /dsh-memory/api/conflicts/:id/discard
 * - GET  /dsh-memory/api/quarantine?includeRejected&limit&offset
 * - POST /dsh-memory/api/quarantine/:id/promote
 * - POST /dsh-memory/api/quarantine/:id/reject       body { note? }
 * - GET  /dsh-memory/api/experiences?phase&projectId&limit&offset
 * - GET  /dsh-memory/api/experiences/:id
 * - POST /dsh-memory/api/experiences/:id/advance     body { next? }
 */
import { Buffer } from "node:buffer";
import type {
  HttpRequestLike,
  HttpResponseLike,
  WebRoute,
  WebServerLike,
} from "../cordis/apply.js";
import { toMessage } from "./common.js";
import type { ApiContext } from "./context.js";
import {
  archiveMemory,
  createMemory,
  getMemory,
  listMemories,
  markMemoryDeleted,
  restoreMemory,
  updateMemory,
  type CreateMemoryInput,
  type MemoryEditInput,
  type MemoryListRequest,
} from "./memories.js";
import { dashboardOverview } from "./overview.js";
import {
  advanceExperience,
  discardConflict,
  getConflictReviewApi,
  getExperienceApi,
  listConflictReviewsApi,
  listExperiencesApi,
  listQuarantine,
  promoteQuarantine,
  rejectQuarantine,
  resolveConflict,
  type ConflictListRequest,
  type ExperienceListRequest,
  type QuarantineListRequest,
  type ResolveConflictInput,
} from "./reviews.js";
import {
  clearRetrievalCache,
  rebuildMarkdownProjection,
  runConsolidation,
  runValidation,
  setVectorSearch,
  systemInfo,
} from "./system.js";

const API_BASE = "/dsh-memory/api";

export type ApiResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

function sendJson(res: HttpResponseLike, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendOk(res: HttpResponseLike, data: unknown): void {
  sendJson(res, 200, { ok: true, data });
}

function notAllowed(res: HttpResponseLike): void {
  sendJson(res, 405, { ok: false, error: "method not allowed" });
}

function statusForError(error: string): number {
  const low = error.toLowerCase();
  if (low.includes("not found")) return 404;
  if (
    low.includes("requires worker") ||
    low.includes("requires markdown") ||
    low.includes("requires cache") ||
    low.includes("not enabled") ||
    low.includes("not wired") ||
    low.includes("unavailable")
  ) {
    return 409;
  }
  return 400;
}

/** 把 api 层的 Result 还原成 HTTP 响应；域错误按消息语义归为 4xx。 */
function sendResult(res: HttpResponseLike, result: ApiResult): void {
  if (result.ok) {
    sendOk(res, result.data);
    return;
  }
  sendJson(res, statusForError(result.error), { ok: false, error: result.error });
}

async function readJsonBody(req: HttpRequestLike): Promise<unknown> {
  const withBody = req as HttpRequestLike & { body?: unknown };
  if (typeof withBody.body === "string") {
    return withBody.body.trim() === "" ? {} : (JSON.parse(withBody.body) as unknown);
  }
  if (withBody.body !== undefined) return withBody.body;
  const reader = req as HttpRequestLike & AsyncIterable<Uint8Array | string>;
  if (typeof reader[Symbol.asyncIterator] !== "function") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of reader) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function route(
  handler: (req: HttpRequestLike, res: HttpResponseLike) => Promise<void> | void,
): NonNullable<WebRoute["handler"]> {
  return (req, res) => {
    void (async () => {
      try {
        await handler(req, res);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: toMessage(err) });
      }
    })();
  };
}

function pathOf(url: string | undefined): string {
  return new URL(url ?? "/", "http://localhost").pathname;
}

function paramsOf(url: string | undefined): URLSearchParams {
  return new URL(url ?? "/", "http://localhost").searchParams;
}

/** 去除前缀后切分并解码 path 段；路径不匹配前缀时返回 undefined。 */
function restOf(prefix: string, path: string): string[] | undefined {
  if (!path.startsWith(prefix)) return undefined;
  return path
    .slice(prefix.length)
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));
}

function pstr(params: URLSearchParams, key: string): string | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

function pnum(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function pbool(params: URLSearchParams, key: string): boolean | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function isGet(req: HttpRequestLike, res: HttpResponseLike): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET") notAllowed(res);
  return method === "GET";
}

function isPost(req: HttpRequestLike, res: HttpResponseLike): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "POST") notAllowed(res);
  return method === "POST";
}

/**
 * 把 webServer registry 上 R7 admin 路由映射到 api/* 模块。
 * 与 R6 apply 自带路由（health/config/search/hybrid）不重叠。
 */
export function registerMemoryCenterApi(
  webServer: WebServerLike | undefined,
  ctx: ApiContext,
): void {
  if (webServer === undefined || typeof webServer.register !== "function") return;
  // 宿主 WebServer.register 是 class 方法，依赖 this 访问路由表；解构后裸调会丢 this，
  // 因此用 bind 固定接收者后再作为 helper 调用。
  const register = webServer.register.bind(webServer);
  const exact = (name: string, path: string, handler: WebRoute["handler"]): void => {
    register({ name, kind: "exact", path, handler });
  };
  const prefixRoute = (name: string, pathPrefix: string, handler: WebRoute["handler"]): void => {
    register({ name, kind: "prefix", path: pathPrefix, handler });
  };

  // GET /api/overview —— 控制台聚合视图。
  exact("dsh-memory-api-overview", `${API_BASE}/overview`, (req, res) => {
    if (!isGet(req, res)) return;
    sendResult(res, dashboardOverview(ctx));
  });

  // GET /api/system —— 运行时视图（含 schema/counts/runtime）。
  exact("dsh-memory-api-system", `${API_BASE}/system`, (req, res) => {
    if (!isGet(req, res)) return;
    sendResult(res, systemInfo(ctx));
  });

  // 系统级动作（均需宿主注入对应 ApiActions）。
  exact("dsh-memory-api-system-validation", `${API_BASE}/system/validation`, (req, res) =>
    route(async (req2, res2) => {
      if (!isPost(req2, res2)) return;
      const body = asRecord(await readJsonBody(req2));
      sendResult(
        res2,
        runValidation(ctx, { dryRun: typeof body.dryRun === "boolean" ? body.dryRun : undefined }),
      );
    })(req, res),
  );
  exact("dsh-memory-api-system-consolidation", `${API_BASE}/system/consolidation`, (req, res) =>
    route(async (req2, res2) => {
      if (!isPost(req2, res2)) return;
      sendResult(res2, runConsolidation(ctx));
    })(req, res),
  );
  exact("dsh-memory-api-system-cache-clear", `${API_BASE}/system/cache/clear`, (req, res) =>
    route(async (req2, res2) => {
      if (!isPost(req2, res2)) return;
      sendResult(res2, clearRetrievalCache(ctx));
    })(req, res),
  );
  exact("dsh-memory-api-system-projection-rebuild", `${API_BASE}/system/projection/rebuild`, (req, res) =>
    route(async (req2, res2) => {
      if (!isPost(req2, res2)) return;
      sendResult(res2, rebuildMarkdownProjection(ctx));
    })(req, res),
  );
  // POST /api/system/vector —— 持久化向量检索开关意图（重启生效；未接线 409）。
  exact("dsh-memory-api-system-vector", `${API_BASE}/system/vector`, (req, res) =>
    route(async (req2, res2) => {
      if (!isPost(req2, res2)) return;
      const body = asRecord(await readJsonBody(req2));
      if (typeof body.enabled !== "boolean") {
        sendJson(res2, 400, { ok: false, error: "enabled must be a boolean" });
        return;
      }
      sendResult(res2, setVectorSearch(ctx, body.enabled));
    })(req, res),
  );

  // GET/POST /api/memories —— 列表 + 新增。
  exact("dsh-memory-api-memories", `${API_BASE}/memories`, (req, res) =>
    route(async (req2, res2) => {
      const method = (req2.method ?? "GET").toUpperCase();
      if (method === "GET") {
        const params = paramsOf(req2.url);
        const request = {
          view: pstr(params, "view"),
          scope: pstr(params, "scope"),
          type: pstr(params, "type") ?? pstr(params, "kind"),
          sourceKind: pstr(params, "sourceKind") ?? pstr(params, "source"),
          experiencePhase: pstr(params, "experiencePhase"),
          temporalState: pstr(params, "temporalState"),
          projectId: pstr(params, "projectId") ?? pstr(params, "project"),
          q: pstr(params, "q"),
          sort: pstr(params, "sort"),
          order: pstr(params, "order"),
          limit: pnum(params, "limit"),
          offset: pnum(params, "offset"),
        } as unknown as MemoryListRequest;
        sendResult(res2, listMemories(ctx, request));
        return;
      }
      if (method === "POST") {
        const input = asRecord(await readJsonBody(req2));
        sendResult(res2, createMemory(ctx, input as unknown as CreateMemoryInput));
        return;
      }
      notAllowed(res2);
    })(req, res),
  );

  // /api/memories/:id 以及 :id 子动作。
  prefixRoute(
    "dsh-memory-api-memories-item",
    `${API_BASE}/memories/`,
    route(async (req2, res2) => {
      const parts = restOf(`${API_BASE}/memories/`, pathOf(req2.url));
      if (parts === undefined || parts.length === 0) return notAllowed(res2);
      const method = (req2.method ?? "GET").toUpperCase();
      const id = parts[0];
      if (id === undefined) return notAllowed(res2);
      const action = parts[1];
      if (action === "archive") {
        if (!isPost(req2, res2)) return;
        sendResult(res2, archiveMemory(ctx, id));
        return;
      }
      if (action === "restore") {
        if (!isPost(req2, res2)) return;
        sendResult(res2, restoreMemory(ctx, id));
        return;
      }
      if (action !== undefined) return notAllowed(res2);
      if (method === "GET") {
        sendResult(res2, getMemory(ctx, id));
        return;
      }
      if (method === "PATCH" || method === "PUT") {
        const patch = asRecord(await readJsonBody(req2));
        sendResult(res2, updateMemory(ctx, id, patch as unknown as MemoryEditInput));
        return;
      }
      if (method === "DELETE") {
        // 物理删除始终被禁止：返回域层固定错误（403 语义）。
        const outcome = markMemoryDeleted();
        if (!outcome.ok) sendJson(res2, 403, { ok: false, error: outcome.error });
        return;
      }
      notAllowed(res2);
    }),
  );

  // 冲突评审：列表 / 详情 / resolve / discard。
  exact("dsh-memory-api-conflicts", `${API_BASE}/conflicts`, (req, res) =>
    route(async (req2, res2) => {
      if (!isGet(req2, res2)) return;
      const params = paramsOf(req2.url);
      sendResult(
        res2,
        listConflictReviewsApi(ctx, {
          status: pstr(params, "status"),
          limit: pnum(params, "limit"),
          offset: pnum(params, "offset"),
        } as unknown as ConflictListRequest),
      );
    })(req, res),
  );
  prefixRoute(
    "dsh-memory-api-conflicts-item",
    `${API_BASE}/conflicts/`,
    route(async (req2, res2) => {
      const parts = restOf(`${API_BASE}/conflicts/`, pathOf(req2.url));
      if (parts === undefined || parts.length === 0) return notAllowed(res2);
      const id = parts[0];
      if (id === undefined) return notAllowed(res2);
      const action = parts[1];
      if (action === undefined) {
        if (!isGet(req2, res2)) {
          notAllowed(res2);
          return;
        }
        sendResult(res2, getConflictReviewApi(ctx, id));
        return;
      }
      if (action === "resolve") {
        if (!isPost(req2, res2)) return;
        const input = asRecord(await readJsonBody(req2));
        sendResult(res2, resolveConflict(ctx, id, input as unknown as ResolveConflictInput));
        return;
      }
      if (action === "discard") {
        if (!isPost(req2, res2)) return;
        sendResult(res2, discardConflict(ctx, id));
        return;
      }
      notAllowed(res2);
    }),
  );

  // 隔离区：列表 / promote / reject。
  exact("dsh-memory-api-quarantine", `${API_BASE}/quarantine`, (req, res) =>
    route(async (req2, res2) => {
      if (!isGet(req2, res2)) return;
      const params = paramsOf(req2.url);
      sendResult(
        res2,
        listQuarantine(ctx, {
          includeRejected: pbool(params, "includeRejected"),
          limit: pnum(params, "limit"),
          offset: pnum(params, "offset"),
        } as unknown as QuarantineListRequest),
      );
    })(req, res),
  );
  prefixRoute(
    "dsh-memory-api-quarantine-item",
    `${API_BASE}/quarantine/`,
    route(async (req2, res2) => {
      const parts = restOf(`${API_BASE}/quarantine/`, pathOf(req2.url));
      if (parts === undefined || parts.length === 0) return notAllowed(res2);
      const id = parts[0];
      if (id === undefined) return notAllowed(res2);
      const action = parts[1];
      if (action === "promote") {
        if (!isPost(req2, res2)) return;
        sendResult(res2, promoteQuarantine(ctx, id));
        return;
      }
      if (action === "reject") {
        if (!isPost(req2, res2)) return;
        const body = asRecord(await readJsonBody(req2));
        const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note : undefined;
        sendResult(res2, rejectQuarantine(ctx, id, note));
        return;
      }
      notAllowed(res2);
    }),
  );

  // 经验库：列表 / 详情 / advance。
  exact("dsh-memory-api-experiences", `${API_BASE}/experiences`, (req, res) =>
    route(async (req2, res2) => {
      if (!isGet(req2, res2)) return;
      const params = paramsOf(req2.url);
      sendResult(
        res2,
        listExperiencesApi(ctx, {
          phase: pstr(params, "phase"),
          projectId: pstr(params, "projectId") ?? pstr(params, "project"),
          includeHistorical: pbool(params, "includeHistorical"),
          limit: pnum(params, "limit"),
          offset: pnum(params, "offset"),
        } as unknown as ExperienceListRequest),
      );
    })(req, res),
  );
  prefixRoute(
    "dsh-memory-api-experiences-item",
    `${API_BASE}/experiences/`,
    route(async (req2, res2) => {
      const parts = restOf(`${API_BASE}/experiences/`, pathOf(req2.url));
      if (parts === undefined || parts.length === 0) return notAllowed(res2);
      const id = parts[0];
      if (id === undefined) return notAllowed(res2);
      const action = parts[1];
      if (action === undefined) {
        if (!isGet(req2, res2)) {
          notAllowed(res2);
          return;
        }
        sendResult(res2, getExperienceApi(ctx, id));
        return;
      }
      if (action === "advance") {
        if (!isPost(req2, res2)) return;
        const body = asRecord(await readJsonBody(req2));
        sendResult(res2, advanceExperience(ctx, id, body.next));
        return;
      }
      notAllowed(res2);
    }),
  );
}
