/**
 * Conflict Resolution / Review Queue（R5，Q096/Q097）与血缘登记（Q076）。
 *  - 检测：同型同作用域记忆的文本重复（same_fact / shared_pattern）与
 *    约束反义矛盾（contradiction），一律先入 Review Queue，不静默改写；
 *  - 裁决：merge / link / supersede / keep_separate 由人工或明确调用触发，
 *    同时登记 memory_lineage。
 */

import { createHash } from "node:crypto";
import type { SqlDatabase } from "../store/sqlite.js";
import {
  getMemoryItemById,
  listAllMemoryItems,
  updateMemoryItem,
  writeDomainAudit,
} from "../store/repository.js";
import type {
  ConflictRelation,
  ConflictResolution,
  ConflictStatus,
  MemoryType,
  TemporalState,
} from "../schema/enums.js";

export type {
  ConflictRelation,
  ConflictResolution,
  ConflictStatus,
};

/** memory_lineage.relation 词汇（与迁移 v4 DDL CHECK 一致，Q076）。 */
export const LINEAGE_RELATIONS = [
  "derived_from",
  "merged_from",
  "supported_by",
  "validated_by",
  "supersedes",
  "contradicts",
  "generalized_from",
  "related_to",
] as const;
export type LineageRelation = (typeof LINEAGE_RELATIONS)[number];

/** 比较用的归一化 token。 */
export function tokenizeText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 0),
  );
}

/** token 集合 Jaccard 相似度。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common += 1;
  return common / (a.size + b.size - common);
}

const NEGATION = /(must not|mustn'?t|never|do not|don'?t|cannot|can'?t|禁止|不要|不能)/;

/**
 * 判定两条同型记忆的冲突关系。
 * @returns relation；无冲突语义返回 null
 */
export function classifyPair(
  a: string,
  b: string,
  type: MemoryType,
): ConflictRelation | null {
  const at = tokenizeText(a);
  const bt = tokenizeText(b);
  if (at.size === 0 || bt.size === 0) return null;
  const sim = jaccard(at, bt);
  // 约束反义矛盾（Q080/Q096）：一句禁止、一句允许同一动作。
  // 共享词越多，越确定指向同一动作的否定 → 优先于 shared_pattern 判定。
  if (type === "personal" && sim >= 0.4) {
    const aNeg = NEGATION.test(a.toLowerCase());
    const bNeg = NEGATION.test(b.toLowerCase());
    if (aNeg !== bNeg) return "contradiction";
  }
  if (sim >= 0.95) return "same_fact";
  if (sim >= 0.6) return "shared_pattern";
  return null;
}

export interface ConflictCandidate {
  otherId: string;
  relation: ConflictRelation;
  basis: string;
}

/** 扫描与给定记忆同型、可比较作用域内其它记忆的冲突候选。 */
export function detectMemoryConflicts(
  db: SqlDatabase,
  memoryId: string,
): ConflictCandidate[] {
  const row = getMemoryItemById(db, memoryId);
  if (row === null) return [];
  const others = listAllMemoryItems(db).filter(
    (r) =>
      r.id !== memoryId &&
      r.type === row.type &&
      r.hidden === 0 &&
      r.type !== "experience", // experience 冲突走相似候选再评审，也允许，但保守起见单列
  );
  const candidates: ConflictCandidate[] = [];
  for (const other of others) {
    const relation = classifyPair(row.content, other.content, row.type);
    if (relation === null) continue;
    candidates.push({
      otherId: other.id,
      relation,
      basis:
        relation === "same_fact"
          ? "duplicate content"
          : relation === "contradiction"
            ? "allow vs deny on shared action"
            : "high similarity",
    });
  }
  return candidates;
}

export interface NewConflictReview {
  memoryAId: string;
  memoryBId: string;
  relation: ConflictRelation;
  basis: string;
  actor?: string;
}

export interface ConflictReviewRow {
  id: string;
  memoryAId: string;
  memoryBId: string;
  relation: ConflictRelation;
  basis: string;
  status: ConflictStatus;
  resolution: ConflictResolution | null;
  decisionNote: string | null;
  actor: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

const REVIEW_COLS =
  "id,memory_a_id AS memoryAId,memory_b_id AS memoryBId,relation,basis,status," +
  "resolution,decision_note AS decisionNote,actor,created_at AS createdAt," +
  "updated_at AS updatedAt,decided_at AS decidedAt";

function getReview(
  db: SqlDatabase,
  id: string,
): ConflictReviewRow | null {
  const row = db
    .prepare(`SELECT ${REVIEW_COLS} FROM conflict_reviews WHERE id = ?`)
    .get(id) as ConflictReviewRow | undefined;
  return row ?? null;
}

function reviewIdFor(a: string, b: string): string {
  const seed = a < b ? `${a}|${b}` : `${b}|${a}`;
  return `rev_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 20)}`;
}

/** 为两条记忆建冲突评审（同对已有 open 评审时幂等返回）。 */
export function createConflictReview(
  db: SqlDatabase,
  input: NewConflictReview,
): ConflictReviewRow {
  for (const id of [input.memoryAId, input.memoryBId]) {
    if (getMemoryItemById(db, id) === null) {
      throw new Error(`memory item not found: ${id}`);
    }
  }
  const id = reviewIdFor(input.memoryAId, input.memoryBId);
  const existing = getReview(db, id);
  if (existing !== null && existing.status === "open") {
    return existing;
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conflict_reviews (
      id,memory_a_id,memory_b_id,relation,basis,status,actor,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.memoryAId,
    input.memoryBId,
    input.relation,
    input.basis,
    "open",
    input.actor ?? "system",
    now,
    now,
  );
  writeDomainAudit(db, input.actor ?? "system", "conflict.open", id, null, {
    memoryAId: input.memoryAId,
    memoryBId: input.memoryBId,
    relation: input.relation,
    basis: input.basis,
  });
  return getReview(db, id)!;
}

/** 登记血缘关系（Q076）。 */
export function attachLineage(
  db: SqlDatabase,
  memoryId: string,
  relation: LineageRelation,
  otherMemoryId: string,
  note?: string,
  actor = "system",
): void {
  if (getMemoryItemById(db, memoryId) === null) {
    throw new Error(`memory item not found: ${memoryId}`);
  }
  if (getMemoryItemById(db, otherMemoryId) === null) {
    throw new Error(`memory item not found: ${otherMemoryId}`);
  }
  const id = `ln_${createHash("sha256").update(
    `${memoryId}|${relation}|${otherMemoryId}`,
    "utf8",
  ).digest("hex").slice(0, 20)}`;
  db.prepare(
    `INSERT OR IGNORE INTO memory_lineage (
      id,memory_id,relation,other_memory_id,note,created_at
    ) VALUES (?,?,?,?,?,?)`,
  ).run(id, memoryId, relation, otherMemoryId, note ?? null, new Date().toISOString());
}

export interface ResolveConflictOptions {
  resolution: ConflictResolution;
  actor: string;
  decisionNote?: string;
  /** merge 时必填：合并后的内容写入 memory_a。 */
  mergedContent?: string;
  /** supersede 的方向：默认 memory_a 取代 memory_b。 */
  victimId?: string;
}

/** 裁决一条 open 冲突评审。 */
export function resolveConflictReview(
  db: SqlDatabase,
  reviewId: string,
  opts: ResolveConflictOptions,
): ConflictReviewRow {
  const review = getReview(db, reviewId);
  if (review === null) throw new Error(`conflict review not found: ${reviewId}`);
  if (review.status !== "open") {
    throw new Error(`conflict review is not open: ${reviewId} (${review.status})`);
  }
  const a = getMemoryItemById(db, review.memoryAId);
  const b = getMemoryItemById(db, review.memoryBId);
  if (a === null || b === null) {
    throw new Error("conflict review references a missing memory item");
  }
  const now = new Date().toISOString();
  switch (opts.resolution) {
    case "keep_separate":
      // 无记忆变更。
      break;
    case "link":
      attachLineage(db, a.id, "related_to", b.id, opts.decisionNote, opts.actor);
      attachLineage(db, b.id, "related_to", a.id, opts.decisionNote, opts.actor);
      break;
    case "supersede": {
      const victimId = opts.victimId ?? b.id;
      const victim = getMemoryItemById(db, victimId);
      const survivor = victimId === b.id ? a : b;
      if (victim === null || survivor === null) {
        throw new Error(`supersede target not found: ${victimId}`);
      }
      setTemporal(db, victim.id, "superseded", opts.actor);
      attachLineage(
        db,
        survivor.id,
        "supersedes",
        victim.id,
        opts.decisionNote,
        opts.actor,
      );
      break;
    }
    case "merge": {
      if (!opts.mergedContent?.trim()) {
        throw new Error("mergedContent is required for merge resolution");
      }
      updateMemoryItem(db, a.id, { content: opts.mergedContent }, opts.actor);
      setTemporal(db, b.id, "superseded", opts.actor);
      attachLineage(db, a.id, "merged_from", b.id, opts.decisionNote, opts.actor);
      break;
    }
  }
  db.prepare(
    `UPDATE conflict_reviews SET
      status='resolved',resolution=?,decision_note=?,actor=?,decided_at=?,updated_at=?
      WHERE id=?`,
  ).run(
    opts.resolution,
    opts.decisionNote ?? null,
    opts.actor,
    now,
    now,
    reviewId,
  );
  writeDomainAudit(db, opts.actor, "conflict.resolve", reviewId, review, {
    resolution: opts.resolution,
    decisionNote: opts.decisionNote ?? null,
  });
  return getReview(db, reviewId)!;
}

function setTemporal(
  db: SqlDatabase,
  id: string,
  state: TemporalState,
  actor: string,
): void {
  updateMemoryItem(db, id, { temporalState: state }, actor);
}

/** 作废一条误报评审（不改记忆）。 */
export function discardConflictReview(
  db: SqlDatabase,
  reviewId: string,
  actor = "system",
): ConflictReviewRow {
  const review = getReview(db, reviewId);
  if (review === null) throw new Error(`conflict review not found: ${reviewId}`);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE conflict_reviews SET
      status='discarded',actor=?,decision_note=?,decided_at=?,updated_at=? WHERE id=?`,
  ).run(actor, "discarded as duplicate or false positive", now, now, reviewId);
  writeDomainAudit(db, actor, "conflict.discard", reviewId, review, { actor });
  return getReview(db, reviewId)!;
}

/** 列出评审（默认 open）。 */
export function listConflictReviews(
  db: SqlDatabase,
  status?: ConflictStatus,
): ConflictReviewRow[] {
  const rows = db
    .prepare(
      `SELECT ${REVIEW_COLS} FROM conflict_reviews
       ORDER BY created_at ASC`,
    )
    .all() as unknown as ConflictReviewRow[];
  return status === undefined
    ? rows
    : rows.filter((r) => r.status === status);
}
