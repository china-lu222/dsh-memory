/**
 * Auto Long-Term Memory — 宿主对话事件适配（R8.1 阶段 1）。
 *
 * 正常聊天自动产生记忆的入口：订阅宿主 `session/event`（全局作用域），把
 * 用户消息与 assistant 最终回复交给既有 gate → 抽取 → 评估 → resolver 流水线
 * （经 durable `auto.learn` 队列，见 task.ts / worker/handlers.ts）。本模块只做
 * 「事件 → 文本 → 入队」，不复制任何记忆写入逻辑。
 *
 * 宿主契约（packages/core/session，已在 docs/R8.1-AUDIT.md 记录）：
 *  - `ctx.on("session/event", (session, event) => …, { global: true })`；
 *  - `event.type === "user/message"` 时 `event.data` 为 UserMessage；
 *  - `event.type === "assistant/message"` 时 `event.data` 为
 *    `{ turn, step, message, usage?, interrupted? }`；
 *  - `message.source.kind === "user"` 才是真人输入；`plugin`/`tool`/`model`
 *    是 `agent.inject()` 注入的合成上下文（AGENTS.md、skill、cron 通知），
 *    必须排除，否则注入内容会被当成用户偏好存进记忆。
 *
 * 本模块不 import DSH Core 类型（插件零 DSH 依赖，见 package.json），按上述
 * 契约结构化读取宿主载荷；读不懂的载荷一律忽略，不抛错、不误判。
 */

import { extractMessageText, truncateText } from "../ingest/text.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { submitAutoLearn } from "./task.js";
import type {
  AutoLearnSubmit,
  ConversationObservation,
  GateIntent,
} from "./types.js";

export type { ConversationObservation };

/** 单条消息进入队列的字符数上限（超长截断，避免超大 payload 进队列）。 */
const DEFAULT_MAX_CHARS = 4_000;

/** 宿主 session 的最小结构面（只用到 id）。 */
export interface HostSessionLike {
  readonly id?: unknown;
}

/** 宿主 session 事件的最小结构面（只用到 type 与 data）。 */
export interface HostSessionEventLike {
  readonly type?: unknown;
  readonly data?: unknown;
}

/** 可由插件订阅的宿主上下文（Cordis ctx 的结构面，含全局作用域选项）。 */
export interface AutoMemoryHostContext {
  on?(
    event: string,
    listener: (...args: unknown[]) => void,
    options?: { readonly global?: boolean },
  ): unknown;
}

/** 宿主事件读取结果（区分「非对话事件」与「合成注入消息」，便于统计与诊断）。 */
export type ConversationReadout =
  | { readonly status: "ok"; readonly observation: ConversationObservation }
  /** 合成注入（source.kind 非 user，例如 agent.inject 的 AGENTS.md/skill/cron）。 */
  | { readonly status: "synthesized" }
  /** 是对话事件但无可见文本。 */
  | { readonly status: "empty" }
  /** 与对话无关的事件类型。 */
  | { readonly status: "irrelevant" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 读取 message.source.kind（缺失或非法返回 null，按不可信处理）。 */
function sourceKind(message: Record<string, unknown>): string | null {
  const source = message.source;
  if (!isRecord(source)) return null;
  return typeof source.kind === "string" ? source.kind : null;
}

function messageId(message: Record<string, unknown>): string | null {
  return typeof message.id === "string" && message.id.length > 0 ? message.id : null;
}

/**
 * 读取一条宿主 session 事件中的对话消息。
 * 只接受 `user/message`（source.kind === "user"）与 `assistant/message`。
 * @param event 宿主事件载荷（`{ type, data }`）
 */
export function readConversationEvent(event: unknown): ConversationReadout {
  if (!isRecord(event)) return { status: "irrelevant" };
  const type = event.type;
  if (type !== "user/message" && type !== "assistant/message") {
    return { status: "irrelevant" };
  }
  const data = event.data;
  if (!isRecord(data)) return { status: "empty" };

  if (type === "user/message") {
    // 合成注入不参与自动记忆：只有真人输入才是用户偏好/项目知识的来源。
    if (sourceKind(data) !== "user") return { status: "synthesized" };
    const text = extractMessageText(data).trim();
    if (text.length === 0) return { status: "empty" };
    return { status: "ok", observation: { role: "user", messageId: messageId(data), text } };
  }

  // assistant/message: { turn, step, message, interrupted? }；中断的半成品不入记忆。
  if (data.interrupted === true) return { status: "empty" };
  const message = data.message;
  if (!isRecord(message)) return { status: "empty" };
  const text = extractMessageText(message).trim();
  if (text.length === 0) return { status: "empty" };
  return {
    status: "ok",
    observation: { role: "assistant", messageId: messageId(message), text },
  };
}

/** 订阅期间累计的观测计数（Memory Center 诊断展示用）。 */
export interface AutoMemoryStats {
  /** 判定为对话消息的条数（含被下游 gate 丢弃的）。 */
  observed: number;
  /** 用户消息条数。 */
  userMessages: number;
  /** assistant 消息条数。 */
  assistantMessages: number;
  /** gate 判定可学习并成功入队的条数。 */
  submitted: number;
  /** 因同键任务已存在而未重复入队。 */
  duplicates: number;
  /** 敏感内容拦截（不落库，仅留 audit 痕迹）。 */
  blocked: number;
  /** gate 判定闲聊/瞬时/无信息量。 */
  skipped: number;
  /** 合成注入消息（source.kind 非 user）。 */
  synthesized: number;
  /** 对话事件但无可见文本。 */
  empty: number;
}

/** 单条事件的处理结果（测试与诊断用）。 */
export interface AutoMemoryResult {
  action: "submitted" | "duplicate" | "blocked" | "skipped" | "synthesized" | "empty" | "irrelevant";
  /** 可读原因（gate 丢弃原因或标记）。 */
  reason?: string;
  /** gate 分级（对话事件才有）。 */
  intent?: GateIntent;
  /** 新入队任务 id（submitted 时非空）。 */
  taskId?: string | null;
}

export interface AutoMemoryOptions {
  /** 观测 assistant 回复（默认 true：结论/失败归因常出现在回复中）。 */
  observeAssistant?: boolean;
  /** 单条消息进入队列的字符数上限。 */
  maxChars?: number;
  /** 会话所属项目；提供后非 personal 候选落 project scope。缺省 null。 */
  projectId?: string | null;
  /** 诊断日志（缺省静默；事件处理失败必须被吞掉，不能影响宿主会话）。 */
  logger?: { warn?(message: string, ...args: unknown[]): void };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把宿主对话事件转成自动记忆任务的适配器。
 *
 * 只入队、不写库：识别 → 去重（幂等键）→ durable `auto.learn`；
 * 记忆的抽取/评分/冲突处理由 worker 消费时执行（既有 R8 流水线）。
 */
export class AutoMemoryService {
  private readonly db: SqlDatabase;
  private readonly observeAssistant: boolean;
  private readonly maxChars: number;
  private readonly projectId: string | null;
  private readonly logger?: AutoMemoryOptions["logger"];
  private readonly counters: AutoMemoryStats = {
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
  private detach: (() => void) | null = null;

  constructor(db: SqlDatabase, options: AutoMemoryOptions = {}) {
    this.db = db;
    this.observeAssistant = options.observeAssistant !== false;
    this.maxChars =
      typeof options.maxChars === "number" && options.maxChars > 0
        ? Math.floor(options.maxChars)
        : DEFAULT_MAX_CHARS;
    this.projectId =
      typeof options.projectId === "string" && options.projectId.length > 0
        ? options.projectId
        : null;
    this.logger = options.logger;
  }

  /** 订阅宿主 `session/event`（全局作用域）；重复调用返回同一解绑函数。 */
  attach(ctx: AutoMemoryHostContext): () => void {
    if (this.detach !== null) return this.detach;
    if (typeof ctx.on !== "function") {
      this.logger?.warn?.(
        "[dsh-memory] 宿主 ctx.on 不可用，自动长期记忆未接入会话事件",
      );
      this.detach = () => {};
      return this.detach;
    }
    const subscribed = ctx.on(
      "session/event",
      (session, event) => {
        try {
          this.handleSessionEvent(session, event);
        } catch (error) {
          // 观察者失败不得影响宿主会话：吞掉并留日志。
          this.logger?.warn?.(
            "[dsh-memory] 自动长期记忆处理会话事件失败: %s",
            describeError(error),
          );
        }
      },
      { global: true },
    );
    this.detach =
      typeof subscribed === "function" ? (subscribed as () => void) : () => {};
    return this.detach;
  }

  /** 观测计数快照。 */
  stats(): AutoMemoryStats {
    return { ...this.counters };
  }

  /**
   * 处理一条宿主 session 事件（纯函数式边界：只入队，不写记忆）。
   * @param session 宿主会话对象（只读 id）
   * @param event 宿主事件载荷 `{ type, data }`
   */
  handleSessionEvent(session: unknown, event: unknown): AutoMemoryResult {
    const readout = readConversationEvent(event);
    if (readout.status === "irrelevant") return { action: "irrelevant" };
    if (readout.status === "synthesized") {
      this.counters.synthesized += 1;
      return { action: "synthesized", reason: "source.kind 非 user（合成注入）" };
    }
    if (readout.status === "empty") {
      this.counters.empty += 1;
      return { action: "empty", reason: "无可见文本" };
    }

    const observation = readout.observation;
    if (observation.role === "assistant" && !this.observeAssistant) {
      return { action: "skipped", reason: "assistant 观测已关闭" };
    }

    const text = truncateText(observation.text, this.maxChars);
    if (text.length === 0) {
      this.counters.empty += 1;
      return { action: "empty", reason: "归一化后为空" };
    }

    this.counters.observed += 1;
    if (observation.role === "user") {
      this.counters.userMessages += 1;
    } else {
      this.counters.assistantMessages += 1;
    }

    const sessionId = isRecord(session) && typeof session.id === "string" ? session.id : null;
    const sourceRef =
      sessionId !== null && observation.messageId !== null
        ? `${sessionId}#${observation.messageId}`
        : undefined;
    const submit = submitAutoLearn(this.db, {
      text,
      origin: "conversation",
      actor:
        observation.role === "assistant"
          ? "auto:conversation:assistant"
          : "auto:conversation:user",
      ...(this.projectId !== null ? { projectId: this.projectId } : {}),
      ...(sourceRef !== undefined ? { sourceRef } : {}),
    });
    return this.record(submit);
  }

  private record(submit: AutoLearnSubmit): AutoMemoryResult {
    if (submit.blockedDigest !== undefined) {
      this.counters.blocked += 1;
      return {
        action: "blocked",
        reason: submit.reason,
        intent: submit.intent,
        taskId: null,
      };
    }
    if (submit.taskId !== null) {
      this.counters.submitted += 1;
      return { action: "submitted", intent: submit.intent, taskId: submit.taskId };
    }
    if (submit.duplicate) {
      this.counters.duplicates += 1;
      return { action: "duplicate", intent: submit.intent, taskId: null };
    }
    this.counters.skipped += 1;
    return { action: "skipped", reason: submit.reason, intent: submit.intent, taskId: null };
  }
}
