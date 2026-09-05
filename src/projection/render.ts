/**
 * Structured Store 行 → Markdown entry 文件（DB → MD）。
 * frontmatter 携带完整可追踪元数据，body 为 content。
 */

import type { MemoryItemRow } from "../store/repository.js";
import { toFrontmatter } from "./markdown.js";

/** 单条记忆 → 完整 Markdown 文件文本。 */
export function renderMemoryFile(row: MemoryItemRow): string {
  const meta: Record<string, unknown> = {
    memory_id: row.id,
    type: row.type,
    scope: row.scope,
    project_id: row.projectId,
    importance: row.importance,
    confidence: row.confidence,
    source_kind: row.sourceKind,
    version: row.version,
    lifecycle_status: row.lifecycleStatus,
    experience_phase: row.experiencePhase,
    temporal_state: row.temporalState,
    // R5：新增可编辑业务字段也进入投影，文件内编辑可直接采纳。
    summary: row.summary,
    profile_category: row.profileCategory,
    project_category: row.projectCategory,
    utility: row.utility,
    hidden: row.hidden,
    observed_at: row.observedAt,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  return `${toFrontmatter(meta)}\n\n${row.content}\n`;
}
