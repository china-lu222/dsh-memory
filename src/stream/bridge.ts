/**
 * R8.1 跨进程事件桥 — ExternalEventBridge。
 *
 * 问题：CLI 与 WebUI 是两个进程（`dsh-memory` CLI 直接写同一个 SQLite 文件），
 * 进程内事件总线无法把 CLI 的写入通知给宿主里的 Memory Center。
 * 媒介因此只能是持久层本身：`events` 表既是 durable 事件日志也是跨进程通道。
 *
 * 本桥把「events 表 → 订阅者」的增量语义收拢为可独立测试的组件，负责四件事：
 *  - Event ID：每条交付事件的位置编码（`<ts>:<id>` 的 base64url，见 cursor.ts），
 *    同一编码既是 SSE `id:` 帧行也是客户端回带的 Last-Event-ID；
 *  - Replay：给定游标后回放 (cursor, 末端] 的已完成事件（事件行本身即重放源，
 *    不额外持久化客户端水位）；
 *  - Last-Event-ID：`open(token)` 把客户端水位解码为起始位置，非法 token 拒绝；
 *  - Reconnect：`open(null)` 表示首连，从当前水位起只收新事件（不 dump 历史）；
 *    重连即再次 `open(lastEventId())`，gap 精确补齐、不重不漏。
 *
 * 交付保证：水位单调推进 ⇒ 正常轮询不会重复；去重窗口额外兜住「重连游标早于
 * 本实例已交付位置」的重叠区间，使重复交付对订阅者不可见（至多一次展示）。
 * 下游写入的幂等由记忆 id / 幂等键保证（见 store/repository.ts）。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import { decodeCursor, encodeCursor, type StreamCursor } from "./cursor.js";
import type { CompiledStreamFilter } from "./filter.js";
import { cursorAtHead, queryDoneEvents, type DoneStreamEvent } from "./source.js";

/** 默认单次读取上限（与 SSE 单批回放上限一致）。 */
export const DEFAULT_BRIDGE_LIMIT = 200;
/** 默认去重窗口：窗口内已交付的事件 id 不再重复交付。 */
export const DEFAULT_DEDUPE_WINDOW = 1_000;

export interface ExternalEventBridgeOptions {
  /** 已迁移的 memory store（本进程或其它进程写入皆可见）。 */
  db: SqlDatabase;
  /** 订阅的类型谓词（见 filter.ts 的 compileStreamFilter）。 */
  filter: CompiledStreamFilter;
  /** 单次读取上限（1..500）。 */
  limit?: number;
  /** 去重窗口大小（1..10000）。 */
  dedupeWindow?: number;
}

/** 建链结果：token 非法时拒绝，调用方按 400 处理。 */
export type BridgeOpenResult =
  | { ok: true; cursor: StreamCursor | null }
  | { ok: false; reason: string };

/** 桥状态快照（诊断用）。 */
export interface ExternalEventBridgeState {
  /** 已交付事件数。 */
  delivered: number;
  /** 被去重窗口拦下的重复交付数。 */
  duplicatesSkipped: number;
  /** 是否由非空 Last-Event-ID 建链（即重连回放）。 */
  resuming: boolean;
  /** 当前水位的事件 id 编码；尚未建链或空表为 null。 */
  cursor: string | null;
}

/**
 * 跨进程事件桥：从 events 表增量交付已完成域事件。
 *
 * 一个实例对应一个订阅者（一条 SSE 连接）；`open` → 循环 `poll` 即为订阅生命周期。
 */
export class ExternalEventBridge {
  private readonly db: SqlDatabase;
  private readonly filter: CompiledStreamFilter;
  private readonly limit: number;
  private readonly dedupeWindow: number;
  private readonly deliveredIds = new Set<string>();
  private watermark: StreamCursor | null = null;
  private opened = false;
  private resuming = false;
  private deliveredCount = 0;
  private duplicatesSkipped = 0;

  constructor(options: ExternalEventBridgeOptions) {
    this.db = options.db;
    this.filter = options.filter;
    this.limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? DEFAULT_BRIDGE_LIMIT)));
    this.dedupeWindow = Math.max(
      1,
      Math.min(10_000, Math.floor(options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW)),
    );
  }

  /**
   * 建立订阅位置（首连 / 重连共用入口）。
   *
   * token 为 null 表示首连：水位取当前已完成事件的最大值，只收之后的新事件；
   * token 非 null 表示重连：解码为水位并回放其后的 gap；不可解码则拒绝。
   * @param token 客户端水位（`Last-Event-ID` 帧值或 since 参数）
   * @returns 建链结果；非法 token 返回 `{ ok: false }`
   */
  open(token: string | null): BridgeOpenResult {
    if (token === null) {
      this.watermark = cursorAtHead(this.db);
      this.resuming = false;
    } else {
      const cursor = decodeCursor(token);
      if (cursor === null) {
        return { ok: false, reason: "游标必须为 <ts>:<id> 的 base64url 编码" };
      }
      this.watermark = cursor;
      this.resuming = true;
    }
    this.opened = true;
    return { ok: true, cursor: this.watermark };
  }

  /**
   * 以显式游标建链，用于测试与「游标早于本实例」的重连场景。
   * @param cursor 起始水位；null 表示从头回放全部已完成事件
   * @returns 建链结果（始终成功；非法输入不存在于此重载）
   */
  openAt(cursor: StreamCursor | null): BridgeOpenResult {
    this.watermark = cursor;
    this.resuming = cursor !== null;
    this.opened = true;
    return { ok: true, cursor };
  }

  /** 当前水位的事件 id 编码（SSE `id:` / 重连 Last-Event-ID）。 */
  lastEventId(): string | null {
    return this.watermark === null ? null : encodeCursor(this.watermark);
  }

  /** 当前水位（未编码）。 */
  get cursor(): StreamCursor | null {
    return this.watermark;
  }

  /** 是否已建链。 */
  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * 拉取下一批已完成事件并推进水位（跨进程可见）。
   *
   * 未建链时先按首连处理，避免调用方漏调 open 时 dump 历史。
   * @returns 本批事件（已按窗口去重，按 (ts,id) 升序）
   */
  poll(): DoneStreamEvent[] {
    if (!this.opened) this.open(null);
    const rows = queryDoneEvents(this.db, {
      after: this.watermark,
      filter: this.filter,
      limit: this.limit,
    });
    const out: DoneStreamEvent[] = [];
    for (const row of rows) {
      // 水位先推进：即使该行被去重窗口拦下，也不会被反复读取。
      this.watermark = { ts: row.ts, id: row.id };
      if (this.deliveredIds.has(row.id)) {
        this.duplicatesSkipped += 1;
        continue;
      }
      this.remember(row.id);
      this.deliveredCount += 1;
      out.push(row);
    }
    return out;
  }

  /** 桥状态快照。 */
  state(): ExternalEventBridgeState {
    return {
      delivered: this.deliveredCount,
      duplicatesSkipped: this.duplicatesSkipped,
      resuming: this.resuming,
      cursor: this.lastEventId(),
    };
  }

  private remember(id: string): void {
    this.deliveredIds.add(id);
    while (this.deliveredIds.size > this.dedupeWindow) {
      const oldest = this.deliveredIds.keys().next();
      if (oldest.done === true) break;
      this.deliveredIds.delete(oldest.value);
    }
  }
}
