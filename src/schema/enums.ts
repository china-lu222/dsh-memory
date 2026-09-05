/**
 * DSH Memory — 枚举定义
 * 决策来源：Q035/Q036/Q040/Q044/Q082/Q098/Q104（见 需求决策总表_v1.1）
 */

/** 记忆作用域层级（Q035/Q044/Q077） */
export const MEMORY_SCOPES = [
  "session",
  "project",
  "global",
  "generalized",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** 核心记忆类型（Q044/Q080） */
export const MEMORY_TYPES = [
  "personal",
  "project_knowledge",
  "experience",
  "negative",
  "generalized",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 来源分级（Q036）— 用于 confidence 与冲突消解 */
export const SOURCE_KINDS = [
  "explicit", // 用户显式给出
  "user-edited", // 用户编辑（受锁保护）
  "derived", // 系统派生
  "inferred", // 系统推断
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Importance 层级（Q098），与 Confidence 分离 */
export const IMPORTANCES = [
  "critical",
  "high",
  "normal",
  "low",
  "disposable",
] as const;
export type Importance = (typeof IMPORTANCES)[number];

/**
 * Experience 专属生命周期（Q040），正式进入 Schema
 * candidate → investigating → solution-found → verified → validated
 */
export const EXPERIENCE_PHASES = [
  "candidate",
  "investigating",
  "solution-found",
  "verified",
  "validated",
] as const;
export type ExperiencePhase = (typeof EXPERIENCE_PHASES)[number];

/**
 * 时间语义状态（Q082/Q104），正式进入 Schema
 * current / historical / planned / expired / uncertain / superseded
 */
export const TEMPORAL_STATES = [
  "current",
  "historical",
  "planned",
  "expired",
  "uncertain",
  "superseded",
] as const;
export type TemporalState = (typeof TEMPORAL_STATES)[number];

/**
 * 全局生命周期状态（Q104「全局 7 态」）—— 扩展位。
 * v1.1/Q106 决策：原始 7 态枚举未恢复，不得自行固化；字段保留但值不限定。
 * 待 v1.2 恢复后收紧为枚举并补状态机 / migration。
 */
export type LifecycleStatus = string;

/** Profile Memory 分类（R5，Q044 的 personal 类型细分）。 */
export const PROFILE_CATEGORIES = [
  "preference", // 用户偏好（editor/framework/language…）
  "fact", // 客观事实（环境/身份/经历）
  "skill", // 技能/熟练度
  "goal", // 目标/正在推进的事
  "constraint", // 约束/禁忌（不得推荐类，参与负向抑制）
  "working_style", // 工作方式
] as const;
export type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];

/** 用户反馈种类（R5，Q58/Q65）。 */
export const FEEDBACK_KINDS = [
  "confirm", // 这条记忆对当前结论正确/有用
  "deny", // 这条记忆错了
  "solved", // 问题被该经验解决
  "not_helpful", // 不帮助（可能因为不适用）
  "obsolete", // 已过时
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** 冲突“关系分类”（R5，Q096）：先区分关系再决定动作。 */
export const CONFLICT_RELATIONS = [
  "same_fact", // 同一事实，文本近似重复
  "same_event", // 同一事件/证据来源
  "different_event", // 不同事件
  "shared_pattern", // 共享模式（高相似）
  "parent_child", // 泛化/特化
  "supplement", // 互补信息
  "contradiction", // 互相矛盾
] as const;
export type ConflictRelation = (typeof CONFLICT_RELATIONS)[number];

/** 冲突解决动作（Q096/Q097）。 */
export const CONFLICT_RESOLUTIONS = [
  "merge",
  "link",
  "supersede",
  "keep_separate",
] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/** 冲突评审状态。 */
export const CONFLICT_STATUSES = ["open", "resolved", "discarded"] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

/** 错误推荐分层（Q56）。 */
export const RECOMMENDATION_TIERS = [
  "verified-highly-applicable",
  "verified-conditional",
  "possible-low-confidence",
  "historical-failure",
] as const;
export type RecommendationTier = (typeof RECOMMENDATION_TIERS)[number];

/** 错误分类（R5 Error Intelligence，规则确定性分类，非 LLM）。 */
export const ERROR_CATEGORIES = [
  "build",
  "runtime",
  "compile",
  "syntax",
  "import",
  "module",
  "network",
  "dependency",
  "test",
  "lint",
  "shell",
  "database",
  "config",
  "permission",
  "memory",
  "timeout",
  "type",
  "other",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Project Knowledge 分类（R5 数据模型补正，Project Knowledge 四类）。 */
export const PROJECT_CATEGORIES = [
  "architecture", // 项目结构/组件/模块边界
  "decision", // ADR/技术选型与取舍
  "dependency", // 依赖/版本约束/兼容矩阵
  "current_issue", // 当前项目状态中的问题
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

/** 全部受控词汇的聚合（供校验/文档/CLI 使用）。 */
export const ENUM_VALUES = {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  SOURCE_KINDS,
  IMPORTANCES,
  EXPERIENCE_PHASES,
  TEMPORAL_STATES,
  PROFILE_CATEGORIES,
  PROJECT_CATEGORIES,
  FEEDBACK_KINDS,
  CONFLICT_RELATIONS,
  CONFLICT_RESOLUTIONS,
  CONFLICT_STATUSES,
  RECOMMENDATION_TIERS,
  ERROR_CATEGORIES,
} as const;
