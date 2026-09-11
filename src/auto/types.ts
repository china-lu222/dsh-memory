/**
 * Auto Long-Term Memory（阶段 2）：自动长期记忆域的共享类型。
 *
 * 输入可以来自：显式「记住」请求、会话上下文文本（宿主事件接入前不可用，
 * 见 docs/IMPLEMENTATION-AUTO-MEMORY-REALTIME.md §2.4 host-adapter）、CLI/API。
 * 本文件只定义判别数据，不含行为。
 */

import type {
  Importance,
  MemoryScope,
  MemoryType,
  SourceKind,
} from "../schema/enums.js";

/** 一条可进入自动记忆的对话消息（宿主 user/assistant 消息归一化结果）。 */
export interface ConversationObservation {
  readonly role: "user" | "assistant";
  /** 宿主 message id（evidence 引用用；载荷缺省时为 null）。 */
  readonly messageId: string | null;
  /** 消息可见文本（content 中 text 块拼接）。 */
  readonly text: string;
}

/** 触发来源：决定 gate 语义、source_kind 与 actor 命名。 */
export type AutoOrigin =
  | "remember" // 显式「请记住 …」请求（最高优先级）
  | "conversation" // 会话/对话自动学习（宿主事件接入后）
  | "task-end" // Task End 边界（阶段 3 接入）
  | "api"; // 显式 API/CLI 调用

/** gate 判定结果（输入分级，一次只落一个）。 */
export type GateIntent =
  | "remember" // 显式记住：直通敏感过滤后按 explicit 写入
  | "learnable" // 可学习的长期信息（进入分类/抽取）
  | "chatter" // 闲聊/寒暄/瞬时：不写库
  | "noisy"; // 纯工具输出/无信息量：不写库

export interface GateVerdict {
  intent: GateIntent;
  /** 丢弃或改写时的可读原因（audit/telemetry 留痕用）。 */
  reason?: string;
}

/** 抽取/分类后、评估前的记忆候选（对应 Schema memory_items 行语义）。 */
export interface AutoCandidate {
  type: MemoryType;
  content: string;
  summary?: string;
  /** 规则/来源给出的初始置信（0–1），供 evaluator 作为证据强度基线。 */
  baseConfidence: number;
  /** 人类可读的触发句/来源引文。 */
  quote: string;
}

export interface EvaluatedAutoCandidate extends AutoCandidate {
  /** 证据强度：来自来源可靠性/规则显式度/复现次数。 */
  confidence: number;
  /** 对用户的价值：与 confidence 正交，由价值信号判定。 */
  importance: Importance;
}

/** 写入前判定结果（scope 已分类）。 */
export interface ResolvedAutoCandidate extends EvaluatedAutoCandidate {
  scope: MemoryScope;
  projectId: string | null;
  sourceKind: SourceKind;
  memoryId: string;
}

/** resolver 对单个候选的决策。 */
export type ResolveAction =
  | { action: "create"; row: ResolvedAutoCandidate }
  | { action: "skip"; reason: "duplicate" | "conflict-pending" }
  | {
      action: "conflict";
      reviewId: string;
      memoryAId: string;
      memoryBId: string;
      relation: string;
      basis: string;
    };

/** learn() 的一次完整结果（幂等可重放）。 */
export interface AutoLearnOutcome {
  intent: GateIntent;
  /** chatter/noisy 丢弃原因。 */
  reason?: string;
  created: string[];
  skipped: number;
  conflicts: number;
  quarantined: string[];
  /** 敏感拦截（不写库，仅留痕）。 */
  blocked: string[];
}

/** submitAutoLearn 的即时返回（阶段 3 任务边界：是否入队，不含异步执行结果）。 */
export interface AutoLearnSubmit {
  /** gate 分级；chatter/noisy 与敏感命中不会产生任务。 */
  intent: GateIntent;
  /** 丢弃/拦截原因（gate 或 sensitive）。 */
  reason?: string;
  /** 新任务事件 id；重复提交（同文本同上下文任务已存在）为 null。 */
  taskId: string | null;
  /** 因同键 auto.learn 任务已存在而未重复入队。 */
  duplicate: boolean;
  /** 敏感拦截留痕 digest（命中敏感时给出，memory store 不落库）。 */
  blockedDigest?: string;
}

/** 敏感过滤判定（判别联合：命中即拦截，不落库）。 */
export type SensitiveVerdict =
  | { blocked: false }
  | { blocked: true; rule: string; reason: string };

/** 内容分类判定（抽取前的 type/瞬时归属，供 remember 整句入库使用）。 */
export interface ClassifyVerdict {
  type: MemoryType;
  /** 命中分类信号的可读说明（audit/telemetry 留痕用）。 */
  signal: string;
  /** 瞬时内容判定：true 表示不值得沉淀为长期记忆。 */
  transient: boolean;
}

/** learn() 的服务输入（显式「记住」/CLI/API/未来 host-adapter 共用）。 */
export interface AutoLearnRequest {
  text: string;
  origin: AutoOrigin;
  /** 项目上下文；与 project scope 记忆共用。 */
  projectId?: string;
  /** audit actor；缺省为 "auto:<origin>"。 */
  actor?: string;
  /** 触发句所在会话/消息引用，evidence 留痕扩展位（阶段 2 只透传）。 */
  sourceRef?: string;
}

/** 服务内部贯穿的调用方上下文（audit/write path 共用）。 */
export interface LearnContext {
  origin: AutoOrigin;
  projectId: string | null;
  actor: string;
  sourceRef?: string;
}
