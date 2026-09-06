import type { MemoryCache } from "../cache/memory-cache.js";
import type { SqlDatabase } from "../store/sqlite.js";

/**
 * R7 运行时快照：由宿主 apply 在接线时从插件运行时（worker/cache/
 * validation/consolidation/budget/vectorHost）组装；纯 store 场景下
 * api 模块未拿到快照时自动降级为只读 DB 数据。
 */
export interface ApiRuntimeSnapshot {
  enabled: boolean;
  announceToAgent: boolean;
  worker: {
    enabled: boolean;
    running: boolean;
    processedTotal: number;
  };
  cache: {
    enabled: boolean;
    rows: number;
    hits: number;
    /** 本进程缓存命中率（0..1；启用后尚无检索查询时为 null）。 */
    hitRate: number | null;
  };
  consolidation: { enabled: boolean };
  validation: { enabled: boolean; dryRun: boolean };
  budget: { enabled: boolean };
  vector?: {
    enabled: boolean;
    provider: string;
    modelId: string | null;
    dimension: number | null;
    storeCount: number | null;
    healthy: boolean;
    /** healthy=false 时的不可用原因（embedding/store 侧）。 */
    reason?: string;
  };
  /**
   * 向量检索开关（Memory Center 页持久化的目标状态）。
   * 目标先取 UI 覆盖（vector-ui.json），否则回落宿主配置；active 为当前
   * 进程实际状态，二者不一致时页面提示需重启。
   */
  vectorPref?: {
    /** 目标开关状态。 */
    enabled: boolean;
    /** 当前进程实际生效状态（vectorHost 已装配即启用）。 */
    active: boolean;
    /** 目标由本页持久化覆盖而非宿主配置。 */
    overridden: boolean;
    /** 目标与运行状态不一致；重启宿主后切换才生效。 */
    restartRequired: boolean;
    /** 启用后使用的 embedding provider（hash/http）。 */
    provider: string;
  };
}

/** 手动 hygiene 扫描的本次结果摘要（宿主接线层在 run 后回填）。 */
export interface HygieneRunSummary {
  /** 是否预览模式（只扫描、不改写记忆）。 */
  dryRun: boolean;
  /** 扫描发现的应过期条目数（预览模式下不会真正改写）。 */
  changed: number;
  /** 用户手动编辑过、被跳过检查的记忆条数。 */
  skipped: number;
}

/** 手动触发深度整合的结果（scheduledId 为空表示该小时已有相同任务）。 */
export interface ConsolidationOutcome {
  /** 新入队的 consolidation.scheduled 事件 id；null = 幂等去重未接受。 */
  scheduledId: string | null;
}

/**
 * 管理操作的动作钩子：把需要宿主运行时能力（而非 DB 查询）的
 * 操作留在接线层实现，api 模块保持可独立于宿主测试。
 */
export interface ApiActions {
  /** 手动跑一轮 validation/hygiene；返回本次结果摘要（旧实现返回 boolean 兼容）。 */
  runValidation?: (dryRun?: boolean) => boolean | HygieneRunSummary;
  /** 手动触发一次深度整合（按小时幂等入队）。 */
  consolidate?: () => boolean | ConsolidationOutcome;
  /** 清空检索缓存；返回清除行数。 */
  clearCache?: () => number;
  /** 手动重建 markdown 投影；返回重建后 .md 文件数（能力不可用为 undefined）。 */
  rebuildProjection?: () => number;
  /** 持久化向量检索开关意图（重启宿主后生效）。 */
  setVectorEnabled?: (enabled: boolean) => { enabled: boolean; restartRequired: boolean };
}

/** api/* 模块共享的运行上下文。 */
export interface ApiContext {
  db: SqlDatabase;
  /** 插件数据目录下 db 文件绝对路径（展示用）。 */
  storePath: string;
  /** markdown 投影根目录（可能未启用）。 */
  markdownRoot?: string;
  /** store 驱动信息（由宿主注入；System Health 页驱动/驱动说明展示）。 */
  store?: { driver: string; driverNote: string };
  /** 由宿主注入的运行时快照读取器（可缺省，缺省时 system 视图降级）。 */
  runtime?: () => ApiRuntimeSnapshot;
  /** 可选持久化检索缓存，提供后搜索走 cache lookup。 */
  retrievalCache?: MemoryCache;
  /** 管理操作审计 actor（缺省 user）。 */
  actor?: string;
  actions?: ApiActions;
}

export function actorOf(ctx: ApiContext): string {
  return ctx.actor ?? "user";
}
