/**
 * MD → DB 采纳（用户编辑回写）。
 *
 * 流程：parse → 定位 memory_id → 内容比较（抑制系统写回环）→
 * validate（枚举/范围校验）→ updateMemoryItem（actor=user）。
 *
 * 系统字段（memory_id/version/created_at/updated_at）不采纳用户修改：
 * version 由系统递增、时间戳由系统管理；只采纳 content 与可编辑业务字段。
 */

import {
  EXPERIENCE_PHASES,
  IMPORTANCES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  PROFILE_CATEGORIES,
  PROJECT_CATEGORIES,
  TEMPORAL_STATES,
  type ExperiencePhase,
  type Importance,
  type ProfileCategory,
  type ProjectCategory,
  type TemporalState,
} from "../schema/enums.js";
import type { SqlDatabase } from "../store/sqlite.js";
import {
  getMemoryItemById,
  updateMemoryItem,
} from "../store/repository.js";
import { scalarValue } from "./markdown.js";
import { parseMemoryFile } from "./parse.js";
import { renderMemoryFile } from "./render.js";

export interface AdoptResult {
  status: "updated" | "skipped" | "rejected";
  reason?: string;
  memoryId?: string;
}

/** 校验 frontmatter 并提取可采纳的业务字段。 */
function validateMeta(meta: Record<string, unknown>): {
  error?: string;
  importance?: Importance;
  confidence?: number;
  temporal?: TemporalState;
  phase?: ExperiencePhase;
  profileCategory?: ProfileCategory;
  projectCategory?: ProjectCategory;
  summary?: string;
} {
  const type = scalarValue(meta.type);
  if (type !== undefined && !(MEMORY_TYPES as readonly string[]).includes(String(type))) {
    return { error: `invalid type: ${String(type)}` };
  }
  const scope = scalarValue(meta.scope);
  if (scope !== undefined && !(MEMORY_SCOPES as readonly string[]).includes(String(scope))) {
    return { error: `invalid scope: ${String(scope)}` };
  }
  const temporal = scalarValue(meta.temporal_state);
  if (
    temporal !== undefined &&
    !(TEMPORAL_STATES as readonly string[]).includes(String(temporal))
  ) {
    return { error: `invalid temporal_state: ${String(temporal)}` };
  }
  const phase = scalarValue(meta.experience_phase);
  if (
    phase !== undefined &&
    !(EXPERIENCE_PHASES as readonly string[]).includes(String(phase))
  ) {
    return { error: `invalid experience_phase: ${String(phase)}` };
  }
  const importance = scalarValue(meta.importance);
  if (
    importance !== undefined &&
    !(IMPORTANCES as readonly string[]).includes(String(importance))
  ) {
    return { error: `invalid importance: ${String(importance)}` };
  }
  const confidence = scalarValue(meta.confidence);
  if (confidence !== undefined) {
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      return { error: `invalid confidence: ${String(confidence)}` };
    }
  }
  const summary = scalarValue(meta.summary);
  if (summary !== undefined && typeof summary !== "string") {
    return { error: `invalid summary: ${String(summary)}` };
  }
  const profileCategory = scalarValue(meta.profile_category);
  if (
    profileCategory !== undefined &&
    !(PROFILE_CATEGORIES as readonly string[]).includes(String(profileCategory))
  ) {
    return { error: `invalid profile_category: ${String(profileCategory)}` };
  }
  const projectCategory = scalarValue(meta.project_category);
  if (
    projectCategory !== undefined &&
    !(PROJECT_CATEGORIES as readonly string[]).includes(String(projectCategory))
  ) {
    return { error: `invalid project_category: ${String(projectCategory)}` };
  }
  return {
    importance:
      typeof importance === "string" ? (importance as Importance) : undefined,
    confidence: typeof confidence === "number" ? confidence : undefined,
    temporal:
      typeof temporal === "string" ? (temporal as TemporalState) : undefined,
    phase:
      typeof phase === "string" ? (phase as ExperiencePhase) : undefined,
    profileCategory:
      typeof profileCategory === "string"
        ? (profileCategory as ProfileCategory)
        : undefined,
    projectCategory:
      typeof projectCategory === "string"
        ? (projectCategory as ProjectCategory)
        : undefined,
    summary: typeof summary === "string" ? summary : undefined,
  };
}

/**
 * 采纳一个 Markdown entry 文件的变化。
 * @param rel 相对 markdown 根的路径（诊断用）
 * @param text 文件当前完整内容
 */
export function adoptMemoryFile(
  db: SqlDatabase,
  rel: string,
  text: string,
): AdoptResult {
  const parsed = parseMemoryFile(text);
  if (parsed.memoryId === undefined) {
    return { status: "rejected", reason: "missing memory_id in frontmatter" };
  }
  const row = getMemoryItemById(db, parsed.memoryId);
  if (row === null) {
    return { status: "rejected", reason: `unknown memory_id: ${parsed.memoryId}` };
  }
  // 系统投影回环抑制：内容与 DB 投影一致 → 无用户改动。
  if (text === renderMemoryFile(row)) {
    return { status: "skipped", reason: "unchanged (system projection)" };
  }
  const v = validateMeta(parsed.meta);
  if (v.error !== undefined) {
    return { status: "rejected", reason: v.error };
  }
  updateMemoryItem(
    db,
    row.id,
    {
      content: parsed.content,
      importance: v.importance ?? row.importance,
      confidence: v.confidence ?? row.confidence,
      // R5：文件内可直接编辑的业务字段一并采纳。
      summary: v.summary ?? row.summary,
      profileCategory: v.profileCategory ?? row.profileCategory,
      projectCategory: v.projectCategory ?? row.projectCategory,
      temporalState: v.temporal ?? row.temporalState,
      experiencePhase: v.phase ?? row.experiencePhase,
      sourceKind: "user-edited",
      userEdited: true,
    },
    "user",
  );
  return { status: "updated", memoryId: row.id };
}
