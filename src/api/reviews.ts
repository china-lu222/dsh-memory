/**
 * Memory Center Review Management API（R7）：冲突评审 + 隔离评审 + 经验评审。
 * 动作（resolve/discard/promote/reject/advance）全部委托 memory 域函数；
 * 列表/详情为只读模型。
 */

import { getMemoryItemById, type MemoryItemRow } from "../store/repository.js";
import {
  discardConflictReview,
  listConflictReviews,
  resolveConflictReview,
  type ConflictReviewRow,
  type ResolveConflictOptions,
} from "../memory/conflict.js";
import { advanceExperiencePhase, getExperience, listExperiences, type Experience, type ExperienceFilter } from "../memory/experience.js";
import { listQuarantinedMemories, promoteMemory, rejectMemory } from "../memory/quarantine.js";
import { actorOf, type ApiContext } from "./context.js";
import { attempt, enumOr, parseString, type Result } from "./common.js";

const CONFLICT_STATUSES = ["open", "resolved", "discarded"] as const;
const CONFLICT_RESOLUTIONS = ["merge", "link", "supersede", "keep_separate"] as const;
const EXPERIENCE_PHASE_VALUES = [
  "candidate",
  "investigating",
  "solution-found",
  "verified",
  "validated",
] as const;

export interface ConflictReviewView {
  id: string;
  memoryAId: string;
  memoryBId: string;
  relation: ConflictReviewRow["relation"];
  basis: string;
  status: ConflictReviewRow["status"];
  resolution: ConflictReviewRow["resolution"];
  decisionNote: ConflictReviewRow["decisionNote"];
  actor: ConflictReviewRow["actor"];
  createdAt: ConflictReviewRow["createdAt"];
  updatedAt: ConflictReviewRow["updatedAt"];
  decidedAt: ConflictReviewRow["decidedAt"];
  memoryA: MemoryItemRow | null;
  memoryB: MemoryItemRow | null;
}

function toConflictView(db: ApiContext["db"], row: ConflictReviewRow): ConflictReviewView {
  return {
    id: row.id,
    memoryAId: row.memoryAId,
    memoryBId: row.memoryBId,
    relation: row.relation,
    basis: row.basis,
    status: row.status,
    resolution: row.resolution,
    decisionNote: row.decisionNote,
    actor: row.actor,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
    memoryA: getMemoryItemById(db, row.memoryAId),
    memoryB: getMemoryItemById(db, row.memoryBId),
  };
}

export interface ConflictListRequest {
  status?: unknown;
  limit?: number;
  offset?: number;
}

export function listConflictReviewsApi(
  ctx: ApiContext,
  request: ConflictListRequest = {},
): Result<{ items: ConflictReviewView[]; total: number; limit: number; offset: number }> {
  return attempt(() => {
    let status: ConflictReviewRow["status"] | undefined;
    if (request.status !== undefined) {
      const found = enumOr(CONFLICT_STATUSES, request.status);
      if (found === undefined) throw new Error(`invalid status: ${String(request.status)}`);
      status = found;
    }
    const all = listConflictReviews(ctx.db, status);
    const limit = Math.max(1, Math.min(500, Math.floor(request.limit ?? 50)));
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const page = all.slice(offset, offset + limit);
    return {
      items: page.map((row) => toConflictView(ctx.db, row)),
      total: all.length,
      limit,
      offset,
    };
  });
}

export function getConflictReviewApi(
  ctx: ApiContext,
  id: string,
): Result<ConflictReviewView> {
  return attempt(() => {
    const row = listConflictReviews(ctx.db).find((r) => r.id === id);
    if (row === undefined) throw new Error(`conflict review not found: ${id}`);
    return toConflictView(ctx.db, row);
  });
}

export interface ResolveConflictInput {
  resolution: unknown;
  decisionNote?: string;
  /** merge 解析必填。 */
  mergedContent?: string;
  /** supersede 解析的落败方 id（缺省 memoryB）。 */
  victimId?: string;
  actor?: string;
}

/** 按用户决定处置冲突对（merge/link/supersede/keep_separate）。 */
export function resolveConflict(
  ctx: ApiContext,
  reviewId: string,
  input: ResolveConflictInput,
): Result<ConflictReviewView> {
  return attempt(() => {
    const found = enumOr(CONFLICT_RESOLUTIONS, input.resolution);
    if (found === undefined) {
      throw new Error(`invalid resolution: ${String(input.resolution)}`);
    }
    const opts: ResolveConflictOptions = {
      resolution: found,
      decisionNote: parseString(input.decisionNote),
      actor: input.actor ?? actorOf(ctx),
    };
    if (found === "merge") {
      const mergedContent = parseString(input.mergedContent);
      if (mergedContent === undefined) throw new Error("mergedContent is required for merge");
      opts.mergedContent = mergedContent;
    }
    if (found === "supersede" && parseString(input.victimId) !== undefined) {
      opts.victimId = parseString(input.victimId);
    }
    const row = resolveConflictReview(ctx.db, reviewId, opts);
    return toConflictView(ctx.db, row);
  });
}

/** 将评审标记为误报/不需要处理（不改记忆）。 */
export function discardConflict(
  ctx: ApiContext,
  reviewId: string,
): Result<ConflictReviewView> {
  return attempt(() => {
    const row = discardConflictReview(ctx.db, reviewId, actorOf(ctx));
    return toConflictView(ctx.db, row);
  });
}

export interface QuarantineListRequest {
  /** 是否含已丢弃（historical）记录，默认 false。 */
  includeRejected?: boolean;
  limit?: number;
  offset?: number;
}

/** 隔离区列表（pending；可含已丢弃）。 */
export function listQuarantine(
  ctx: ApiContext,
  request: QuarantineListRequest = {},
): Result<{ items: MemoryItemRow[]; total: number; limit: number; offset: number }> {
  return attempt(() => {
    let rows = listQuarantinedMemories(ctx.db);
    if (request.includeRejected !== true) {
      rows = rows.filter((row) => row.temporalState !== "historical");
    }
    const limit = Math.max(1, Math.min(500, Math.floor(request.limit ?? 50)));
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      limit,
      offset,
    };
  });
}

/** 人工放行：解除隔离并按语义提升置信。 */
export function promoteQuarantine(
  ctx: ApiContext,
  memoryId: string,
): Result<MemoryItemRow> {
  return attempt(() => {
    promoteMemory(ctx.db, memoryId, actorOf(ctx));
    const row = getMemoryItemById(ctx.db, memoryId);
    if (row === null) throw new Error(`memory not found after promote: ${memoryId}`);
    return row;
  });
}

/** 丢弃隔离记忆：作废归档（不可逆动作前请确认）。 */
export function rejectQuarantine(
  ctx: ApiContext,
  memoryId: string,
  note?: string,
): Result<MemoryItemRow> {
  return attempt(() => {
    rejectMemory(ctx.db, memoryId, note ?? "rejected by user in review", actorOf(ctx));
    const row = getMemoryItemById(ctx.db, memoryId);
    if (row === null) throw new Error(`memory not found after reject: ${memoryId}`);
    return row;
  });
}

export interface ExperienceListRequest {
  phase?: unknown;
  projectId?: string;
  includeHistorical?: boolean;
  limit?: number;
  offset?: number;
}

/** 经验评审列表（默认 current；带 project 过滤与分页）。 */
export function listExperiencesApi(
  ctx: ApiContext,
  request: ExperienceListRequest = {},
): Result<{ items: Experience[]; total: number; limit: number; offset: number }> {
  return attempt(() => {
    const filter: ExperienceFilter = { includeHistorical: request.includeHistorical === true };
    if (request.phase !== undefined) {
      const found = enumOr(EXPERIENCE_PHASE_VALUES, request.phase);
      if (found === undefined) throw new Error(`invalid experience phase: ${String(request.phase)}`);
      filter.phase = found;
    }
    const projectId = parseString(request.projectId);
    if (projectId !== undefined) filter.projectId = projectId;
    const all = listExperiences(ctx.db, filter);
    const limit = Math.max(1, Math.min(500, Math.floor(request.limit ?? 50)));
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
  });
}

export function getExperienceApi(
  ctx: ApiContext,
  id: string,
): Result<Experience> {
  return attempt(() => {
    const row = getExperience(ctx.db, id);
    if (row === null) throw new Error(`experience not found: ${id}`);
    return row;
  });
}

/** 用户推进经验 phase（非法跳跃由域层拒绝）。 */
export function advanceExperience(
  ctx: ApiContext,
  id: string,
  next?: unknown,
): Result<string> {
  return attempt(() => {
    let nextPhase: (typeof EXPERIENCE_PHASE_VALUES)[number] | undefined;
    if (next !== undefined) {
      const found = enumOr(EXPERIENCE_PHASE_VALUES, next);
      if (found === undefined) throw new Error(`invalid next phase: ${String(next)}`);
      nextPhase = found;
    }
    return advanceExperiencePhase(ctx.db, id, nextPhase, reviewActorOf(ctx));
  });
}

function reviewActorOf(ctx: ApiContext): "user" | "system" {
  return ctx.actor === "system" ? "system" : "user";
}
