/**
 * 后台 Consolidation（R6，Q046/Q047 基础）。
 *
 * 两层：
 *  - `runRealtimeLocalDedup`：精确重复（同内容同 scope/project）→ 直接合并；
 *    高相似但非重复 → 开 Conflict Review（复用 R5 幂等评审，不静默合并）。
 *  - `runDeepConsolidation`：验证过的 Experience 之间做 evidence/细节对齐，
 *    输出 generalized 候选（交给 generalize.ts 按阈值晋升）。
 *
 * 一致性护栏：
 *  - user_edited 记忆锁：拒绝自动合并，一律转为人工评审；
 *  - 永不物理删除：被合并方置 superseded+hidden，审计 before/after + domain
 *    事件双留痕（history/evidence/version 保留）；
 *  - 合并前走 Resolution（精确匹配且非 user-edited 才可自动），合并后产生
 *    Version/Audit/Event（经 updateMemoryItem/audit 链）。
 */

import {
  getMemoryItemById,
  listAllMemoryItems,
  updateMemoryItem,
  writeDomainAudit,
} from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { createConflictReview, jaccard, tokenizeText } from "./conflict.js";
import type { MemoryItemRow } from "../store/repository.js";

export interface ConsolidationCandidate {
  idA: string;
  idB: string;
  score: number;
  reason: "exact-dup" | "near-dup";
}

export interface ConsolidationAction {
  kind: "merged" | "review-opened" | "skipped";
  idA?: string;
  idB?: string;
  reason: string;
}

export interface ConsolidationSummary {
  scanned: number;
  candidates: number;
  merged: number;
  reviewsOpened: number;
  skipped: number;
  actions: ConsolidationAction[];
}

const EXACT_DUP_SCORE = 1;

/** 内容相似度高且范围可比较的两条记忆，判为整合候选。 */
export function findConsolidationCandidates(
  db: SqlDatabase,
  options: { minJaccard?: number } = {},
): ConsolidationCandidate[] {
  const minJaccard = options.minJaccard ?? 0.9;
  const rows = listAllMemoryItems(db).filter(
    (m) => m.temporalState === "current" || m.temporalState === "historical",
  );
  const out: ConsolidationCandidate[] = [];
  for (const [i, a] of rows.entries()) {
    for (const b of rows.slice(i + 1)) {
      if (a.scope !== b.scope) continue;
      if (a.projectId !== b.projectId) continue;
      if (a.type !== b.type) continue;
      const exact =
        a.content.trim() === b.content.trim() && a.sourceKind === b.sourceKind;
      const score = exact
        ? EXACT_DUP_SCORE
        : jaccard(tokenizeText(a.content), tokenizeText(b.content));
      if (score >= (exact ? EXACT_DUP_SCORE : minJaccard)) {
        out.push({
          idA: a.id,
          idB: b.id,
          score,
          reason: exact ? "exact-dup" : "near-dup",
        });
      }
    }
  }
  return out;
}

/** 实时本地去重：精确重复直接合并；近似重复开评审。 */
export function runRealtimeLocalDedup(
  db: SqlDatabase,
  options: { actor?: string; minJaccard?: number } = {},
): ConsolidationSummary {
  const actor = options.actor ?? "system";
  const candidates = findConsolidationCandidates(db, {
    minJaccard: options.minJaccard,
  });
  const summary: ConsolidationSummary = {
    scanned: listAllMemoryItems(db).length,
    candidates: candidates.length,
    merged: 0,
    reviewsOpened: 0,
    skipped: 0,
    actions: [],
  };
  for (const c of candidates) {
    const action = consolidatePair(db, c, { actor });
    summary.actions.push(action);
    if (action.kind === "merged") summary.merged++;
    else if (action.kind === "review-opened") summary.reviewsOpened++;
    else summary.skipped++;
  }
  return summary;
}

/**
 * 后台深度整合：对验证过的 Experience 重复簇做安全合并 + 识别可晋升模式。
 * @returns 摘要；若给 `promoteSink`（generalize.ts 的回调），返回晋升候选数。
 */
export function runDeepConsolidation(
  db: SqlDatabase,
  options: {
    actor?: string;
    minJaccard?: number;
    promoteSink?: (sources: MemoryItemRow[]) => number;
  } = {},
): ConsolidationSummary & { promotionCandidates: number } {
  const actor = options.actor ?? "system";
  const rows = listAllMemoryItems(db).filter((m) => m.type === "experience");
  const summary = runRealtimeLocalDedup(db, { actor, minJaccard: options.minJaccard });
  const res = { ...summary, promotionCandidates: 0 };

  // 验证过 + 高置信 + 结构化的 Experience 按 scope/project 聚簇，找跨记忆共享 pattern。
  const validated = rows.filter(
    (m) =>
      (m.temporalState === "current" || m.temporalState === "historical") &&
      (m.experiencePhase === "verified" || m.experiencePhase === "validated") &&
      (m.confidence ?? 0) >= 0.7,
  );
  const clusters = new Map<string, MemoryItemRow[]>();
  for (const m of validated) {
    const tokens = [...tokenizeText(m.content)];
    const nucleus = tokens.slice(0, 4).join("|");
    const key = `${m.scope}:${m.projectId ?? ""}:${nucleus}`;
    const list = clusters.get(key) ?? [];
    list.push(m);
    clusters.set(key, list);
  }
  for (const group of clusters.values()) {
    if (group.length < 2) continue;
    const distinctProjects = new Set(group.map((g) => g.projectId ?? "")).size;
    if (options.promoteSink !== undefined && distinctProjects >= 2) {
      res.promotionCandidates += options.promoteSink(group);
    }
  }
  return res;
}

/**
 * 合并裁决：
 *  - victim 为 user_edited → 拒绝自动合并（保护锁），转开评审；
 *  - 精确重复（同 content+source）且双方非 user_edited → survivor 保留
 *    content 并吸收 victim 细节，victim superseded + hidden（evidence 保留）；
 *  - 近似重复 → 开评审（不静默改记忆）。
 */
export function consolidatePair(
  db: SqlDatabase,
  c: ConsolidationCandidate,
  options: { actor?: string },
): ConsolidationAction {
  const actor = options.actor ?? "system";
  const survivor = getMemoryItemById(db, c.idA);
  const victim = getMemoryItemById(db, c.idB);
  if (survivor === null || victim === null) {
    return { kind: "skipped", reason: "row-missing" };
  }
  if (survivor.userEdited === 1 || victim.userEdited === 1) {
    // user-edited 锁：不自动动用户显式编辑的记忆。
    if (c.reason === "near-dup") {
      openReviewForPair(db, c, actor);
      return {
        kind: "review-opened",
        idA: c.idA,
        idB: c.idB,
        reason: "user-edited lock: review instead of merge",
      };
    }
    return {
      kind: "skipped",
      idA: c.idA,
      idB: c.idB,
      reason: "user-edited lock",
    };
  }
  if (c.reason === "exact-dup" && c.score >= EXACT_DUP_SCORE) {
    return mergeMemory(db, survivor, victim, actor);
  }
  openReviewForPair(db, c, actor);
  return {
    kind: "review-opened",
    idA: c.idA,
    idB: c.idB,
    reason: `near-dup ${c.score.toFixed(3)} >= threshold`,
  };
}

function mergeMemory(
  db: SqlDatabase,
  survivor: MemoryItemRow,
  victim: MemoryItemRow,
  actor: string,
): ConsolidationAction {
  if (victim.userEdited === 1) {
    return {
      kind: "skipped",
      idA: survivor.id,
      idB: victim.id,
      reason: "user-edited lock (victim)",
    };
  }
  const mergedContent = mergeText(survivor.content, victim.content);
  const before = { ...survivor, version: survivor.version };
  if (mergedContent !== survivor.content) {
    updateMemoryItem(db, survivor.id, { content: mergedContent }, actor);
  }
  // victim：superseded + hidden，行保留（evidence/history 不删除）。
  updateMemoryItem(
    db,
    victim.id,
    { temporalState: "superseded" as const, hidden: true },
    actor,
  );
  writeDomainAudit(db, actor, "consolidation.merge", survivor.id, before, {
    ...getMemoryItemById(db, survivor.id),
    absorbedMemoryId: victim.id,
    absorbedVersion: victim.version,
    reason: "realtime dedup (exact duplicate)",
  });
  return {
    kind: "merged",
    idA: survivor.id,
    idB: victim.id,
    reason: `exact dup; absorbed ${victim.id} v${victim.version}`,
  };
}

function openReviewForPair(
  db: SqlDatabase,
  c: ConsolidationCandidate,
  actor: string,
): void {
  createConflictReview(db, {
    memoryAId: c.idA,
    memoryBId: c.idB,
    relation: "shared_pattern",
    basis: `consolidation near-dup score=${c.score.toFixed(3)}`,
    actor,
  });
}

/** 逐句合并去重：保留证据全文，重叠句只留一次。 */
function mergeText(a: string, b: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const text of [a, b]) {
    for (const line of text.split(/\n+/).map((l) => l.trim())) {
      if (line.length === 0) continue;
      const key = line.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        parts.push(line);
      }
    }
  }
  return parts.join("\n");
}
