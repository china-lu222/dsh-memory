/**
 * R7 只读模型查询：WebUI 各页的展示查询统一走这里（写路径一律走域函数）。
 * 仅 SELECT；列名由白名单类型约束，杜绝注入面。
 */

import type { SqlDatabase } from "../store/sqlite.js";

export interface AuditRowView {
  id: string;
  ts: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  /** audit_log JSON 列解包（解析失败为 undefined）。 */
  before: unknown;
  after: unknown;
}

function parseJsonColumn(raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(String(raw)) as unknown;
  } catch {
    return undefined;
  }
}

/** 审计流水（可选按 entity 过滤），供详情页“版本/变更历史”与总览 feed 使用。 */
export function listAuditRows(
  db: SqlDatabase,
  options: { entityId?: string; entityType?: string; limit?: number; offset?: number } = {},
): AuditRowView[] {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.entityId !== undefined) {
    conditions.push("entity_id = ?");
    params.push(options.entityId);
  }
  if (options.entityType !== undefined) {
    conditions.push("entity_type = ?");
    params.push(options.entityType);
  }
  const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  params.push(limit, offset);
  const rows = db
    .prepare(
      `SELECT id, ts, actor, action, entity_type, entity_id, before_json, after_json
       FROM audit_log${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params) as unknown as Array<{
    id: string;
    ts: string;
    actor: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before_json: string | null;
    after_json: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: parseJsonColumn(row.before_json),
    after: parseJsonColumn(row.after_json),
  }));
}

export function countRows(db: SqlDatabase, table: string, where = "", params: Array<string | number> = []): number {
  const safe = /^[a-z_]+$/.test(table) ? table : "memory_items";
  const sql = `SELECT COUNT(*) AS c FROM ${safe}${where ? ` WHERE ${where}` : ""}`;
  return Number((db.prepare(sql).get(...params) as { c: number }).c);
}

/** 可安全 GROUP BY 的 memory_items 维度列（白名单）。 */
export type MemoryDimension =
  | "scope"
  | "type"
  | "source_kind"
  | "experience_phase"
  | "temporal_state"
  | "profile_category"
  | "project_category"
  | "hidden";

export interface DimensionCount {
  value: string | null;
  count: number;
}

export function countByDimension(
  db: SqlDatabase,
  table: "memory_items" | "conflict_reviews",
  column: MemoryDimension,
  where = "",
  params: Array<string | number> = [],
): DimensionCount[] {
  if (table === "conflict_reviews" && column !== "hidden") {
    throw new Error(`column ${column} is not available on conflict_reviews`);
  }
  const sql = `SELECT ${column} AS value, COUNT(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ""} GROUP BY ${column} ORDER BY c DESC`;
  const rows = db.prepare(sql).all(...params) as unknown as Array<{ value: string | null; c: number }>;
  return rows.map((row) => ({ value: row.value, count: Number(row.c) }));
}
