/**
 * Markdown Projection 基础原语（R2）：
 *  - 严格 YAML 子集 frontmatter 序列化/解析（零依赖，round-trip 稳定）
 *  - MemoryItemRow → Markdown 相对路径映射（entry-per-memory 布局）
 *
 * 布局采用“每条记忆一个 entry 文件”，保证每个文件带完整 frontmatter
 * 并能经 memory_id 唯一回定位（满足需求六）。归档记忆移动到 archive/。
 */

import { join, parse } from "node:path";
import type { MemoryItemRow } from "../store/repository.js";

/** 确定性小写安全文件 stem（URL-safe）。 */
export function safeStem(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "record"
  );
}

/**
 * 活跃记忆的 Markdown 相对路径（相对 markdown 根）。
 * - experience → experiences/<id>.md（entry）
 * - scope=project → projects/<project_id>/<id>.md
 * - negative → constraints/<id>.md
 * - generalized → knowledge/<id>.md
 * - personal(global) → profile/<id>.md
 */
export function pathFor(row: MemoryItemRow): string {
  if (row.type === "experience") return `experiences/${row.id}.md`;
  if (row.scope === "project") {
    return `projects/${safeStem(row.projectId ?? "default")}/${row.id}.md`;
  }
  if (row.type === "negative") return `constraints/${row.id}.md`;
  if (row.type === "generalized") return `knowledge/${row.id}.md`;
  return `profile/${row.id}.md`;
}

/** 归档记忆路径：archive/ 前缀 + 原相对路径。 */
export function archivedPathFor(row: MemoryItemRow): string {
  return join("archive", pathFor(row));
}

/** 活跃/归档记忆的当前文件路径。 */
export function livePathFor(row: MemoryItemRow): string {
  return row.temporalState === "historical"
    ? archivedPathFor(row)
    : pathFor(row);
}

/** 投影 frontmatter 字段（顺序即渲染顺序）。 */
export const FRONTMATTER_KEYS = [
  "memory_id",
  "type",
  "scope",
  "project_id",
  "importance",
  "confidence",
  "source_kind",
  "version",
  "lifecycle_status",
  "experience_phase",
  "temporal_state",
  "summary",
  "profile_category",
  "project_category",
  "utility",
  "hidden",
  "observed_at",
  "valid_from",
  "valid_until",
  "created_at",
  "updated_at",
] as const;

type Scalar = string | number | boolean;

/** 序列化单个字段为一行；null/undefined/空值返回空串。 */
function fieldLine(key: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return `${key}: ${value ? "true" : "false"}`;
  if (typeof value === "number") return `${key}: ${value}`;
  const text = String(value).replace(/\n/g, " ").trim();
  return text.length > 0 ? `${key}: ${text}` : "";
}

/** 元数据对象 → frontmatter 块（含 --- 围栏）。 */
export function toFrontmatter(meta: Record<string, unknown>): string {
  const lines = ["---"];
  for (const key of Object.keys(meta)) {
    const line = fieldLine(key, meta[key]);
    if (line !== "") lines.push(line);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * 解析 YAML 子集 frontmatter（首对 --- 围栏之间的文本）。
 * 畸形行跳过、不抛错；返回元数据对象与剩余 body。
 */
export function parseFrontmatter(text: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  if (!/^---\r?\n/.test(text)) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text };
  const head = text.slice(4, end).replace(/\r\n/g, "\n");
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, unknown> = {};
  for (const rawLine of head.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.trim();
    if (value === "") continue;
    meta[kv[1]!] = scalar(value);
  }
  return { meta, body };
}

/** 解析单个标量 token。 */
function scalar(raw: string): Scalar {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value.replace(/^["']|["']$/g, "");
}

/** 解析标量并过滤为 string/number/boolean。 */
export function scalarValue(
  value: unknown,
): string | number | boolean | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  return undefined;
}
