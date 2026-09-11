/**
 * Task Boundary 自动经验学习 — 宿主边界适配器（R8.1 目标 2）。
 *
 * 宿主支持任务边界信号（packages/core/session 的会话日志契约）：
 *  - `turn/end`：`{ turn, reason }`，`reason.kind === "completed"` 表示该轮正常收尾；
 *  - `session/disposed`：会话离开 store，丢弃未收尾的缓冲。
 * 因此无需伪造边界事件 —— 本适配器只把既有信号翻译成经验任务。
 *
 * 职责边界（与 host.ts 的 AutoMemoryService 一致）：
 *  - 按会话缓存一轮内的对话观测（`turn/end` 之间即一轮），有界内存；
 *  - 边界到达时做「摘要 → 抽取 → 校验」，只在有「问题 → 解决」证据时才入队，
 *    空经验不入队（队列中不出现无用的任务行）；
 *  - 不写记忆库：落库由 worker 消费 `auto.task-experience` 时经既有 experience
 *    域完成（src/worker/handlers.ts）。
 *
 * 观察者失败不得影响宿主会话：事件处理异常在订阅回调内吞掉并留日志。
 */

import { truncateText } from "../ingest/text.js";
import type { SqlDatabase } from "../store/sqlite.js";
import {
  deriveTaskExperience,
  type TaskBoundaryProvenance,
} from "./experience.js";
import { readConversationEvent, type AutoMemoryHostContext } from "./host.js";
import { submitTaskExperience } from "./task.js";
import type { ConversationObservation } from "./types.js";

/** 单会话缓冲的观测条数上限（超出丢弃最早，保证边界内存有界）。 */
const DEFAULT_MAX_OBSERVATIONS = 40;
/** 单条观测进入缓冲的字符数上限。 */
const DEFAULT_MAX_CHARS = 4_000;
/** 同时在缓冲中的会话数上限（超出按插入顺序淘汰最早会话）。 */
const DEFAULT_MAX_SESSIONS = 64;

/** 边界处理结果（测试与诊断用）。 */
export type TaskBoundaryResult =
  | { action: "observed" }
  /** 已入队一条经验任务。 */
  | { action: "submitted"; taskId: string; summary: string }
  /** 同会话同 turn 的经验任务已存在（重放/重复投递）。 */
  | { action: "duplicate" }
  /** 该轮没有「问题 → 解决」证据，不产生经验。 */
  | { action: "no-experience" }
  /** 抽取结果未通过校验（含敏感拦截）。 */
  | { action: "rejected"; reason: string }
  /** 该轮未正常收尾（aborted/error/blocked/max-tokens/interrupted）。 */
  | { action: "incomplete"; reason: string }
  | { action: "irrelevant" };

/** 订阅期间累计的边界计数（Memory Center 诊断展示用）。 */
export interface TaskBoundaryStats {
  /** 进入缓冲的对话观测条数（含合成注入等未进入的，不计）。 */
  observed: number;
  /** 处理过的任务边界数（含未正常收尾的）。 */
  boundaries: number;
  /** 正常收尾的边界数。 */
  completed: number;
  /** 成功入队的经验任务数。 */
  submitted: number;
  /** 同键经验任务已存在而未重复入队。 */
  duplicates: number;
  /** 无「问题 → 解决」证据的边界数。 */
  noExperience: number;
  /** 抽取结果未通过校验的边界数（含敏感拦截）。 */
  rejected: number;
  /** 未正常收尾（跳过）的边界数。 */
  incomplete: number;
}

export interface TaskBoundaryOptions {
  /** 会话所属项目；提供后经验落 project scope，否则落 session scope。 */
  projectId?: string | null;
  /** 单会话缓冲的观测条数上限。 */
  maxObservations?: number;
  /** 单条观测进入缓冲的字符数上限。 */
  maxChars?: number;
  /** 同时在缓冲中的会话数上限。 */
  maxSessions?: number;
  /** 诊断日志（缺省静默）。 */
  logger?: { warn?(message: string, ...args: unknown[]): void };
}

interface SessionBuffer {
  observations: ConversationObservation[];
  /** 当前缓冲中的字符总数（用于有界淘汰）。 */
  chars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 读取会话 id；载荷缺失归入同一个匿名缓冲（多会话共用时逐轮清空）。 */
function sessionKey(session: unknown): string {
  if (isRecord(session) && typeof session.id === "string" && session.id.length > 0) {
    return session.id;
  }
  return "-";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * 任务边界经验学习适配器。
 *
 * 只入队、不写库：`turn/end(completed)` → 确定性抽取与校验 → durable
 * `auto.task-experience`；落库由 worker 消费时执行。
 */
export class TaskBoundaryAdapter {
  private readonly db: SqlDatabase;
  private readonly projectId: string | null;
  private readonly maxObservations: number;
  private readonly maxChars: number;
  private readonly maxSessions: number;
  private readonly logger?: TaskBoundaryOptions["logger"];
  private readonly buffers = new Map<string, SessionBuffer>();
  private readonly counters: TaskBoundaryStats = {
    observed: 0,
    boundaries: 0,
    completed: 0,
    submitted: 0,
    duplicates: 0,
    noExperience: 0,
    rejected: 0,
    incomplete: 0,
  };
  private detach: (() => void) | null = null;

  constructor(db: SqlDatabase, options: TaskBoundaryOptions = {}) {
    this.db = db;
    this.projectId =
      typeof options.projectId === "string" && options.projectId.length > 0
        ? options.projectId
        : null;
    this.maxObservations = positiveInt(
      options.maxObservations,
      DEFAULT_MAX_OBSERVATIONS,
    );
    this.maxChars = positiveInt(options.maxChars, DEFAULT_MAX_CHARS);
    this.maxSessions = positiveInt(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.logger = options.logger;
  }

  /**
   * 订阅宿主 `session/event` 与 `session/disposed`（全局作用域）。
   * 重复调用返回同一解绑函数，解绑同时清空缓冲。
   */
  attach(ctx: AutoMemoryHostContext): () => void {
    if (this.detach !== null) return this.detach;
    if (typeof ctx.on !== "function") {
      this.logger?.warn?.(
        "[dsh-memory] 宿主 ctx.on 不可用，Task Boundary 经验学习未接入会话事件",
      );
      this.detach = () => {};
      return this.detach;
    }
    const onEvent = ctx.on(
      "session/event",
      (session, event) => {
        try {
          this.handleSessionEvent(session, event);
        } catch (error) {
          // 观察者失败不得影响宿主会话：吞掉并留日志。
          this.logger?.warn?.(
            "[dsh-memory] Task Boundary 处理会话事件失败: %s",
            describeError(error),
          );
        }
      },
      { global: true },
    );
    const onDisposed = ctx.on(
      "session/disposed",
      (session) => {
        this.buffers.delete(sessionKey(session));
      },
      { global: true },
    );
    const detachEvent =
      typeof onEvent === "function" ? (onEvent as () => void) : () => {};
    const detachDisposed =
      typeof onDisposed === "function" ? (onDisposed as () => void) : () => {};
    this.detach = () => {
      detachEvent();
      detachDisposed();
      this.buffers.clear();
      this.detach = null;
    };
    return this.detach;
  }

  /** 边界计数快照。 */
  stats(): TaskBoundaryStats {
    return { ...this.counters };
  }

  /** 会话是否仍有缓冲（诊断用）。 */
  bufferedSessions(): number {
    return this.buffers.size;
  }

  /**
   * 处理一条宿主 session 事件：对话消息进缓冲，`turn/end` 触发经验派生。
   * @param session 宿主会话对象（只读 id）
   * @param event 宿主事件载荷 `{ type, data }`
   */
  handleSessionEvent(session: unknown, event: unknown): TaskBoundaryResult {
    if (!isRecord(event)) return { action: "irrelevant" };
    if (event.type === "turn/end") {
      return this.handleTurnEnd(session, event.data);
    }
    const readout = readConversationEvent(event);
    if (readout.status !== "ok") return { action: "irrelevant" };
    this.buffer(sessionKey(session), {
      role: readout.observation.role,
      messageId: readout.observation.messageId,
      text: truncateText(readout.observation.text, this.maxChars),
    });
    return { action: "observed" };
  }

  private buffer(key: string, observation: ConversationObservation): void {
    if (observation.text.length === 0) return;
    let buffer = this.buffers.get(key);
    if (buffer === undefined) {
      // 会话数有界：Map 保持插入顺序，淘汰最早进入缓冲的会话。
      if (this.buffers.size >= this.maxSessions) {
        const oldest = this.buffers.keys().next();
        if (oldest.done !== true) this.buffers.delete(oldest.value);
      }
      buffer = { observations: [], chars: 0 };
      this.buffers.set(key, buffer);
    }
    buffer.observations.push(observation);
    buffer.chars += observation.text.length;
    this.counters.observed += 1;
    while (
      buffer.observations.length > this.maxObservations ||
      buffer.chars > this.maxChars * this.maxObservations
    ) {
      const dropped = buffer.observations.shift();
      if (dropped === undefined) break;
      buffer.chars -= dropped.text.length;
    }
  }

  private handleTurnEnd(session: unknown, data: unknown): TaskBoundaryResult {
    const key = sessionKey(session);
    const buffer = this.buffers.get(key);
    this.buffers.delete(key);
    const observations = buffer?.observations ?? [];
    this.counters.boundaries += 1;

    const turn = isRecord(data) ? data.turn : undefined;
    if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) {
      this.counters.rejected += 1;
      return { action: "rejected", reason: "turn/end payload.turn 非法" };
    }
    const reason = isRecord(data) && isRecord(data.reason) ? data.reason.kind : undefined;
    if (reason !== "completed") {
      // 未正常收尾的一轮不沉淀经验（半成品没有可复用的结论）。
      this.counters.incomplete += 1;
      return {
        action: "incomplete",
        reason: `turn/end reason=${typeof reason === "string" ? reason : "unknown"}`,
      };
    }
    this.counters.completed += 1;
    if (observations.length === 0) {
      this.counters.noExperience += 1;
      return { action: "no-experience" };
    }

    const provenance: TaskBoundaryProvenance = {
      sessionId: key === "-" ? null : key,
      turn,
      projectId: this.projectId,
      reason,
    };
    const derived = deriveTaskExperience({ provenance, observations });
    if (derived.status === "no-experience") {
      this.counters.noExperience += 1;
      return { action: "no-experience" };
    }
    if (derived.status === "invalid") {
      this.counters.rejected += 1;
      return { action: "rejected", reason: derived.reason };
    }

    const submit = submitTaskExperience(this.db, {
      provenance,
      candidate: derived.candidate,
    });
    if (submit.taskId === null) {
      this.counters.duplicates += 1;
      return { action: "duplicate" };
    }
    this.counters.submitted += 1;
    return {
      action: "submitted",
      taskId: submit.taskId,
      summary: derived.candidate.summary,
    };
  }
}
