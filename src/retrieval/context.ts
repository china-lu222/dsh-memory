/**
 * Context Assembly（R3）：把选中的记忆分层组装为结构化上下文。
 * 分层稳定（部分层可空）：profile / projectState / experience / negative /
 * knowledge / historical + trust 元数据。
 */

import type { RankedMemory, RetrievalContext } from "./types.js";

/** 分层组装上下文。 */
export function assemble(
  selected: RankedMemory[],
  totalCandidates: number,
  selectedCount: number,
): RetrievalContext {
  const context: RetrievalContext = {
    profile: [],
    projectState: [],
    experience: [],
    negative: [],
    knowledge: [],
    historical: [],
    trust: {
      totalCandidates,
      selected: selectedCount,
      generatedAt: new Date().toISOString(),
    },
  };
  for (const m of selected) {
    const row = m.row;
    if (row.temporalState === "historical") context.historical.push(m);
    else if (row.type === "experience") context.experience.push(m);
    else if (row.type === "negative") context.negative.push(m);
    else if (row.type === "generalized") context.knowledge.push(m);
    else if (row.scope === "project") context.projectState.push(m);
    else context.profile.push(m);
  }
  return context;
}
