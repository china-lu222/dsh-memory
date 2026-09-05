/**
 * Ingest Pipeline 编排（R2 最小真实版）：
 *   User Input → extract (Extractor) → evaluate (Evaluator)
 *   → resolve 去重 (Resolver) → insertMemoryItem (Structured Store)
 *
 * 确定性 id 保证幂等：同一内容重复摄取得到同一 id，Resolver 再拦截重复创建。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import {
  insertMemoryItem,
  listAllMemoryItems,
  makeMemoryId,
} from "../store/repository.js";
import { extractCandidates } from "./rules.js";
import { evaluate } from "./evaluate.js";
import { resolve } from "./resolve.js";
import { classifyProfile } from "../memory/profile.js";

export interface IngestResult {
  created: number;
  skipped: number;
  memoryIds: string[];
}

/**
 * 摄取一段用户文本，产出记忆条目。
 * @param db store 连接
 * @param text 用户可见文本
 * @param opts.projectId 项目上下文（可选）
 */
export function ingestText(
  db: SqlDatabase,
  text: string,
  opts: { projectId?: string } = {},
): IngestResult {
  const candidates = extractCandidates(text);
  if (candidates.length === 0) {
    return { created: 0, skipped: 0, memoryIds: [] };
  }
  const evaluated = evaluate(candidates);
  const existing = new Set(listAllMemoryItems(db).map((r) => r.content));
  const resolved = resolve(evaluated, existing);

  const memoryIds: string[] = [];
  let created = 0;
  let skipped = 0;
  for (const r of resolved) {
    if (r.action === "skip") {
      skipped += 1;
      continue;
    }
    const c = r.candidate;
    const id = makeMemoryId(c.type, "global", c.content);
    insertMemoryItem(
      db,
      {
        id,
        type: c.type,
        scope: "global",
        content: c.content,
        // R5：summary 保留抽取短名（此前丢失）；personal 由 Profile Builder 落 profile_category。
        summary: c.summary ?? c.content,
        profileCategory:
          c.type === "personal" ? classifyProfile(c.content) : undefined,
        importance: c.importance,
        confidence: c.confidence,
        sourceKind: "explicit",
        projectId: opts.projectId,
      },
      "user",
    );
    memoryIds.push(id);
    created += 1;
  }
  return { created, skipped, memoryIds };
}
