/**
 * R8 SSE 事件流 — EventStreamHub（phase 4）。
 *
 * 暴露 `/dsh-memory/api/events/stream`：Memory Center 前端用它做实时同步。
 * 协议要点：
 *  - 每帧事件带 `id: <cursor>`（base64url 编码的 {ts,id}，见 cursor.ts）；
 *    浏览器 EventSource 断线重连自动回带 `Last-Event-ID`，服务端据此回放
 *    gap（事件行本身即 durable 重放源，无需额外持久化客户端水位）。
 *  - 带游标连接：先回放 (cursor, head] 内全部匹配事件，再进入实时轮询；
 *    无游标首连：从当前已 done 的最大水位起只收之后的新事件（不 dump 历史）。
 *  - 每事件 `event:` 名 = event_type（memory.create / conflict.open …），
 *    `data:` = { id, ts, type, memoryId, payload }。
 *  - done 过滤：只推送已完成域事件；queued/processing 的任务半成品不出流。
 *  - 事件源是 events 表（跨进程 durable）：其它进程（CLI drain / 另一宿主）
 *    写同一 SQLite 也能感知 —— 增量、回放、Last-Event-ID、重连全部收敛在
 *    ExternalEventBridge（stream/bridge.ts），本文件只负责 SSE 线上协议。
 *  - 轮询间隔与心跳注释行 `: ping` 防中间层断流；res 'close' 即回收定时器。
 */

import type { CordisLogger, HttpRequestLike, HttpResponseLike, WebServerLike } from "../cordis/apply.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { ExternalEventBridge } from "./bridge.js";
import { encodeCursor } from "./cursor.js";
import {
  compileStreamFilter,
  invalidTypeExpression,
  normalizeTypeExpressions,
} from "./filter.js";
import type { DoneStreamEvent } from "./source.js";

export const EVENTS_STREAM_PATH = "/dsh-memory/api/events/stream";

/** 默认推送给订阅者的域事件前缀（不推 auto.learn 等任务内部事件）。 */
export const DEFAULT_STREAM_TYPES = ["memory.*", "experience.*", "conflict.*", "generalize.*"];

/** 轮询间隔 / 心跳间隔 / 单批回放上限 / 断线重连建议（协议常数）。 */
export const DEFAULT_POLL_MS = 1_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_REPLAY_LIMIT = 200;
export const DEFAULT_RETRY_MS = 3_000;

export interface EventsStreamOptions {
  /** 增量轮询间隔（毫秒）。 */
  pollMs?: number;
  /** 心跳注释行间隔（毫秒）。 */
  heartbeatMs?: number;
  /** 单次增量读取/回放上限。 */
  limit?: number;
  /** 连接断开重连建议（毫秒；SSE `retry:` 指令）。 */
  retryMs?: number;
  logger?: CordisLogger;
}

/** 单条 SSE 事件负载（与 DoneStreamEvent 同构，便于前端反序列化）。 */
export interface StreamEventEnvelope {
  id: string;
  ts: string;
  type: string;
  memoryId: string | null;
  payload: unknown;
}

function toEnvelope(row: DoneStreamEvent): StreamEventEnvelope {
  return { id: row.id, ts: row.ts, type: row.eventType, memoryId: row.memoryId, payload: row.payload };
}

/** SSE 帧构建：事件帧（含 id 行）+ 心跳注释。 */
export function eventFrame(row: DoneStreamEvent): string {
  const data = JSON.stringify(toEnvelope(row));
  return `id: ${encodeCursor({ ts: row.ts, id: row.id })}\nevent: ${row.eventType}\ndata: ${data}\n\n`;
}

export function helloFrame(cursor: string | null, types: readonly string[], limit: number, retryMs: number): string {
  const data = JSON.stringify({ cursor, types, limit });
  return `retry: ${retryMs}\nevent: hello\ndata: ${data}\n\n`;
}

interface StreamClient {
  close(): void;
}

/**
 * SSE Hub：把 events 表的已完成域事件增量推送给一个或多个长连接。
 * 每连接独立自持轮询定时器（unref，不阻塞宿主退出）。
 */
export class EventsStreamHub {
  private readonly db: SqlDatabase;
  private readonly opts: Required<Pick<EventsStreamOptions, "pollMs" | "heartbeatMs" | "limit" | "retryMs">> &
    EventsStreamOptions;
  private readonly clients = new Set<StreamClient>();

  constructor(db: SqlDatabase, options: EventsStreamOptions = {}) {
    this.db = db;
    this.opts = {
      pollMs: Math.max(50, Math.floor(options.pollMs ?? DEFAULT_POLL_MS)),
      heartbeatMs: Math.max(0, Math.floor(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)),
      limit: Math.max(1, Math.min(500, Math.floor(options.limit ?? DEFAULT_REPLAY_LIMIT))),
      retryMs: Math.max(0, Math.floor(options.retryMs ?? DEFAULT_RETRY_MS)),
      logger: options.logger,
    };
  }

  /** 当前活跃连接数（测试/观测）。 */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * 处理一次 SSE 握手请求。GET 之外的 method 按 405 返回；非法订阅
   * 表达式/游标按 400 返回；宿主响应不支持流式写时按 500 返回。
   * 连接建立后持续推送，直到底层响应 close 或 poll 失败。
   */
  attach(req: HttpRequestLike, res: HttpResponseLike): void {
    if ((req.method ?? "GET") !== "GET") {
      return writeJson(res, 405, { ok: false, error: "method not allowed" });
    }
    if (typeof res.write !== "function") {
      return writeJson(res, 500, { ok: false, error: "streaming response unavailable" });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawTypes = url.searchParams.get("types");
    const exprs = normalizeTypeExpressions(rawTypes === null ? DEFAULT_STREAM_TYPES : rawTypes);
    for (const expr of exprs) {
      const invalid = invalidTypeExpression(expr);
      if (invalid !== null) {
        return writeJson(res, 400, { ok: false, error: invalid });
      }
    }
    const since = url.searchParams.get("since");
    // 显式 since 优先于浏览器自动回带的 Last-Event-ID；两者都是同一套游标编码。
    const headerToken = since === null ? readHeader(req, "last-event-id") ?? null : null;
    const token = since ?? headerToken;
    const tokenLabel = since === null ? "Last-Event-ID" : "since";

    const filter = compileStreamFilter(exprs);
    const bridge = new ExternalEventBridge({
      db: this.db,
      filter,
      limit: this.opts.limit,
    });
    // 首连（token=null）从当前水位起只收新事件；重连按 Last-Event-ID 回放 gap。
    const opened = bridge.open(token);
    if (!opened.ok) {
      return writeJson(res, 400, { ok: false, error: `${tokenLabel} 必须为 <ts>:<id> 游标` });
    }

    let closed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastBeat = 0;

    const log = this.opts.logger;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      this.clients.delete(client);
      try {
        res.end();
      } catch {
        // 底层已断开；end 失败可忽略。
      }
    };
    const client: StreamClient = { close };
    this.clients.add(client);

    const writeFrame = (frame: string): boolean => {
      if (closed) return false;
      try {
        return res.write!(frame) !== false;
      } catch (err) {
        log?.error?.("[dsh-memory] stream write failed: %s", err instanceof Error ? err.message : String(err));
        close();
        return false;
      }
    };

    const tick = (): void => {
      if (closed) return;
      try {
        for (const row of bridge.poll()) {
          if (!writeFrame(eventFrame(row))) return;
        }
        const now = Date.now();
        if (this.opts.heartbeatMs > 0 && now - lastBeat >= this.opts.heartbeatMs) {
          lastBeat = now;
          if (!writeFrame(": ping\n\n")) return;
        }
      } catch (err) {
        // store 已关闭（宿主 dispose）或查询失败：停止本连接。
        log?.error?.("[dsh-memory] stream poll failed: %s", err instanceof Error ? err.message : String(err));
        close();
      }
    };

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const startCursor = bridge.lastEventId();
    if (!writeFrame(helloFrame(startCursor, exprs, this.opts.limit, this.opts.retryMs))) {
      close();
      return;
    }
    if (typeof res.on === "function") {
      res.on("close", () => close());
      res.on("error", () => close());
    }
    timer = setInterval(tick, this.opts.pollMs);
    timer.unref?.();
  }

  /** 关闭所有活跃连接（宿主 dispose 时调用，避免轮询触碰已关库）。 */
  closeAll(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
  }
}

/** 读取单值请求头（兼容数组形态）。 */
function readHeader(req: HttpRequestLike, name: string): string | undefined {
  const headers = req.headers;
  if (headers === undefined) return undefined;
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value === undefined ? undefined : String(value);
}

function writeJson(res: HttpResponseLike, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** 向 webServer 注册 SSE 路由并返回 hub（供宿主 dispose 统一 close）。 */
export function registerEventsStream(
  webServer: WebServerLike | undefined,
  db: SqlDatabase,
  logger?: CordisLogger,
): EventsStreamHub {
  const hub = new EventsStreamHub(db, { logger });
  if (typeof webServer?.register !== "function") return hub;
  webServer.register({
    name: "dsh-memory-events-stream",
    kind: "exact",
    path: EVENTS_STREAM_PATH,
    handler: (req, res) => hub.attach(req, res),
  });
  return hub;
}
