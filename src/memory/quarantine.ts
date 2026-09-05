/**
 * Memory Quarantine（R5，Q078/Q079 + Q089 guard 协作）。
 *  - 隔离 = hidden=1：默认不进入任何检索注入（guard 已拒绝 hidden）；
 *  - 入区：低置信推断产物 / 用户显式放入；
 *  - 出区：promote（解除隔离，置信下限 0.7）或 reject（作废归档，保留审计轨迹）。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import {
  getMemoryItemById,
  listAllMemoryItems,
  updateMemoryItem,
  writeDomainAudit,
} from "../store/repository.js";

export const PROMOTE_MIN_CONFIDENCE = 0.7;

/** 手动隔离一条记忆。 */
export function quarantineMemory(
  db: SqlDatabase,
  memoryId: string,
  reason: string,
  actor = "system",
): void {
  const row = getMemoryItemById(db, memoryId);
  if (row === null) throw new Error(`memory item not found: ${memoryId}`);
  if (row.hidden === 1) throw new Error(`memory is already quarantined: ${memoryId}`);
  updateMemoryItem(db, memoryId, { hidden: true }, actor);
  writeDomainAudit(db, actor, "memory.quarantine", memoryId, { reason }, row);
}

/**
 * 自动隔离低置信推断产物（ingest 后调用）。
 * @returns 本次隔离条数
 */
export function autoQuarantineLowConfidence(
  db: SqlDatabase,
  threshold = 0.6,
  actor = "system",
): number {
  const targets = listAllMemoryItems(db).filter(
    (row) =>
      row.hidden === 0 &&
      row.sourceKind === "inferred" &&
      row.confidence < threshold &&
      row.userEdited === 0,
  );
  for (const row of targets) {
    updateMemoryItem(db, row.id, { hidden: true }, actor);
    writeDomainAudit(db, actor, "memory.quarantine", row.id, {
      reason: `low confidence ${row.confidence} < ${threshold}`,
    }, row);
  }
  return targets.length;
}

/** 解除隔离（置信不足时提升到 0.7，表示人工认可）。 */
export function promoteMemory(
  db: SqlDatabase,
  memoryId: string,
  actor = "user",
): void {
  const row = getMemoryItemById(db, memoryId);
  if (row === null) throw new Error(`memory item not found: ${memoryId}`);
  if (row.hidden === 0) throw new Error(`memory is not quarantined: ${memoryId}`);
  updateMemoryItem(
    db,
    memoryId,
    {
      hidden: false,
      confidence: Math.max(row.confidence, PROMOTE_MIN_CONFIDENCE),
    },
    actor,
  );
  writeDomainAudit(db, actor, "memory.promote", memoryId, row, {
    reason: "user validated quarantined memory",
  });
}

/** 丢弃隔离记忆：作废并归档，保留完整审计与 version 轨迹（不物理删除）。 */
export function rejectMemory(
  db: SqlDatabase,
  memoryId: string,
  note: string,
  actor = "user",
): void {
  const row = getMemoryItemById(db, memoryId);
  if (row === null) throw new Error(`memory item not found: ${memoryId}`);
  if (row.hidden === 0) {
    throw new Error(`memory is not quarantined: ${memoryId}`);
  }
  updateMemoryItem(
    db,
    memoryId,
    { hidden: true, temporalState: "historical", utility: 0.05 },
    actor,
  );
  writeDomainAudit(db, actor, "memory.reject", memoryId, row, { note });
}

/** 列出隔离区记忆（含隔离原因见 audit_log）。 */
export function listQuarantinedMemories(db: SqlDatabase) {
  return listAllMemoryItems(db).filter((row) => row.hidden === 1);
}
