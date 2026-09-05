/**
 * Markdown entry 文件 → 结构化（MD → DB 的解析侧）。
 * frontmatter 用 YAML 子集解析；body 是 content。
 */

import { parseFrontmatter, scalarValue } from "./markdown.js";

export interface ParsedMemoryFile {
  meta: Record<string, unknown>;
  content: string;
  memoryId: string | undefined;
  version: number | undefined;
}

/** 解析一个 entry 文件。content 为 body 去除首尾空白；空 body 记为 undefined。 */
export function parseMemoryFile(text: string): ParsedMemoryFile {
  const { meta, body } = parseFrontmatter(text);
  const memoryId = scalarValue(meta.memory_id);
  const versionRaw = scalarValue(meta.version);
  const content = body.trim();
  return {
    meta,
    content: content.length > 0 ? content : "",
    memoryId: typeof memoryId === "string" ? memoryId : undefined,
    version: typeof versionRaw === "number" ? versionRaw : undefined,
  };
}
