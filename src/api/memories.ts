/**
 * Memory Center「记忆」管理 API（R7）。
 * 读：列表（SQL 只读模型）+ 详情/变更历史；写：委托 repository 域函数
 * （insert/update/archive/restore），保留 audit/version/event 语义。
 */

import type { MemoryItemRow } from "../store/repository.js";
import {
  archiveMemoryItem,
  getMemoryItemById,
  insertMemoryItem,
  restoreMemoryItem,
  updateMemoryItem,
} from "../store/repository.js";
import {
  EXPERIENCE_PHASES,
  IMPORTANCES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  PROFILE_CATEGORIES,
  PROJECT_CATEGORIES,
  SOURCE_KINDS,
  TEMPORAL_STATES,
} from "../schema/enums.js";
import { actorOf, type ApiContext } from "./context.js";
import { attempt, enumOr, isOneOf, ok, parseString, type Result } from "./common.js";
import { listAuditRows } from "./reads.js";

export type MemoryListView = "active" | "quarantined" | "archived" | "all";
export type MemoryListSort = "createdAt" | "updatedAt" | "confidence";
export type MemoryListOrder = "asc" | "desc";

export interface MemoryListRequest {
  /** 默认 active：未隐藏且非 historical。 */
  view?: MemoryListView;
  scope?: unknown;
  type?: unknown;
  sourceKind?: unknown;
  experiencePhase?: unknown;
  temporalState?: unknown;
  projectId?: string;
  /** content 子串过滤（LIKE，转义 %/_）。 */
  q?: string;
  sort?: MemoryListSort;
  order?: MemoryListOrder;
  limit?: number;
  offset?: number;
}

export interface MemoryListOutcome {
  items: MemoryItemRow[];
  total: number;
  limit: number;
  offset: number;
}

const SORT_COLUMNS: Record<MemoryListSort, string> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  confidence: "confidence",
};

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** 列表页：维度过滤 + 分页 + 排序（读模型只读，不触写路径）。 */
export function listMemories(
  ctx: ApiContext,
  request: MemoryListRequest,
): Result<MemoryListOutcome> {
  return attempt(() => {
    const view = request.view ?? "active";
    if (!isOneOf(["active", "quarantined", "archived", "all"] as const, view)) {
      throw new Error(`unknown view: ${String(view)}`);
    }
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (view === "active") {
      clauses.push("hidden = 0", "temporal_state != 'historical'");
    } else if (view === "quarantined") {
      clauses.push("hidden = 1");
    } else if (view === "archived") {
      clauses.push("temporal_state = 'historical'");
    }

    const scope = enumOr(MEMORY_SCOPES, request.scope);
    if (request.scope !== undefined && scope === undefined) {
      throw new Error(`invalid scope: ${String(request.scope)}`);
    }
    if (scope !== undefined) {
      clauses.push("scope = ?");
      params.push(scope);
    }

    const type = enumOr(MEMORY_TYPES, request.type);
    if (request.type !== undefined && type === undefined) {
      throw new Error(`invalid type: ${String(request.type)}`);
    }
    if (type !== undefined) {
      clauses.push("type = ?");
      params.push(type);
    }

    const sourceKind = enumOr(SOURCE_KINDS, request.sourceKind);
    if (request.sourceKind !== undefined && sourceKind === undefined) {
      throw new Error(`invalid sourceKind: ${String(request.sourceKind)}`);
    }
    if (sourceKind !== undefined) {
      clauses.push("source_kind = ?");
      params.push(sourceKind);
    }

    const experiencePhase = enumOr(EXPERIENCE_PHASES, request.experiencePhase);
    if (request.experiencePhase !== undefined && experiencePhase === undefined) {
      throw new Error(`invalid experiencePhase: ${String(request.experiencePhase)}`);
    }
    if (experiencePhase !== undefined) {
      clauses.push("experience_phase = ?");
      params.push(experiencePhase);
    }

    const temporalState = enumOr(TEMPORAL_STATES, request.temporalState);
    if (request.temporalState !== undefined && temporalState === undefined) {
      throw new Error(`invalid temporalState: ${String(request.temporalState)}`);
    }
    if (temporalState !== undefined) {
      clauses.push("temporal_state = ?");
      params.push(temporalState);
    }

    const projectId = parseString(request.projectId);
    if (projectId !== undefined) {
      clauses.push("project_id = ?");
      params.push(projectId);
    }

    const q = parseString(request.q);
    if (q !== undefined) {
      clauses.push("content LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(q)}%`);
    }

    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const total = Number(
      (ctx.db
        .prepare(`SELECT COUNT(*) AS c FROM memory_items${where}`)
        .get(...params) as { c: number }).c,
    );

    const sort = request.sort ?? "createdAt";
    const order = request.order ?? "desc";
    if (!isOneOf(["asc", "desc"] as const, order)) {
      throw new Error(`invalid order: ${String(order)}`);
    }
    const limit = Math.max(1, Math.min(500, Math.floor(request.limit ?? 50)));
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const pageParams = [...params, limit, offset];
    const ids = ctx.db
      .prepare(
        `SELECT id FROM memory_items${where}
         ORDER BY ${SORT_COLUMNS[sort] ?? "created_at"} ${order} LIMIT ? OFFSET ?`,
      )
      .all(...pageParams) as unknown as Array<{ id: string }>;
    const items = ids
      .map((row) => getMemoryItemById(ctx.db, row.id))
      .filter((row): row is MemoryItemRow => row !== null);
    return { items, total, limit, offset };
  });
}

export interface MemoryDetailOutcome {
  memory: MemoryItemRow;
  /** entity 审计流水（最新在前）。 */
  history: ReturnType<typeof listAuditRows>;
}

export function getMemory(
  ctx: ApiContext,
  id: string,
): Result<MemoryDetailOutcome> {
  return attempt(() => {
    const memory = getMemoryItemById(ctx.db, id);
    if (memory === null) throw new Error(`memory not found: ${id}`);
    return { memory, history: listAuditRows(ctx.db, { entityId: id, limit: 100 }) };
  });
}

export interface CreateMemoryInput {
  type: unknown;
  scope: unknown;
  content: string;
  projectId?: string;
  importance?: unknown;
  confidence?: unknown;
  sourceKind?: unknown;
  summary?: string;
  experiencePhase?: unknown;
  profileCategory?: unknown;
  projectCategory?: unknown;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}

/** 手工新建一条记忆（actor=user，显式来源标记）。 */
export function createMemory(
  ctx: ApiContext,
  input: CreateMemoryInput,
): Result<MemoryItemRow> {
  return attempt(() => {
    const content = parseString(input.content);
    if (content === undefined) throw new Error("content is required");
    if (content.length > 4000) throw new Error("content too long (max 4000)");
    const type = enumOr(MEMORY_TYPES, input.type);
    if (type === undefined) throw new Error(`invalid type: ${String(input.type)}`);
    const scope = enumOr(MEMORY_SCOPES, input.scope);
    if (scope === undefined) throw new Error(`invalid scope: ${String(input.scope)}`);

    const importance = enumOr(IMPORTANCES, input.importance);
    if (input.importance !== undefined && importance === undefined) {
      throw new Error(`invalid importance: ${String(input.importance)}`);
    }
    const confidence = parseConfidence(input.confidence);
    const sourceKind = enumOr(SOURCE_KINDS, input.sourceKind) ?? "user-edited";
    const experiencePhase = enumOr(EXPERIENCE_PHASES, input.experiencePhase);
    if (input.experiencePhase !== undefined && experiencePhase === undefined) {
      throw new Error(`invalid experiencePhase: ${String(input.experiencePhase)}`);
    }
    const profileCategory = enumOr(PROFILE_CATEGORIES, input.profileCategory);
    if (input.profileCategory !== undefined && profileCategory === undefined) {
      throw new Error(`invalid profileCategory: ${String(input.profileCategory)}`);
    }
    const projectCategory = enumOr(PROJECT_CATEGORIES, input.projectCategory);
    if (input.projectCategory !== undefined && projectCategory === undefined) {
      throw new Error(`invalid projectCategory: ${String(input.projectCategory)}`);
    }

    const row = insertMemoryItem(
      ctx.db,
      {
        type,
        scope,
        content,
        projectId: parseString(input.projectId),
        importance,
        confidence,
        sourceKind,
        summary: parseString(input.summary),
        experiencePhase,
        profileCategory,
        projectCategory,
        observedAt: parseString(input.observedAt),
        validFrom: parseString(input.validFrom),
        validUntil: parseString(input.validUntil),
      },
      actorOf(ctx),
    );
    return row;
  });
}

export interface MemoryEditInput {
  content?: string;
  importance?: unknown;
  confidence?: unknown;
  sourceKind?: unknown;
  experiencePhase?: unknown;
  temporalState?: unknown;
  lifecycleStatus?: string | null;
  summary?: string | null;
  profileCategory?: unknown;
  projectCategory?: unknown;
  utility?: unknown;
  observedAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  /** 是否标记为 user-edited（默认 true，防后台覆盖）。 */
  userEdited?: boolean;
}

/** 编辑记忆（详情页表单）；null 表示清空可空字段。 */
export function updateMemory(
  ctx: ApiContext,
  id: string,
  input: MemoryEditInput,
): Result<MemoryItemRow> {
  return attempt(() => {
    const existing = getMemoryItemById(ctx.db, id);
    if (existing === null) throw new Error(`memory not found: ${id}`);

    const patch: Parameters<typeof updateMemoryItem>[2] = {};

    const content = parseString(input.content);
    if (input.content !== undefined && content === undefined) {
      throw new Error("content cannot be empty");
    }
    if (content !== undefined) {
      if (content.length > 4000) throw new Error("content too long (max 4000)");
      patch.content = content;
    }

    const importance = enumOr(IMPORTANCES, input.importance);
    if (input.importance !== undefined && importance === undefined) {
      throw new Error(`invalid importance: ${String(input.importance)}`);
    }
    if (importance !== undefined) patch.importance = importance;

    const confidence = parseConfidence(input.confidence);
    if (confidence !== undefined) patch.confidence = confidence;

    const sourceKind = enumOr(SOURCE_KINDS, input.sourceKind);
    if (input.sourceKind !== undefined && sourceKind === undefined) {
      throw new Error(`invalid sourceKind: ${String(input.sourceKind)}`);
    }
    if (sourceKind !== undefined) patch.sourceKind = sourceKind;

    const experiencePhase = resolveNullableEnum(EXPERIENCE_PHASES, input.experiencePhase);
    if (experiencePhase.set) patch.experiencePhase = experiencePhase.value;

    const temporalState = enumOr(TEMPORAL_STATES, input.temporalState);
    if (input.temporalState !== undefined && temporalState === undefined) {
      throw new Error(`invalid temporalState: ${String(input.temporalState)}`);
    }
    if (temporalState !== undefined) patch.temporalState = temporalState;

    patch.lifecycleStatus = clearableString(input.lifecycleStatus);
    patch.summary = clearableString(input.summary);

    const profileCategory = resolveNullableEnum(PROFILE_CATEGORIES, input.profileCategory);
    if (profileCategory.set) patch.profileCategory = profileCategory.value;

    const projectCategory = resolveNullableEnum(PROJECT_CATEGORIES, input.projectCategory);
    if (projectCategory.set) patch.projectCategory = projectCategory.value;

    const utility = parseConfidence(input.utility);
    if (utility !== undefined) patch.utility = utility;

    patch.observedAt = clearableString(input.observedAt);
    patch.validFrom = clearableString(input.validFrom);
    patch.validUntil = clearableString(input.validUntil);
    patch.userEdited = input.userEdited ?? true;

    return updateMemoryItem(ctx.db, id, patch, actorOf(ctx));
  });
}

/** 归档（→historical），保留全部 version/audit 轨迹。 */
export function archiveMemory(
  ctx: ApiContext,
  id: string,
): Result<MemoryItemRow> {
  return attempt(() => archiveMemoryItem(ctx.db, id, actorOf(ctx)));
}

/** 恢复归档记忆（→current）。 */
export function restoreMemory(
  ctx: ApiContext,
  id: string,
): Result<MemoryItemRow> {
  return attempt(() => restoreMemoryItem(ctx.db, id, actorOf(ctx)));
}

export function markMemoryDeleted(): Result<never> {
  return { ok: false, error: "physical delete is not allowed; use archive instead" };
}

function parseConfidence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`invalid confidence (0..1): ${String(value)}`);
  }
  return n;
}

/** 可空字符串：undefined 不改；null/空清空为 null；非空取 trim。 */
function clearableString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 可空枚举：undefined 不改；null 清空为 null；非法值抛错。 */
function resolveNullableEnum<const T extends readonly string[]>(
  options: T,
  value: unknown,
): { set: boolean; value: T[number] | null } {
  if (value === undefined) return { set: false, value: null };
  if (value === null) return { set: true, value: null };
  const found = enumOr(options, value);
  if (found === undefined) throw new Error(`invalid value: ${String(value)}`);
  return { set: true, value: found };
}
