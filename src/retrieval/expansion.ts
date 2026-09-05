/**
 * Related Memory Expansion（R3）：基于 memory_lineage 关系（related_to /
 * derived_from / supported_by / validated_by / supersedes / contradicts 等）
 * 扩展少量相关记忆。限制 depth/count，防止无限递归；无关系时返回空。
 */

import {
  getMemoryItemById,
} from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import type { RankedMemory } from "./types.js";

/**
 * 沿 lineage 关系扩展相关记忆。
 * @param depth 最大关系跳数
 * @param budget 最多扩展数量
 */
export function expandRelated(
  db: SqlDatabase,
  selected: RankedMemory[],
  depth: number,
  budget: number,
): RankedMemory[] {
  if (depth <= 0 || budget <= 0 || selected.length === 0) return [];
  const out: RankedMemory[] = [];
  const visited = new Set(selected.map((s) => s.row.id));
  let frontier = selected.map((s) => s.row.id);

  for (let d = 0; d < depth; d += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const rels = db
        .prepare(
          "SELECT other_memory_id AS oid FROM memory_lineage WHERE memory_id = ?",
        )
        .all(id) as Array<{ oid: string }>;
      for (const { oid } of rels) {
        if (visited.has(oid)) continue;
        visited.add(oid);
        const row = getMemoryItemById(db, oid);
        if (row === null || row.temporalState === "historical") continue;
        out.push({ row, score: 0.5 });
        next.push(oid);
        if (out.length >= budget) return out.slice(0, budget);
      }
    }
    frontier = next;
    if (out.length >= budget) break;
  }
  return out.slice(0, budget);
}
