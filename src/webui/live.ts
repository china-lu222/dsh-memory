/**
 * Memory Center 实时同步策略（R8 phase 5）—— 单一来源。
 *
 * 服务端把本模块导出的订阅映射与前端行为常数序列化进页面
 * `window.__mc.live`（见 page.ts），SPA（webui/app.js）只消费这份
 * 配置做事件驱动的“智能刷新”，不在 JS 里复制领域映射。
 *
 * 实时同步语义（刷新时机与抑制规则）：
 *  - 数据源：`/dsh-memory/api/events/stream` 只推已完成域事件
 *    （memory.* / experience.* / conflict.* / generalize.*）。
 *  - 触发：域事件到达时，若它命中“当前可见视图”的订阅前缀，客户端
 *    调度一次刷新；同窗口内的连续事件合并为一次（debounce）。
 *  - 抑制：详情视图只跟随“同实体”事件（event.memoryId === 当前实体 id）；
 *    页面隐藏时不发请求，回到可见后补刷一次；本地写操作触发的 SSE 回声
 *    在 mute 窗口内被忽略，避免与动作自带刷新重复拉取。
 *
 * 内容本身不在事件里（负载只是审计锚点），因此“增量”体现在刷新面：
 * 事件 → 仅重取受影响的当前视图，而非全页面导航或跨视图批量拉取。
 */

import {
  DEFAULT_STREAM_TYPES,
  EVENTS_STREAM_PATH,
} from "../stream/sse.js";

/** 视图 → 订阅前缀。命中前缀的域事件才值得刷新该视图（详情另做实体匹配）。 */
export const VIEW_SUBSCRIPTIONS: Record<string, readonly string[]> = {
  overview: ["memory.*", "experience.*", "conflict.*", "generalize.*"],
  memories: ["memory.*", "generalize.*"],
  "memory-detail": ["memory.*", "generalize.*"],
  experiences: ["memory.*", "experience.*"],
  "experience-detail": ["memory.*", "experience.*"],
  conflicts: ["conflict.*"],
  quarantine: ["memory.*"],
  system: ["memory.*", "experience.*", "conflict.*", "generalize.*"],
};

/**
 * 视图 → 详情实体匹配：这些视图是单实体详情，只在事件 memoryId 命中
 * 当前打开实体时才刷新（其它记忆的变更不打扰正在查看的详情）。
 */
export const DETAIL_VIEWS: ReadonlySet<string> = new Set([
  "memory-detail",
  "experience-detail",
]);

/** 事件到达后的刷新合并窗口（毫秒）。 */
export const LIVE_REFRESH_DEBOUNCE_MS = 400;
/** 本地 POST 写操作后的 SSE 回声静音窗口（毫秒）。 */
export const LIVE_LOCAL_WRITE_MUTE_MS = 1_500;

/** 前端订阅完整 URL（单参数逗号编码，服务端按逗号拆分为表达式集）。 */
export function buildStreamUrl(
  streamPath: string = EVENTS_STREAM_PATH,
  types: readonly string[] = DEFAULT_STREAM_TYPES,
): string {
  return `${streamPath}?types=${encodeURIComponent(types.join(","))}`;
}

/** 注入页面的实时同步配置（page.ts 原样序列化为 window.__mc.live）。 */
export interface MemoryCenterLiveConfig {
  /** SSE 订阅 URL（含 types 过滤参数）。 */
  stream: string;
  /** 视图 → 订阅前缀（VIEW_SUBSCRIPTIONS 的 JSON 形态）。 */
  views: Record<string, readonly string[]>;
  /** 事件刷新合并窗口（毫秒）。 */
  debounceMs: number;
  /** 本地写后 SSE 回声静音窗口（毫秒）。 */
  muteMs: number;
}

/**
 * 构建页面注入配置。
 * @returns 可 JSON 序列化的实时同步配置。
 */
export function buildLiveConfig(): MemoryCenterLiveConfig {
  return {
    stream: buildStreamUrl(),
    views: VIEW_SUBSCRIPTIONS,
    debounceMs: LIVE_REFRESH_DEBOUNCE_MS,
    muteMs: LIVE_LOCAL_WRITE_MUTE_MS,
  };
}

/** 单条订阅表达式是否命中某事件类型（精确名或 `前缀.*` 通配）。 */
export function subscriptionMatches(eventType: string, subscription: string): boolean {
  if (subscription === "*") return true;
  if (subscription.endsWith(".*")) {
    const prefix = subscription.slice(0, -1);
    return eventType.startsWith(prefix);
  }
  return eventType === subscription;
}

/**
 * 决策：某域事件到达时，当前视图是否需要刷新。
 * @param view 当前视图 id（state.view）。
 * @param eventType SSE 事件名（memory.create 等）。
 * @param memoryId 事件的 memoryId（负载；无实体上下文时为 null）。
 * @param detailId 当前详情视图打开的实体 id；非详情视图传 null。
 * @returns 命中订阅且（对详情视图）实体匹配时为 true。
 */
export function shouldLiveRefresh(
  view: string,
  eventType: string,
  memoryId: string | null,
  detailId: string | null,
): boolean {
  const subscriptions = VIEW_SUBSCRIPTIONS[view];
  if (!subscriptions || subscriptions.length === 0) return false;
  const subscribed = subscriptions.some((s) => subscriptionMatches(eventType, s));
  if (!subscribed) return false;
  if (!DETAIL_VIEWS.has(view)) return true;
  return detailId !== null && memoryId !== null && memoryId === detailId;
}
