/**
 * Keyword Retrieval（R3）：SQLite FTS5（trigram）全文检索 + metadata filter +
 * bm25 评分归一化，再叠加 importance/confidence 加权。
 */

import type { Importance } from "../schema/enums.js";
import type { SqlDatabase } from "../store/sqlite.js";
import type { MemoryItemRow } from "../store/repository.js";
import type { MetadataFilter, RankedMemory } from "./types.js";

const IMPORTANCE_WEIGHT: Record<Importance, number> = {
  critical: 1.0,
  high: 0.85,
  normal: 0.6,
  low: 0.4,
  disposable: 0.2,
};

/** bm25（负值，越小越相关）→ (0,1] 归一化相关度。 */
function normalizeBm25(bm25: number): number {
  return 1 / (1 + Math.abs(bm25));
}

/** 综合评分：lexical 0.6 + importance 0.2 + confidence 0.2。 */
function combineScore(lexical: number, row: MemoryItemRow): number {
  const imp = IMPORTANCE_WEIGHT[row.importance] ?? 0.5;
  return lexical * 0.6 + imp * 0.2 + row.confidence * 0.2;
}

/**
 * FTS5 关键词检索 + metadata filter。
 * @returns 按综合得分降序的候选（不含 historical，除非显式 include）。
 */
export function searchKeyword(
  db: SqlDatabase,
  termGroups: readonly (readonly string[])[],
  filter: MetadataFilter | undefined,
  limit: number,
): RankedMemory[] {
  // 组内 OR（同义词）、组间 AND；trigram 最小 3 字符。
  const clauses: string[] = [];
  for (const group of termGroups) {
    const matchable = group
      .filter((t) => t.length >= 3)
      .map((t) => `"${t.replace(/"/g, '""')}"`);
    if (matchable.length === 0) continue;
    clauses.push(matchable.length === 1 ? matchable[0]! : `(${matchable.join(" OR ")})`);
  }
  if (clauses.length === 0) return [];

  const matchExpr = clauses.join(" AND ");

  const conditions = ["memory_items_fts MATCH ?"];
  const params: Array<string | number> = [matchExpr];
  // null/undefined 均视为“未指定”，避免 `m.scope = NULL` 一类永假条件。
  if (filter?.scope != null) {
    conditions.push("m.scope = ?");
    params.push(filter.scope);
  }
  if (filter?.projectId != null) {
    conditions.push("m.project_id = ?");
    params.push(filter.projectId);
  }
  if (filter?.type != null) {
    conditions.push("m.type = ?");
    params.push(filter.type);
  }
  if (filter?.temporalState != null) {
    conditions.push("m.temporal_state = ?");
    params.push(filter.temporalState);
  }
  if (filter?.experiencePhase != null) {
    conditions.push("m.experience_phase = ?");
    params.push(filter.experiencePhase);
  }
  if (filter?.importance != null) {
    conditions.push("m.importance = ?");
    params.push(filter.importance);
  }
  if (filter?.minConfidence != null) {
    conditions.push("m.confidence >= ?");
    params.push(filter.minConfidence);
  }
  if (filter?.includeHistorical !== true) {
    conditions.push("m.temporal_state != 'historical'");
  }

  const sql = `
    SELECT m.id, m.type, m.scope, m.project_id AS projectId, m.content,
           m.importance, m.confidence, m.source_kind AS sourceKind,
           m.experience_phase AS experiencePhase, m.temporal_state AS temporalState,
           m.lifecycle_status AS lifecycleStatus, m.user_edited AS userEdited, m.hidden,
           m.observed_at AS observedAt, m.valid_from AS validFrom, m.valid_until AS validUntil,
           m.last_verified_at AS lastVerifiedAt, m.last_used_at AS lastUsedAt, m.version,
           m.created_at AS createdAt, m.updated_at AS updatedAt,
           bm25(memory_items_fts) AS bm25
    FROM memory_items_fts
    JOIN memory_items m ON m.id = memory_items_fts.memory_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY bm25
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const out: RankedMemory[] = [];
  for (const r of rows) {
    const row = r as unknown as MemoryItemRow;
    const lexical = normalizeBm25(Number(r.bm25));
    out.push({ row, score: combineScore(lexical, row) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
