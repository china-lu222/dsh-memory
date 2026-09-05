/**
 * Generalized Knowledge 晋升基础（R6，Q045/Q062）。
 *
 * Experience → Pattern → validation → Generalized Knowledge 的四步必须通过
 * evidence/validation threshold 才落地，绝不因“看起来相似”自动晋升。
 *   - discoverPatternCandidates：多个验证过 Experience 共享 pattern → 候选；
 *   - createPatternCandidate：登记 candidate（写 `generalized_meta` + audit/
 *     event），不自动晋升；
 *   - validatePattern：收到新的 evidence/显式 feedback 后推进 validation；
 *   - promotePattern：达标 → 写入 Generalized Knowledge 记忆（scope=generalized），
 *     血缘字段 generalized_from/supported_by/validated_by + evidence/confidence
 *     全部持久化，且保留候选记录（不删除证据/历史）。
 */

import { randomUUID } from "node:crypto";
import {
  getMemoryItemById,
  insertMemoryItem,
  listAllMemoryItems,
  writeDomainAudit,
} from "../store/repository.js";
import type { MemoryItemRow } from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { tokenizeText } from "./conflict.js";

export interface PatternThresholds {
  minEvidencePerSource?: number;
  minConfidence?: number;
  minSources?: number;
  minDistinctProjects?: number;
}

export interface PatternCandidate {
  candidateId: string;
  patternText: string;
  sources: string[];
  avgConfidence: number;
  evidenceCount: number;
}

export interface PatternMetaRow {
  patternId: string;
  generalizedFrom: string[];
  supportedBy: string[];
  validatedBy: string[];
  evidenceCount: number;
  avgConfidence: number;
  status: "candidate" | "validated" | "promoted";
  createdAt: string;
  promotedAt: string | null;
}

function readMeta(db: SqlDatabase, patternId: string): PatternMetaRow | null {
  const r = db
    .prepare("SELECT * FROM generalized_meta WHERE pattern_id = ?")
    .get(patternId) as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    patternId: String(r.pattern_id),
    generalizedFrom: parseStrArray(String(r.generalized_from)),
    supportedBy: parseStrArray(String(r.supported_by)),
    validatedBy: parseStrArray(String(r.validated_by)),
    evidenceCount: Number(r.evidence_count),
    avgConfidence: Number(r.avg_confidence),
    status: r.status as PatternMetaRow["status"],
    createdAt: String(r.created_at),
    promotedAt: r.promoted_at === null ? null : String(r.promoted_at),
  };
}

function parseStrArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/** 从验证过的 Experience 中找共享 pattern 候选簇。 */
export function discoverPatternCandidates(
  db: SqlDatabase,
  thresholds: PatternThresholds = {},
): PatternCandidate[] {
  const minEvidence = thresholds.minEvidencePerSource ?? 1;
  const minConf = thresholds.minConfidence ?? 0.75;
  const minProjects = thresholds.minDistinctProjects ?? 2;
  const sources = listAllMemoryItems(db).filter(
    (m) =>
      m.type === "experience" &&
      (m.experiencePhase === "verified" || m.experiencePhase === "validated") &&
      (m.confidence ?? 0) >= minConf &&
      m.userEdited !== 1,
  );
  // 取 content 高频词（前 5 个 token）作为 pattern nucleus 聚簇。
  const clusters = new Map<string, MemoryItemRow[]>();
  for (const m of sources) {
    const tokens = [...tokenizeText(m.content)].filter((t) => t.length > 2);
    if (tokens.length === 0) continue;
    const nucleus = tokens.slice(0, 5).join("|");
    const arr = clusters.get(nucleus) ?? [];
    arr.push(m);
    clusters.set(nucleus, arr);
  }
  const out: PatternCandidate[] = [];
  for (const group of clusters.values()) {
    if (group.length < (thresholds.minSources ?? 2)) continue;
    const projects = new Set(group.map((g) => g.projectId ?? ""));
    if (projects.size < minProjects) continue;
    const totalEvidence = group.reduce(
      (sum, g) => sum + evidenceCount(db, g.id),
      0,
    );
    if (totalEvidence < minEvidence) continue;
    const avgConf = group.reduce((sum, g) => sum + (g.confidence ?? 0), 0) / group.length;
    out.push({
      candidateId: `pat_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      patternText: buildPatternText(group),
      sources: group.map((g) => g.id),
      avgConfidence: Math.round(avgConf * 1000) / 1000,
      evidenceCount: totalEvidence,
    });
  }
  return out;
}

function evidenceCount(db: SqlDatabase, memoryId: string): number {
  const r = db
    .prepare("SELECT COUNT(*) AS c FROM feedback_events WHERE memory_id = ?")
    .get(memoryId) as { c: number };
  return Number(r.c);
}

function buildPatternText(group: MemoryItemRow[]): string {
  // 取各 source 的 problem/solution 交集概述（保守文本，不做推断）。
  const solutions = group
    .map((g) => g.summary ?? g.content.split("\n")[0] ?? "")
    .filter(Boolean);
  const unique = [...new Set(solutions)].slice(0, 3).join("；");
  return `[generalized pattern] 在 ${group.length} 条已验证经验中重复出现：${unique}`;
}

/** 登记一个 pattern 候选（阈值已过才允许调用；仍保持 candidate，不自动晋升）。 */
export function createPatternCandidate(
  db: SqlDatabase,
  candidate: PatternCandidate,
  actor = "system",
): string {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO generalized_meta
       (pattern_id, generalized_from, supported_by, validated_by,
        evidence_count, avg_confidence, status, created_at, promoted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, NULL)
     ON CONFLICT(pattern_id) DO NOTHING`,
  ).run(
    candidate.candidateId,
    JSON.stringify(candidate.sources),
    JSON.stringify(candidate.sources),
    "[]",
    candidate.evidenceCount,
    candidate.avgConfidence,
    now,
  );
  writeDomainAudit(db, actor, "generalize.candidate", candidate.candidateId, null, {
    candidate,
  });
  return candidate.candidateId;
}

/** 收到新的支持证据 / 显式 feedback 时调用：推进 candidate → validated。 */
export function validatePattern(
  db: SqlDatabase,
  patternId: string,
  opts: { actor?: string; validatedBy?: string } = {},
): PatternMetaRow | null {
  const meta = readMeta(db, patternId);
  if (meta === null || meta.status === "promoted") return meta;
  const validatedBy = opts.validatedBy
    ? [...new Set([...meta.validatedBy, opts.validatedBy])]
    : meta.validatedBy;
  const status = validatedBy.length >= 1 ? "validated" : "candidate";
  db.prepare(
    "UPDATE generalized_meta SET validated_by = ?, status = ?, promoted_at = ? WHERE pattern_id = ?",
  ).run(JSON.stringify(validatedBy), status, status === "validated" ? new Date().toISOString() : null, patternId);
  writeDomainAudit(db, opts.actor ?? "system", "generalize.validate", patternId, meta, {
    status,
  });
  return readMeta(db, patternId);
}

/** 晋升：validated + evidence 门槛 → 真正写入 Generalized Knowledge 记忆。 */
export function promotePattern(
  db: SqlDatabase,
  patternId: string,
  opts: { actor?: string } = {},
): MemoryItemRow | null {
  const meta = readMeta(db, patternId);
  if (meta === null) return null;
  if (meta.status !== "validated") {
    throw new Error(`cannot promote: pattern ${patternId} status=${meta.status} (need validated)`);
  }
  // 血缘保留在 meta 行（不删除）；Generalized Knowledge 记忆内容从来源经验事实重建。
  const sourceRows = meta.generalizedFrom
    .map((id) => getMemoryItemById(db, id))
    .filter((row): row is MemoryItemRow => row !== null);
  const facts = sourceRows
    .map((row) => firstLine(row.summary ?? row.content))
    .filter((line) => line.length > 0)
    .slice(0, 3);
  const content =
    facts.length > 0
      ? [
          `[Generalized Knowledge] confidence=${meta.avgConfidence.toFixed(2)} evidence=${meta.evidenceCount}`,
          ...facts.map((fact) => `- ${fact}`),
        ].join("\n")
      : `Generalized pattern confidence=${meta.avgConfidence.toFixed(2)} evidence=${meta.evidenceCount}`;
  const memory = insertMemoryItem(
    db,
    {
      type: "generalized",
      scope: "generalized",
      content,
      sourceKind: "inferred",
      confidence: meta.avgConfidence,
      temporalState: "current",
      importance: "normal",
    },
    opts.actor ?? "system",
  );
  db.prepare(
    `UPDATE generalized_meta SET status = 'promoted', generalized_from = ?, supported_by = ?, promoted_at = ?
      WHERE pattern_id = ?`,
  ).run(
    JSON.stringify(meta.generalizedFrom),
    JSON.stringify(meta.supportedBy),
    new Date().toISOString(),
    patternId,
  );
  // 血缘保留在 meta 行（不删除）；行级线索由事件/审计留痕。
  writeDomainAudit(db, opts.actor ?? "system", "generalize.promote", memory.id, meta, {
    memoryId: memory.id,
  });
  return getMemoryItemById(db, memory.id);
}

/** 运行一轮晋升：发现 → 登记 → 校验 → 晋升；返回每步数量。 */
export function runGeneralization(
  db: SqlDatabase,
  thresholds: PatternThresholds & { actor?: string } = {},
): {
  discovered: number;
  registered: number;
  promoted: number;
} {
  const actor = thresholds.actor ?? "system";
  const candidates = discoverPatternCandidates(db, thresholds);
  let registered = 0;
  let promoted = 0;
  for (const c of candidates) {
    createPatternCandidate(db, c, actor);
    registered++;
    const meta = readMeta(db, c.candidateId);
    if (meta !== null && meta.evidenceCount >= 2) {
      validatePattern(db, c.candidateId, { actor });
    }
  }
  // 达到 validated 门槛的既有候选尝试晋升。
  const rows = db
    .prepare("SELECT pattern_id FROM generalized_meta WHERE status = 'validated'")
    .all() as Array<{ pattern_id: string }>;
  for (const r of rows) {
    const promotedRow = promotePattern(db, String(r.pattern_id), { actor });
    if (promotedRow !== null) promoted++;
  }
  return { discovered: candidates.length, registered, promoted };
}
