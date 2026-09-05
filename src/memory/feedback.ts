/**
 * Feedback / Utility Learning（R5，Q58/Q65）与 Confidence 校准基础。
 *  - 显式反馈只此一处通道，调整 utility + confidence 并写入 feedback_events
 *    （before/after），保证“反馈改变排序”可审计；
 *  - solved 对 experience 走 Experience 主链推进（solution-found → verified），
 *    对 candidate 要求先存在 solution（先有方案、再验证，杜绝空转）；
 *  - obsolete 归档 temporal_state → historical。
 */

import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../store/sqlite.js";
import {
  getMemoryItemById,
  updateMemoryItem,
} from "../store/repository.js";
import type { FeedbackKind } from "../schema/enums.js";
import {
  advanceExperiencePhase,
  DEFAULT_PHASE,
  getExperienceDetails,
} from "./experience.js";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const CLAMPED_CONFIDENCE: readonly [number, number] = [0.05, 0.98];
const CLAMPED_UTILITY: readonly [number, number] = [0.0, 1.0];

/** 反馈 → (confidence, utility) 增量表（R5，Q58/Q65 语义落地）。 */
export const FEEDBACK_DELTAS: Record<
  FeedbackKind,
  { confidence: number; utility: number }
> = {
  confirm: { confidence: 0.1, utility: 0.15 },
  deny: { confidence: -0.15, utility: -0.2 },
  solved: { confidence: 0.15, utility: 0.25 },
  not_helpful: { confidence: -0.1, utility: -0.25 },
  obsolete: { confidence: -0.2, utility: -0.3 },
};

export interface FeedbackResult {
  kind: FeedbackKind;
  confidenceBefore: number;
  confidenceAfter: number;
  utilityBefore: number;
  utilityAfter: number;
}

export interface ApplyFeedbackOptions {
  note?: string;
  actor?: string;
}

/**
 * 记录一次显式反馈并重算 confidence/utility。
 * @returns 反馈前后数值（与 feedback_events 行一致）
 */
export function applyMemoryFeedback(
  db: SqlDatabase,
  memoryId: string,
  kind: FeedbackKind,
  opts: ApplyFeedbackOptions = {},
): FeedbackResult {
  const row = getMemoryItemById(db, memoryId);
  if (row === null) throw new Error(`memory item not found: ${memoryId}`);
  const actor = opts.actor ?? "user";
  if (row.userEdited === 1 && actor !== "user") {
    throw new Error(
      `memory is user-edited; only explicit user feedback may change it: ${memoryId}`,
    );
  }
  const beforeConf = row.confidence;
  const beforeUtil = row.utility;
  const delta = FEEDBACK_DELTAS[kind];

  let afterConf = clamp(
    beforeConf + delta.confidence,
    CLAMPED_CONFIDENCE[0],
    CLAMPED_CONFIDENCE[1],
  );
  let afterUtil = clamp(
    beforeUtil + delta.utility,
    CLAMPED_UTILITY[0],
    CLAMPED_UTILITY[1],
  );
  let temporalPatch = row.temporalState;

  if (kind === "obsolete") {
    // 过时：不逐字修改内容，归档避免再次检索（Q082）。
    temporalPatch = "historical";
    afterUtil = clamp(0.1, CLAMPED_UTILITY[0], CLAMPED_UTILITY[1]);
  }

  if (kind === "solved" && row.type === "experience") {
    // Experience → Solved → Learn（Q65）：feedback 先把 phase 推进到 verified，
    // 再落一次 solved 增量，避免双倍叠加。
    const phase = row.experiencePhase ?? DEFAULT_PHASE;
    if (phase === "candidate" || phase === "investigating") {
      const details = getExperienceDetails(db, memoryId);
      if (details === null || !details.solution.trim()) {
        throw new Error(
          `experience has no solution recorded; save it before marking solved: ${memoryId}`,
        );
      }
    }
    const actorDomain = actor as "user" | "system";
    if (phase === "candidate") {
      advanceExperiencePhase(db, memoryId, "verified", actorDomain);
    } else if (phase === "investigating") {
      advanceExperiencePhase(db, memoryId, "solution-found", actorDomain);
      advanceExperiencePhase(db, memoryId, "verified", actorDomain);
    } else if (phase === "solution-found") {
      advanceExperiencePhase(db, memoryId, "verified", actorDomain);
    }
    // verified / validated：幂等，仅记 solved 反馈增量。
  }

  updateMemoryItem(
    db,
    memoryId,
    {
      confidence: afterConf,
      utility: afterUtil,
      temporalState:
        temporalPatch === row.temporalState ? undefined : temporalPatch,
    },
    actor,
  );

  db.prepare(
    `INSERT INTO feedback_events (
      id,memory_id,kind,note,confidence_before,confidence_after,
      utility_before,utility_after,actor,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `fb_${randomUUID()}`,
    memoryId,
    kind,
    opts.note ?? null,
    beforeConf,
    afterConf,
    beforeUtil,
    afterUtil,
    actor,
    new Date().toISOString(),
  );

  return {
    kind,
    confidenceBefore: beforeConf,
    confidenceAfter: afterConf,
    utilityBefore: beforeUtil,
    utilityAfter: afterUtil,
  };
}

export interface FeedbackEventRow {
  id: string;
  memoryId: string;
  kind: FeedbackKind;
  note: string | null;
  confidenceBefore: number;
  confidenceAfter: number;
  utilityBefore: number;
  utilityAfter: number;
  actor: string;
  createdAt: string;
}

const FEEDBACK_COLS =
  "id,memory_id AS memoryId,kind,note,confidence_before AS confidenceBefore," +
  "confidence_after AS confidenceAfter,utility_before AS utilityBefore," +
  "utility_after AS utilityAfter,actor,created_at AS createdAt";

/** 反馈记录列表（可按记忆过滤）。 */
export function listMemoryFeedback(
  db: SqlDatabase,
  memoryId?: string,
): FeedbackEventRow[] {
  const rows = db
    .prepare(
      `SELECT ${FEEDBACK_COLS} FROM feedback_events
       ORDER BY created_at ASC`,
    )
    .all() as unknown as FeedbackEventRow[];
  return memoryId === undefined
    ? rows
    : rows.filter((r) => r.memoryId === memoryId);
}
