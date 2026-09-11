// dsh-memory — host half (TS R1): 最小可运行 Cordis 入口。
// 配置 → 打开/安全迁移 Memory Store（旧库同文件接管，决策 B）→ 生命周期 dispose → 最小健康/状态路由。
// 导出形态与旧 JS 实现一致（named apply + inject），宿主可同样加载；不依赖 skills/RAG-doc-fetcher 与 DSH Core 运行时文件。

import { dirname, join } from "node:path";
import {
  TaskBoundaryAdapter,
  type TaskBoundaryStats,
} from "../auto/boundary.js";
import { AutoMemoryService, type AutoMemoryStats } from "../auto/host.js";
import { MemoryCache } from "../cache/memory-cache.js";
import { cachedHybridRetrieve, cachedKeywordRetrieve } from "../cache/retrieve-cached.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../embedding/provider.js";
import { runHygieneScan } from "../memory/validation.js";
import { resolveStoreFile } from "../paths.js";
import { MarkdownProjectionService } from "../projection/service.js";
import { watchMemoryDir } from "../projection/watcher.js";
import { DefaultReranker, type RerankerProvider } from "../rerank/provider.js";
import { LruEmbeddingCache, type EmbeddingCache } from "../retrieval/cache.js";
import { retrieve } from "../retrieval/pipeline.js";
import { retrieveHybrid, type HybridRetrievalRequest } from "../retrieval/hybrid.js";
import type { RetrievalRequest } from "../retrieval/types.js";
import { defaultWorkerConsumers, scheduleDeepConsolidation } from "../worker/handlers.js";
import { DurableWorker } from "../worker/worker.js";
import type { MemoryScope } from "../schema/enums.js";
import { openStoreWithTakeover, type OpenedStoreWithTakeover } from "../store/db.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { VectorProjectionService } from "../vector/projection.js";
import { SqliteVecStore } from "../vector/sqlite-vec-store.js";
import type { VectorStore } from "../vector/types.js";
import type { FusionStrategy } from "../retrieval/fusion.js";
import type { ApiActions, ApiRuntimeSnapshot } from "../api/context.js";
import { registerMemoryCenterApi } from "../api/http.js";
import { registerEventsStream, type EventsStreamHub } from "../stream/sse.js";
import { registerMemoryCenterPage } from "../webui/page.js";
import {
  readVectorUiOverride,
  writeVectorUiOverride,
} from "./vector-ui-override.js";

/** Required at apply time: the system-prompt section seat. */
export const inject = ["systemPrompt"];

export interface PluginConfig {
  /** 插件总开关；false 时 apply() 直接返回，不打开存储 */
  enabled?: boolean;
  /** 是否在 systemPrompt 席位发布插件引导段 */
  announceToAgent?: boolean;
  /** 数据目录：绝对路径或相对插件根；缺省 DSH_MEMORY_DATA_DIR 或 <插件根>/data */
  dataDir?: string;
  /** DB 文件名；缺省 memory.db（沿用旧插件文件名，同文件升级） */
  dbFile?: string;
  /** 是否启用 Markdown Projection（DB↔MD 双向同步，R2）；缺省 true */
  markdownEnabled?: boolean;
  /** Markdown 投影根目录；缺省 <dataDir>/memory */
  markdownDir?: string;
  /** R4 Vector Retrieval（可选）：缺省关闭，此时行为与 R3 完全一致 */
  vector?: VectorPluginConfig;
  /** R6 Finalization：后台 Durable Worker（消费 durable events 队列）。缺省启用 */
  worker?: WorkerPluginConfig;
  /** R6 Finalization：定时 consolidation 调度入口（依赖 Worker 消费；缺省启用） */
  consolidation?: ConsolidationPluginConfig;
  /** R6 Finalization：Continuous Validation（hygiene）定时扫描。缺省启用 */
  validation?: ValidationPluginConfig;
  /** R6 Finalization：Memory Cache（上下文感知检索缓存）。缺省启用 */
  cache?: { enabled?: boolean };
  /** R6 Finalization：Cost/Budget 决策记录（telemetry，检索请求级）。缺省启用 */
  budget?: { enabled?: boolean };
  /** R8.1：正常聊天自动产生记忆（订阅宿主 session/event）。缺省启用 */
  autoMemory?: AutoMemoryPluginConfig;
}

export interface AutoMemoryPluginConfig {
  /** 是否订阅宿主会话事件自动学习；缺省 true（false 时只剩显式 remember/CLI/API）。 */
  enabled?: boolean;
  /** 是否观测 assistant 回复；缺省 true（结论与失败归因常出现在回复中）。 */
  observeAssistant?: boolean;
  /** 单条消息进入队列的字符数上限；缺省 4000。 */
  maxChars?: number;
  /** 会话所属项目 id；提供后非 personal 候选落 project scope，缺省 null（global）。 */
  projectId?: string;
  /** 是否在任务边界（turn/end completed）自动沉淀经验；缺省 true。 */
  taskExperience?: boolean;
}

export interface WorkerPluginConfig {
  enabled?: boolean;
  /** 轮询间隔（毫秒）。 */
  pollMs?: number;
  /** 认领租约（毫秒）。 */
  leaseMs?: number;
  /** 重试上限；达上限转 dead。 */
  maxAttempts?: number;
  /** 首次退避基数（毫秒）。 */
  baseBackoffMs?: number;
  /** 单轮循环最多处理条数（0 = 不限）。 */
  maxPerBatch?: number;
  /** 未注册 handler 的事件：fail | ignore。 */
  onUnhandled?: "fail" | "ignore";
}

export interface ConsolidationPluginConfig {
  enabled?: boolean;
  /** 调度尝试间隔（毫秒）；幂等键按小时去重。 */
  intervalMs?: number;
}

export interface ValidationPluginConfig {
  enabled?: boolean;
  /** 扫描间隔（毫秒）。 */
  intervalMs?: number;
  /** 仅扫描并记录、不改写记忆。 */
  dryRun?: boolean;
}

export interface VectorPluginConfig {
  /** 是否启用向量链路；缺省 false */
  enabled?: boolean;
  /** embedding 提供方：hash（本地确定性，零外部依赖）| http（OpenAI 兼容端点） */
  provider?: "hash" | "http";
  /** provider=http 时的模型名 */
  model?: string;
  /** provider=http 时的兼容端点根（如 https://api.deepseek.com） */
  baseUrl?: string;
  apiKey?: string;
  /** 向量维度；hash 缺省 128（模型/维度变化会自动整表重建） */
  dimension?: number;
  /** 融合策略；缺省 weighted */
  fusion?: FusionStrategy;
}

export interface CordisLogger {
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

export interface SystemPromptSectionOptions {
  name: string;
  order: number;
  text: string;
}

/** 本插件实际用到的最小 Cordis Context 面（结构性类型；宿主真实 Context 满足该面）。 */
export interface CordisContext {
  logger?: CordisLogger;
  root?: CordisContext;
  on?(
    event: string,
    listener: (...args: unknown[]) => void,
    options?: { readonly global?: boolean },
  ): unknown;
  inject?(
    services: readonly string[],
    callback: (scope: CordisScope) => void,
  ): unknown;
  systemPrompt?: {
    section?(options: SystemPromptSectionOptions): (() => void) | void;
  };
}

export interface CordisScope {
  webServer?: WebServerLike;
}

export interface HttpRequestLike {
  readonly method?: string;
  readonly url?: string;
  /** 原始请求头（SSE 断线重连的 Last-Event-ID 读取）。 */
  readonly headers?: Record<string, string | string[] | undefined>;
}

export interface HttpResponseLike {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(chunk?: string): void;
  /** 流式写（SSE 等长连接响应需要；纯 JSON 响应可不实现）。 */
  write?(chunk: string): unknown;
  /** 事件监听（SSE 依赖 'close'/'error' 感知断连）。 */
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WebRoute {
  name: string;
  kind: "exact" | "prefix";
  path: string;
  handler: (req: HttpRequestLike, res: HttpResponseLike) => void;
}

export interface StoreStatus {
  storePath: string;
  driver: string;
  driverNote: string;
  schemaVersion: number;
  memoryCount: number;
  legacy: {
    detected: boolean;
    schemaVersion?: number;
    tables: string[];
    rowCounts: Record<string, number>;
    backupPath?: string;
    backupCreated: boolean;
  };
}

export interface WebServerLike {
  register?(route: WebRoute): unknown;
}

interface ActiveHandle {
  closed: boolean;
}

const SECTION_ORDER = 205;
const AGENT_GUIDANCE =
  "本机已运行 dsh-memory 记忆插件（TS R1）：记忆以结构化条目保存在本地 " +
  "SQLite（默认 <插件根>/data/memory.db），并已安全接管旧插件数据。用户询问「你记得… / " +
  "我是不是说过…」或要求「记住 X」时，可借助该本地记忆库；记忆可编辑、可删除、可审计。";

const activeCtxs = new WeakMap<CordisContext, ActiveHandle>();

function sendJson(res: HttpResponseLike, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readStatus(
  opened: OpenedStoreWithTakeover,
  storePath: string,
): StoreStatus {
  const { store, takeover } = opened;
  const schema = store.db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number | null } | undefined;
  const memory = store.db
    .prepare("SELECT COUNT(*) AS c FROM memory_items")
    .get() as { c: number } | undefined;
  return {
    storePath,
    driver: store.driver,
    driverNote: store.driverNote,
    schemaVersion: schema?.v ?? 0,
    memoryCount: memory?.c ?? 0,
    legacy: {
      detected: takeover.detected,
      schemaVersion: takeover.schemaVersion,
      tables: takeover.legacyTables,
      rowCounts: takeover.legacyRowCounts,
      backupPath: takeover.backupPath,
      backupCreated: takeover.backupCreated,
    },
  };
}

function sendStatus(res: HttpResponseLike, status: StoreStatus): void {
  sendJson(res, 200, { ok: true, data: status });
}

function notAllowed(res: HttpResponseLike): void {
  sendJson(res, 405, { ok: false, error: "method not allowed" });
}

export interface VectorConfigView {
  enabled: boolean;
  provider: string;
  /** embedding + store 运行时实际可用 */
  available: boolean;
  model?: string;
  dimension?: number;
  engine?: string;
  storeCount: number;
  fusion: FusionStrategy;
  reason?: string;
  lastSync?: {
    total: number;
    synced: number;
    skipped: number;
    failures: number;
  };
}

export interface VectorHostSearch {
  (request: HybridRetrievalRequest): Promise<unknown>;
}

export interface VectorHost {
  view(): VectorConfigView;
  search: VectorHostSearch;
  dispose(): void;
}

function registerRoutes(
  webServer: WebServerLike | undefined,
  storePath: string,
  getStatus: () => StoreStatus | null,
  getRuntime: () => RuntimeConfigView,
  log: CordisLogger,
  getDb: () => SqlDatabase,
  memoryCache: MemoryCache | undefined,
  budgetEnabled: boolean,
  vectorHost?: VectorHost,
): void {
  if (typeof webServer?.register !== "function") {
    log.warn?.("[dsh-memory] webServer unavailable; routes skipped");
    return;
  }
  // GET /dsh-memory/api/health
  webServer.register({
    name: "dsh-memory-health",
    kind: "exact",
    path: "/dsh-memory/api/health",
    handler: (req, res) => {
      if (req.method !== "GET") return notAllowed(res);
      const status = getStatus();
      if (status === null) {
        return sendJson(res, 503, { ok: false, error: "store not ready" });
      }
      sendStatus(res, status);
    },
  });
  // GET /dsh-memory/api/config
  webServer.register({
    name: "dsh-memory-config",
    kind: "exact",
    path: "/dsh-memory/api/config",
    handler: (req, res) => {
      if (req.method !== "GET") return notAllowed(res);
      const runtime = getRuntime();
      const status = getStatus();
      sendJson(res, 200, {
        ok: true,
        data: {
          ...runtime,
          storeOpen: status !== null,
          storePath,
          ...(vectorHost !== undefined ? { vector: vectorHost.view() } : {}),
        },
      });
    },
  });
  // GET /dsh-memory/api/search?query=...&scope=...&project=...&limit=...
  webServer.register({
    name: "dsh-memory-search",
    kind: "exact",
    path: "/dsh-memory/api/search",
    handler: (req, res) => {
      if (req.method !== "GET") return notAllowed(res);
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = url.searchParams.get("query") ?? "";
      if (query.trim().length === 0) {
        return sendJson(res, 400, { ok: false, error: "query is required" });
      }
      const scopeRaw = url.searchParams.get("scope") ?? undefined;
      const project = url.searchParams.get("project") ?? undefined;
      const limitRaw = Number(url.searchParams.get("limit") ?? "8");
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 8;
      const request: RetrievalRequest = {
        query,
        filter: {
          scope: scopeRaw as MemoryScope | undefined,
          projectId: project,
        },
        limit,
      };
      const budget = budgetEnabled ? { taskKind: "query" as const, actor: "host" } : undefined;
      const result =
        memoryCache !== undefined
          ? cachedKeywordRetrieve(getDb(), memoryCache, request, { budget })
          : retrieve(getDb(), request, { budget });
      sendJson(res, 200, { ok: true, data: result });
    },
  });
  // GET /dsh-memory/api/search/hybrid?query=...&scope=...&project=...
  // （R4；vector 未启用时不注册）
  if (vectorHost === undefined) return;
  webServer.register({
    name: "dsh-memory-search-hybrid",
    kind: "exact",
    path: "/dsh-memory/api/search/hybrid",
    handler: (req, res) => {
      if (req.method !== "GET") return notAllowed(res);
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = url.searchParams.get("query") ?? "";
      if (query.trim().length === 0) {
        return sendJson(res, 400, { ok: false, error: "query is required" });
      }
      const scopeRaw = url.searchParams.get("scope") ?? undefined;
      const project = url.searchParams.get("project") ?? undefined;
      const limitRaw = Number(url.searchParams.get("limit") ?? "8");
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 8;
      void (async () => {
        try {
          const data = await vectorHost.search({
            query,
            filter: {
              scope: scopeRaw as MemoryScope | undefined,
              projectId: project,
            },
            limit,
          });
          sendJson(res, 200, { ok: true, data });
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            error: formatOpenError(err),
          });
        }
      })();
    },
  });
}

/** 自动记忆未启用时的零计数（config 视图保持字段稳定）。 */
const EMPTY_AUTO_MEMORY_STATS: AutoMemoryStats = {
  observed: 0,
  userMessages: 0,
  assistantMessages: 0,
  submitted: 0,
  duplicates: 0,
  blocked: 0,
  skipped: 0,
  synthesized: 0,
  empty: 0,
};

/** Task Boundary 经验学习未启用时的零计数（config 视图保持字段稳定）。 */
const EMPTY_TASK_BOUNDARY_STATS: TaskBoundaryStats = {
  observed: 0,
  boundaries: 0,
  completed: 0,
  submitted: 0,
  duplicates: 0,
  noExperience: 0,
  rejected: 0,
  incomplete: 0,
};

interface RuntimeConfigView {
  enabled: boolean;
  announceToAgent: boolean;
  worker: { enabled: boolean; running: boolean; processedTotal: number };
  cache: { enabled: boolean; rows: number; hits: number };
  consolidation: { enabled: boolean; intervalMs: number };
  validation: { enabled: boolean; intervalMs: number; dryRun: boolean };
  /** Cost/Budget 决策记录（telemetry）。disabled 为显式 NOT ENABLED。 */
  budget: { enabled: boolean };
  /** R8.1 自动长期记忆：配置 + 会话事件订阅状态 + 观测计数。 */
  autoMemory: {
    enabled: boolean;
    observeAssistant: boolean;
    maxChars: number;
    projectId: string | null;
    /** 任务边界经验学习开关（turn/end completed → auto.task-experience）。 */
    taskExperience: boolean;
    /** 是否已挂上宿主会话事件（ctx.on 不可用时为 false）。 */
    attached: boolean;
    stats: AutoMemoryStats;
    /** Task Boundary 经验学习计数（未启用时为零计数）。 */
    taskBoundary: TaskBoundaryStats;
  };
}

/** 读 memory_cache 表统计（config 视图用；失败保持全 0）。 */
function readCacheStats(
  db: SqlDatabase,
  cache: MemoryCache | undefined,
): { enabled: boolean; rows: number; hits: number } {
  if (cache === undefined) return { enabled: false, rows: 0, hits: 0 };
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(hits), 0) AS h FROM memory_cache")
      .get() as { c: number; h: number } | undefined;
    return { enabled: true, rows: row?.c ?? 0, hits: row?.h ?? 0 };
  } catch {
    return { enabled: true, rows: 0, hits: 0 };
  }
}

export interface NormalizedVectorConfig {
  enabled: boolean;
  provider: "hash" | "http";
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  dimension: number;
  fusion: FusionStrategy;
}

export interface NormalizedWorkerConfig {
  enabled: boolean;
  pollMs: number;
  leaseMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxPerBatch: number;
  onUnhandled: "fail" | "ignore";
}

interface NormalizedConfig {
  enabled: boolean;
  announceToAgent: boolean;
  markdownEnabled: boolean;
  dataDir?: string;
  dbFile?: string;
  markdownDir?: string;
  vector: NormalizedVectorConfig;
  worker: NormalizedWorkerConfig;
  consolidation: { enabled: boolean; intervalMs: number };
  validation: { enabled: boolean; intervalMs: number; dryRun: boolean };
  autoMemory: {
    enabled: boolean;
    observeAssistant: boolean;
    maxChars: number;
    projectId: string | null;
    taskExperience: boolean;
  };
  cacheEnabled: boolean;
  budgetEnabled: boolean;
}

/** http provider 缺端点时属配置错误：尽早报错（fail loud）。 */
function normalizeVectorConfig(raw: PluginConfig | undefined): NormalizedVectorConfig {
  const v = raw?.vector;
  const provider = v?.provider === "http" ? "http" : "hash";
  const dimension =
    typeof v?.dimension === "number" && Number.isInteger(v.dimension) && v.dimension >= 2
      ? v.dimension
      : 128;
  const fusion: FusionStrategy = v?.fusion === "rrf" ? "rrf" : "weighted";
  const baseUrl = typeof v?.baseUrl === "string" && v.baseUrl.length > 0 ? v.baseUrl : undefined;
  const model = typeof v?.model === "string" && v.model.length > 0 ? v.model : undefined;
  if (provider === "http" && (baseUrl === undefined || model === undefined)) {
    throw new Error(
      "dsh-memory: vector.provider=http 需要同时配置 vector.baseUrl 与 vector.model",
    );
  }
  return {
    enabled: v?.enabled === true,
    provider,
    model,
    baseUrl,
    apiKey: typeof v?.apiKey === "string" && v.apiKey.length > 0 ? v.apiKey : undefined,
    dimension,
    fusion,
  };
}

function intervalMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeConfig(raw: PluginConfig | undefined): NormalizedConfig {
  const cfg = raw ?? {};
  const dataDir = typeof cfg.dataDir === "string" && cfg.dataDir.length > 0 ? cfg.dataDir : undefined;
  const dbFile = typeof cfg.dbFile === "string" && cfg.dbFile.length > 0 ? cfg.dbFile : undefined;
  const markdownDir = typeof cfg.markdownDir === "string" && cfg.markdownDir.length > 0 ? cfg.markdownDir : undefined;
  const w = cfg.worker ?? {};
  return {
    enabled: cfg.enabled !== false,
    announceToAgent: cfg.announceToAgent !== false,
    markdownEnabled: cfg.markdownEnabled !== false,
    dataDir,
    dbFile,
    markdownDir,
    vector: normalizeVectorConfig(cfg),
    worker: {
      enabled: w.enabled !== false,
      pollMs: intervalMs(w.pollMs, 1_000),
      leaseMs: intervalMs(w.leaseMs, 30_000),
      maxAttempts:
        typeof w.maxAttempts === "number" && w.maxAttempts >= 1 ? Math.floor(w.maxAttempts) : 5,
      baseBackoffMs: intervalMs(w.baseBackoffMs, 250),
      maxPerBatch:
        typeof w.maxPerBatch === "number" && w.maxPerBatch >= 0 ? Math.floor(w.maxPerBatch) : 0,
      onUnhandled: w.onUnhandled === "ignore" ? "ignore" : "fail",
    },
    consolidation: {
      enabled: cfg.consolidation?.enabled !== false,
      intervalMs: intervalMs(cfg.consolidation?.intervalMs, 15 * 60_000),
    },
    validation: {
      enabled: cfg.validation?.enabled !== false,
      intervalMs: intervalMs(cfg.validation?.intervalMs, 6 * 60 * 60_000),
      dryRun: cfg.validation?.dryRun === true,
    },
    autoMemory: {
      enabled: cfg.autoMemory?.enabled !== false,
      observeAssistant: cfg.autoMemory?.observeAssistant !== false,
      maxChars:
        typeof cfg.autoMemory?.maxChars === "number" && cfg.autoMemory.maxChars > 0
          ? Math.floor(cfg.autoMemory.maxChars)
          : 4_000,
      projectId:
        typeof cfg.autoMemory?.projectId === "string" && cfg.autoMemory.projectId.length > 0
          ? cfg.autoMemory.projectId
          : null,
      taskExperience: cfg.autoMemory?.taskExperience !== false,
    },
    cacheEnabled: cfg.cache?.enabled !== false,
    budgetEnabled: cfg.budget?.enabled !== false,
  };
}

function formatOpenError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 组装 R4 向量宿主句柄（embedding + sqlite-vec + 投影 + reranker + 缓存）。 */
function buildVectorHost(
  db: SqlDatabase,
  vecFile: string,
  vcfg: NormalizedVectorConfig,
  memoryCache?: MemoryCache,
): VectorHost {
  const provider = createEmbeddingProvider(
    vcfg.provider === "http"
      ? {
          provider: "http",
          baseUrl: vcfg.baseUrl!,
          model: vcfg.model!,
          apiKey: vcfg.apiKey,
          dimension: vcfg.dimension,
        }
      : { provider: "hash", dimension: vcfg.dimension },
  );
  const store = new SqliteVecStore({
    file: vecFile,
    dimension: provider.dimension,
    modelId: provider.modelId,
  });
  const reranker = new DefaultReranker();
  const cache = new LruEmbeddingCache(512);
  const service = new VectorProjectionService(db, store, provider);
  service.start();
  let disposed = false;

  const view = (): VectorConfigView => {
    const eh = provider.health();
    const sh = store.health();
    const available = eh.available && sh.available;
    const reasons: string[] = [];
    if (!eh.available && eh.reason !== undefined) reasons.push(`embedding: ${eh.reason}`);
    if (!sh.available && sh.reason !== undefined) reasons.push(`store: ${sh.reason}`);
    const last = service.lastSyncReport;
    return {
      enabled: true,
      provider: provider.kind,
      available,
      model: sh.modelId ?? eh.modelId,
      dimension: sh.dimension ?? eh.dimension,
      engine: sh.engine,
      storeCount: sh.count,
      fusion: vcfg.fusion,
      ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
      ...(last !== undefined
        ? {
            lastSync: {
              total: last.total,
              synced: last.synced,
              skipped: last.skipped,
              failures: last.failures,
            },
          }
        : {}),
    };
  };

  return {
    view,
    search: async (request) => {
      if (disposed) throw new Error("vector host disposed");
      await service.ensureReady();
      const runtime = { embedding: provider, vectorStore: store, reranker, cache };
      const fullRequest = { ...request, fusionStrategy: vcfg.fusion };
      if (memoryCache === undefined) {
        return retrieveHybrid(db, fullRequest, runtime);
      }
      return cachedHybridRetrieve(db, memoryCache, fullRequest, runtime, {
        embeddingModel: provider.modelId,
      });
    },
    dispose: () => {
      disposed = true;
      service.dispose();
      store.close();
    },
  };
}

/**
 * 插件入口（synchronous，符合 Cordis apply 契约）。
 * @param ctx 宿主 Context
 * @param rawConfig 宿主解析后的插件配置
 */
export function apply(ctx: CordisContext, rawConfig?: PluginConfig): void {
  const cfg = normalizeConfig(rawConfig);
  if (cfg.enabled === false) return;
  if (activeCtxs.has(ctx)) {
    ctx.logger?.warn?.("[dsh-memory] apply() already active on this Context; skipping duplicate init");
    return;
  }

  const storePath = resolveStoreFile({ dataDir: cfg.dataDir, dbFile: cfg.dbFile });

  let opened: OpenedStoreWithTakeover;
  try {
    opened = openStoreWithTakeover({ file: storePath });
  } catch (err) {
    ctx.logger?.error?.("[dsh-memory] store open/migrate failed at %s: %s", storePath, formatOpenError(err));
    throw new Error(`dsh-memory: store open/migrate failed at ${storePath}: ${formatOpenError(err)}`, {
      cause: err,
    });
  }
  const handle: ActiveHandle = { closed: false };
  activeCtxs.set(ctx, handle);

  // Markdown Projection（R2）：DB ↔ MD 双向同步 + 用户编辑监听。
  let projection: MarkdownProjectionService | undefined;
  let stopWatcher: (() => void) | undefined;
  const markdownRoot =
    cfg.markdownEnabled ? cfg.markdownDir ?? join(dirname(storePath), "memory") : undefined;
  if (markdownRoot !== undefined) {
    try {
      projection = new MarkdownProjectionService(opened.store.db, markdownRoot);
      projection.start();
      stopWatcher = watchMemoryDir(markdownRoot, (rel, text) => {
        projection?.adoptFile(rel, text);
      });
      ctx.logger?.info?.(
        "[dsh-memory] markdown projection ready at %s",
        markdownRoot,
      );
    } catch (err) {
      ctx.logger?.error?.(
        "[dsh-memory] markdown projection failed: %s",
        formatOpenError(err),
      );
    }
  }

  // R6 Finalization：Memory Cache（上下文感知检索缓存；随 DB 生命周期）。
  let memoryCache: MemoryCache | undefined;
  if (cfg.cacheEnabled) {
    try {
      memoryCache = new MemoryCache(opened.store.db, {});
    } catch (err) {
      ctx.logger?.error?.(
        "[dsh-memory] memory cache init failed; cache disabled: %s",
        formatOpenError(err),
      );
    }
  }

  // R6 Finalization：后台 Durable Worker（事件队列消费）。不阻塞宿主启动。
  let worker: DurableWorker | undefined;
  // R8 Realtime：SSE 事件流 Hub（dispose 时统一断连，防轮询触碰已关库）。
  let eventsHub: EventsStreamHub | undefined;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (cfg.worker.enabled) {
    try {
      worker = new DurableWorker(opened.store.db, defaultWorkerConsumers(), {
        pollMs: cfg.worker.pollMs,
        leaseMs: cfg.worker.leaseMs,
        maxAttempts: cfg.worker.maxAttempts,
        baseBackoffMs: cfg.worker.baseBackoffMs,
        maxPerBatch: cfg.worker.maxPerBatch,
        onUnhandled: cfg.worker.onUnhandled,
      });
      worker.start();
      ctx.logger?.info?.(
        "[dsh-memory] durable worker started (poll=%dms; lease=%dms; attempts=%d)",
        cfg.worker.pollMs,
        cfg.worker.leaseMs,
        cfg.worker.maxAttempts,
      );
    } catch (err) {
      worker = undefined;
      ctx.logger?.error?.(
        "[dsh-memory] worker start failed; queue drained via CLI only: %s",
        formatOpenError(err),
      );
    }
  }

  // R6 Finalization：定时 Consolidation 调度入口（依赖 Worker 消费；幂等按小时）。
  if (cfg.consolidation.enabled) {
    if (worker === undefined) {
      ctx.logger?.warn?.(
        "[dsh-memory] scheduled consolidation disabled: requires worker (worker.enabled=false)",
      );
    } else {
      timers.push(
        setInterval(() => {
          try {
            const queued = scheduleDeepConsolidation(opened.store.db);
            if (queued !== null) {
              ctx.logger?.info?.(
                "[dsh-memory] consolidation scheduled id=%s",
                queued,
              );
            }
          } catch (err) {
            ctx.logger?.error?.(
              "[dsh-memory] consolidation schedule failed: %s",
              formatOpenError(err),
            );
          }
        }, cfg.consolidation.intervalMs).unref(),
      );
    }
  }
  for (const t of timers) t.unref?.();

  // R6 Finalization：Continuous Validation（hygiene 扫描；连写 validation_runs）。
  if (cfg.validation.enabled) {
    timers.push(
      setInterval(() => {
        try {
          const run = runHygieneScan(opened.store.db, {
            actor: "host:validator",
            dryRun: cfg.validation.dryRun,
          });
          if (run.changed > 0) {
            ctx.logger?.info?.(
              "[dsh-memory] hygiene run %s changed=%d scanned=%d (dry-run=%s)",
              run.runId,
              run.changed,
              run.scanned,
              run.dryRun ? "yes" : "no",
            );
          }
        } catch (err) {
          ctx.logger?.error?.(
            "[dsh-memory] validation run failed: %s",
            formatOpenError(err),
          );
        }
      }, cfg.validation.intervalMs).unref(),
    );
  }

  // Vector Retrieval（R4）：默认关闭；启用时构建 embedding + 向量索引。
  // Memory Center 页的开关把意图持久化到 <storeDir>/vector-ui.json；装配期
  // 该文件存在时优先于宿主配置，否则回落 vector.enabled。
  const vectorStoreDir = dirname(storePath);
  const uiVectorOverride = readVectorUiOverride(vectorStoreDir);
  const vectorConfig = {
    ...cfg.vector,
    enabled: uiVectorOverride === null ? cfg.vector.enabled : uiVectorOverride.enabled,
  };
  let vectorHost: VectorHost | undefined;
  if (vectorConfig.enabled) {
    try {
      vectorHost = buildVectorHost(
        opened.store.db,
        `${storePath}.vec`,
        vectorConfig,
        memoryCache,
      );
      ctx.logger?.info?.(
        "[dsh-memory] vector retrieval enabled (provider=%s; dimension=%d)",
        vectorConfig.provider,
        vectorConfig.dimension,
      );
    } catch (err) {
      ctx.logger?.error?.(
        "[dsh-memory] vector init failed: %s",
        formatOpenError(err),
      );
      throw new Error(`dsh-memory: vector init failed: ${formatOpenError(err)}`, {
        cause: err,
      });
    }
  }

  // R8.1 自动长期记忆：订阅宿主会话事件（全局作用域），只入队 durable auto.learn；
  // 记忆的抽取/评分/冲突处理沿用既有 R8 流水线，由 worker 消费时执行。
  let autoMemory: AutoMemoryService | undefined;
  let taskBoundary: TaskBoundaryAdapter | undefined;
  let disposeAutoMemory: (() => void) | undefined;
  let disposeTaskBoundary: (() => void) | undefined;
  if (cfg.autoMemory.enabled) {
    autoMemory = new AutoMemoryService(opened.store.db, {
      observeAssistant: cfg.autoMemory.observeAssistant,
      maxChars: cfg.autoMemory.maxChars,
      projectId: cfg.autoMemory.projectId,
      logger: ctx.logger,
    });
    disposeAutoMemory = autoMemory.attach(ctx);
    ctx.logger?.info?.(
      "[dsh-memory] auto memory subscribed to session/event (global; observeAssistant=%s)",
      String(cfg.autoMemory.observeAssistant),
    );
    // Task Boundary 自动经验学习：turn/end(completed) → 抽取/校验 → durable
    // auto.task-experience；落库由 worker 消费时经既有 experience 域完成。
    if (cfg.autoMemory.taskExperience) {
      taskBoundary = new TaskBoundaryAdapter(opened.store.db, {
        projectId: cfg.autoMemory.projectId,
        logger: ctx.logger,
      });
      disposeTaskBoundary = taskBoundary.attach(ctx);
      ctx.logger?.info?.(
        "[dsh-memory] task boundary experience subscribed to turn/end (global)",
      );
    }
  }

  // announce 段
  let announce = cfg.announceToAgent;
  let disposeAnnounce: (() => void) | undefined;
  const syncAnnounce = () => {
    if (disposeAnnounce !== undefined) {
      disposeAnnounce();
      disposeAnnounce = undefined;
    }
    if (!announce || typeof ctx.systemPrompt?.section !== "function") return;
    const maybeDispose = ctx.systemPrompt.section({
      name: "plugin:dsh-memory",
      order: SECTION_ORDER,
      text: AGENT_GUIDANCE,
    });
    if (typeof maybeDispose === "function") disposeAnnounce = maybeDispose;
  };
  syncAnnounce();

  const getStatus = (): StoreStatus | null => {
    if (handle.closed) return null;
    return readStatus(opened, storePath);
  };
  const getRuntime = (): RuntimeConfigView => ({
    enabled: true,
    announceToAgent: announce,
    worker:
      worker === undefined
        ? { enabled: cfg.worker.enabled, running: false, processedTotal: 0 }
        : { enabled: true, running: worker.isRunning(), processedTotal: worker.processedTotal },
    cache: readCacheStats(opened.store.db, memoryCache),
    consolidation: {
      enabled: cfg.consolidation.enabled && worker !== undefined,
      intervalMs: cfg.consolidation.intervalMs,
    },
    validation: {
      enabled: cfg.validation.enabled,
      intervalMs: cfg.validation.intervalMs,
      dryRun: cfg.validation.dryRun,
    },
    budget: { enabled: cfg.budgetEnabled },
    autoMemory: {
      enabled: cfg.autoMemory.enabled,
      observeAssistant: cfg.autoMemory.observeAssistant,
      maxChars: cfg.autoMemory.maxChars,
      projectId: cfg.autoMemory.projectId,
      taskExperience: cfg.autoMemory.taskExperience,
      attached: autoMemory !== undefined && typeof ctx.on === "function",
      stats: autoMemory?.stats() ?? EMPTY_AUTO_MEMORY_STATS,
      taskBoundary: taskBoundary?.stats() ?? EMPTY_TASK_BOUNDARY_STATS,
    },
  });

  /** R7 ApiContext 运行时快照：与 /api/config 同源，供 systemInfo 展示。 */
  const getApiRuntime = (): ApiRuntimeSnapshot => {
    const v = getRuntime();
    const cacheStats = readCacheStats(opened.store.db, memoryCache);
    const processStats = memoryCache?.processStats();
    const base: ApiRuntimeSnapshot = {
      enabled: v.enabled,
      announceToAgent: v.announceToAgent,
      worker: v.worker,
      cache: { ...cacheStats, hitRate: processStats?.hitRate ?? null },
      consolidation: { enabled: v.consolidation.enabled },
      validation: { enabled: v.validation.enabled, dryRun: v.validation.dryRun },
      budget: v.budget,
      autoMemory: v.autoMemory,
    };
    if (vectorHost !== undefined) {
      const view = vectorHost.view();
      base.vector = {
        enabled: view.enabled,
        provider: view.provider,
        modelId: view.model ?? null,
        dimension: view.dimension ?? null,
        storeCount: view.storeCount,
        healthy: view.available,
        ...(view.reason !== undefined ? { reason: view.reason } : {}),
      };
    }
    // 开关目标实时取 override（UI 切换后立即反映），active 仍为本进程启动时的装配状态。
    const liveUiOverride = readVectorUiOverride(vectorStoreDir);
    const targetEnabled = liveUiOverride === null ? cfg.vector.enabled : liveUiOverride.enabled;
    base.vectorPref = {
      enabled: targetEnabled,
      active: vectorHost !== undefined,
      overridden: liveUiOverride !== null,
      restartRequired: targetEnabled !== (vectorHost !== undefined),
      provider: cfg.vector.provider,
    };
    return base;
  };

  if (typeof ctx.on === "function") {
    ctx.on("dispose", () => {
      handle.closed = true;
      activeCtxs.delete(ctx);
      if (disposeAnnounce !== undefined) {
        disposeAnnounce();
        disposeAnnounce = undefined;
      }
      if (disposeAutoMemory !== undefined) {
        disposeAutoMemory();
        disposeAutoMemory = undefined;
      }
      if (disposeTaskBoundary !== undefined) {
        disposeTaskBoundary();
        disposeTaskBoundary = undefined;
      }
      for (const t of timers) clearInterval(t);
      const finalize = () => {
        eventsHub?.closeAll();
        stopWatcher?.();
        projection?.dispose();
        vectorHost?.dispose();
        try {
          opened.store.db.close();
        } catch (err) {
          ctx.logger?.warn?.("[dsh-memory] store close failed: %s", formatOpenError(err));
        }
        ctx.logger?.info?.("[dsh-memory] store closed: %s", storePath);
      };
      // R6 Finalization：先停 Worker（同步清轮询定时器并置位），再关库，避免
      // 并发队列消费触碰已关闭连接。单线程下 dispose 回调不会打断正在执行的
      // drain；若此刻 busy（极少数正在排空的时刻），则等 stop() 完成后关库。
      const w = worker;
      worker = undefined;
      if (w !== undefined) {
        const stopping = w.stop().catch((err: unknown) => {
          ctx.logger?.warn?.(
            "[dsh-memory] worker stop failed: %s",
            formatOpenError(err),
          );
        });
        if (!w.isRunning()) {
          w.release();
          finalize();
          return;
        }
        void stopping.then(() => {
          w.release();
          finalize();
        });
        return;
      }
      finalize();
    });
  }

  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (scope) => {
      try {
        registerRoutes(
          scope.webServer,
          storePath,
          getStatus,
          getRuntime,
          ctx.logger ?? {},
          () => opened.store.db,
          memoryCache,
          cfg.budgetEnabled,
          vectorHost,
        );
        // R7 Memory Center API：ApiContext/ApiActions 注入 + admin 路由接入 registry。
        const actions: ApiActions = {
          runValidation: (dryRun) => {
            const run = runHygieneScan(opened.store.db, {
              actor: "user",
              dryRun: dryRun === true,
            });
            return { dryRun: run.dryRun, changed: run.changed, skipped: run.skipped };
          },
        };
        if (worker !== undefined) {
          actions.consolidate = () => ({
            scheduledId: scheduleDeepConsolidation(opened.store.db),
          });
        }
        if (memoryCache !== undefined) {
          const cache = memoryCache;
          actions.clearCache = () => cache.clearAll();
        }
        if (projection !== undefined) {
          const projectionService = projection;
          actions.rebuildProjection = () => {
            projectionService.resyncAll();
            return projectionService.listMdFiles().length;
          };
        }
        actions.setVectorEnabled = (enabled) => {
          writeVectorUiOverride(vectorStoreDir, enabled);
          return { enabled, restartRequired: enabled !== (vectorHost !== undefined) };
        };
        registerMemoryCenterApi(scope.webServer, {
          db: opened.store.db,
          storePath,
          markdownRoot,
          store: { driver: opened.store.driver, driverNote: opened.store.driverNote },
          runtime: getApiRuntime,
          actor: "user",
          retrievalCache: memoryCache,
          actions,
        });
        registerMemoryCenterPage(scope.webServer);
        eventsHub = registerEventsStream(
          scope.webServer,
          opened.store.db,
          ctx.logger ?? {},
        );
      } catch (err) {
        ctx.logger?.error?.("[dsh-memory] route registration failed: %s", formatOpenError(err));
      }
    });
  }

  const takeover = opened.takeover;
  ctx.logger?.info?.(
    "[dsh-memory] store ready at %s (driver=%s; schema v%d; legacy=%s%s)",
    storePath,
    opened.store.driver,
    readStatus(opened, storePath).schemaVersion,
    takeover.detected ? `present(${Object.keys(takeover.legacyRowCounts).map((t) => `${t}=${takeover.legacyRowCounts[t]}`).join(", ")})` : "absent",
    takeover.detected && takeover.backupPath !== undefined ? `; backup=${takeover.backupPath}` : "",
  );
}
