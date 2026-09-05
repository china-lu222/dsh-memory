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
  };
}

/**
 * 管理操作的动作钩子：把需要宿主运行时能力（而非 DB 查询）的
 * 操作留在接线层实现，api 模块保持可独立于宿主测试。
 */
export interface ApiActions {
  /** 手动跑一轮 validation/hygiene；返回是否已被接受（worker 空闲时）。 */
  runValidation?: (dryRun?: boolean) => boolean;
  /** 手动触发一次深度整合；返回是否已接受。 */
  consolidate?: () => boolean;
  /** 清空检索缓存；返回清除行数。 */
  clearCache?: () => number;
  /** 手动重建 markdown 投影；返回生成文件数（能力不可用为 undefined）。 */
  rebuildProjection?: () => number;
}

/** api/* 模块共享的运行上下文。 */
export interface ApiContext {
  db: SqlDatabase;
  /** 插件数据目录下 db 文件绝对路径（展示用）。 */
  storePath: string;
  /** markdown 投影根目录（可能未启用）。 */
  markdownRoot?: string;
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
