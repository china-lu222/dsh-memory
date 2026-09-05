/**
 * Memory Center 检索 API（R7）：关键字检索入口（写读分离，检索只读）。
 * 默认不含预算遥测装饰；接线层可挂 retrievalCache 复用缓存命中。
 */

import { MEMORY_SCOPES } from "../schema/enums.js";
import type { MemoryScope } from "../schema/enums.js";
import type { MetadataFilter, RetrievalRequest } from "../retrieval/types.js";
import { retrieve, type RetrievedResult } from "../retrieval/pipeline.js";
import { attempt, enumOr, parseString, type Result } from "./common.js";
import type { ApiContext } from "./context.js";

export interface MemorySearchRequest {
  query: string;
  scope?: unknown;
  projectId?: string;
  includeHistorical?: boolean;
  limit?: number;
}

export function searchMemories(
  ctx: ApiContext,
  request: MemorySearchRequest,
): Result<RetrievedResult> {
  return attempt(() => {
    const query = parseString(request.query);
    if (query === undefined) throw new Error("query is required");

    const filter: MetadataFilter = {};
    if (request.scope !== undefined) {
      const scope = enumOr(MEMORY_SCOPES, request.scope);
      if (scope === undefined) throw new Error(`invalid scope: ${String(request.scope)}`);
      filter.scope = scope as MemoryScope;
    }
    const projectId = parseString(request.projectId);
    if (projectId !== undefined) filter.projectId = projectId;
    if (request.includeHistorical === true) filter.includeHistorical = true;

    const limit = Math.max(1, Math.min(50, Math.floor(request.limit ?? 10)));
    const retrievalRequest: RetrievalRequest = { query, filter, limit };
    return retrieve(ctx.db, retrievalRequest);
  });
}
