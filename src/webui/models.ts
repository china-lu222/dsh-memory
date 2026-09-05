/**
 * Memory Center WebUI 的纯 view-model 层。
 * UI 页面只依赖这里产出的扁平结构（label/value、表格行、状态徽标），
 * 不直接消费 API 视图内部字段；任何展示口径变化集中在这一层。
 */

import type { AuditRowView, DimensionCount } from "../api/reads.js";
import type { DashboardOverview } from "../api/overview.js";
import type { SystemInfoView } from "../api/system.js";

/** 页面级屏幕清单：也是 WebUI 导航/路由与实际 API 端点的契约。 */
export interface MemoryCenterScreen {
  id: string;
  title: string;
  group: "library" | "review" | "operations";
  /** 读取时对应的 API 端点（与页面数据请求一一对应）。 */
  endpoint: string;
}

export const MEMORY_CENTER_SCREENS: MemoryCenterScreen[] = [
  { id: "overview", title: "Overview", group: "library", endpoint: "/overview" },
  { id: "memories", title: "Memory Explorer", group: "library", endpoint: "/memories" },
  { id: "experiences", title: "Experience Center", group: "library", endpoint: "/experiences" },
  { id: "conflicts", title: "Conflict Review", group: "review", endpoint: "/conflicts" },
  { id: "quarantine", title: "Quarantine Review", group: "review", endpoint: "/quarantine" },
  { id: "system", title: "System Health", group: "operations", endpoint: "/system" },
];

/** 仪表盘主卡片（label/value）。 */
export interface OverviewCard {
  label: string;
  value: number;
}

function dimensionCount(dim: DimensionCount[]): { key: string; count: number }[] {
  return dim.map((d) => ({ key: d.value ?? "(none)", count: d.count }));
}

/** DashboardOverview → 卡片化摘要。 */
export function overviewCards(overview: DashboardOverview): OverviewCard[] {
  const { memory, experience, review } = overview;
  return [
    { label: "Memories", value: memory.total },
    { label: "Active", value: memory.active },
    { label: "Quarantined", value: memory.quarantinedPending },
    { label: "Archived", value: memory.archived },
    { label: "Experiences", value: experience.active },
    { label: "Open conflicts", value: review.conflicts.open },
    { label: "Conflicts resolved", value: review.conflicts.resolved },
    { label: "Conflicts discarded", value: review.conflicts.discarded },
  ];
}

/** 各维度分布（scope / type / source / temporal）供图表条用。 */
export function distributionByKind(kind: keyof Pick<DashboardOverview["memory"], "byScope" | "byType" | "bySource" | "byTemporal">, overview: DashboardOverview): { key: string; count: number }[] {
  return dimensionCount(overview.memory[kind]);
}

/** 最近审计活动（时间/动作/实体）。 */
export interface ActivityRow {
  ts: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
}

/** 审计视图 → 展示行（只依赖 reads 层的稳定字段）。 */
export function activityRows(rows: AuditRowView[]): ActivityRow[] {
  return rows.map((row) => ({
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
  }));
}

/** SystemInfoView → 健康页第一区块（标量统计）。 */
export function systemCounts(system: SystemInfoView): OverviewCard[] {
  return [
    { label: "Schema version", value: system.schemaVersion },
    { label: "Memory items", value: system.counts.memoryItems },
    { label: "Open conflicts", value: system.counts.conflictsOpen },
    { label: "Active experiences", value: system.counts.experiencesActive },
    { label: "Audit entries", value: system.counts.auditEntries },
    { label: "Events", value: system.counts.eventsTotal },
    { label: "Cache rows", value: system.cacheRows ?? 0 },
  ];
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** 记忆条目 → 通用表格行（用于 Explorer 与 Detail 的摘要展示）。 */
export interface MemoryRowSummary {
  id: string;
  type: string;
  scope: string;
  projectId: string | null;
  content: string;
  importance: string;
  confidence: number;
  temporalState: string;
  hidden: boolean;
  updatedAt: string;
}

function nestedPick(raw: Record<string, unknown>, key: string, nested = true): unknown {
  const direct = raw[key];
  if (direct !== undefined) return direct;
  if (nested && raw["row"] !== null && typeof raw["row"] === "object") {
    return (raw["row"] as Record<string, unknown>)[key];
  }
  return undefined;
}

export function memoryRowSummary(raw: unknown): MemoryRowSummary | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = nestedPick(record, "id");
  if (id === undefined) return null;
  const updated = nestedPick(record, "updatedAt") ?? nestedPick(record, "updated_at") ?? nestedPick(record, "createdAt");
  const confidence = nestedPick(record, "confidence");
  const num = typeof confidence === "number" ? confidence : Number(confidence ?? NaN);
  return {
    id: String(id),
    type: textOf(nestedPick(record, "type")),
    scope: textOf(nestedPick(record, "scope")),
    projectId:
      nestedPick(record, "projectId") !== undefined
        ? textOf(nestedPick(record, "projectId")) || null
        : nestedPick(record, "project_id") !== undefined
          ? textOf(nestedPick(record, "project_id")) || null
          : null,
    content: textOf(nestedPick(record, "content")),
    importance: textOf(nestedPick(record, "importance")) || "normal",
    confidence: Number.isFinite(num) ? num : 0,
    temporalState: textOf(nestedPick(record, "temporalState")) || "current",
    hidden: Boolean(nestedPick(record, "hidden")) || textOf(nestedPick(record, "temporalState")) === "historical",
    updatedAt: textOf(updated),
  };
}
