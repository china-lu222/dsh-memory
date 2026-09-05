/**
 * Candidate Fusion（R4）：关键词（FTS5+filter，R3 打分）与向量命中的并集融合。
 *
 * 策略：
 *  - weighted：各源分∈[0,1]，按可用源加权（默认 keyword 0.5 / vector 0.5）；
 *  - rrf：对两个源的独立排序做 Reciprocal Rank Fusion（k=60，可配），
 *    仅对名次敏感、无跨源量纲问题。
 */

import type { RankedMemory } from "./types.js";

export type FusionStrategy = "weighted" | "rrf";

export type CandidateSource = "keyword" | "vector";

export interface FusedCandidate extends RankedMemory {
  keywordScore?: number;
  vectorScore?: number;
  sources: CandidateSource[];
}

export interface FusionConfig {
  strategy: FusionStrategy;
  /** weighted 模式下关键词权重 */
  keywordWeight?: number;
  /** weighted 模式下向量权重 */
  vectorWeight?: number;
  /** rrf 模式常量 k */
  rrfK?: number;
}

/** 判定候选所属来源与原始排序。 */
function normalizeSource(
  kw: readonly RankedMemory[],
  vec: readonly RankedMemory[],
): { kwSorted: RankedMemory[]; vecSorted: RankedMemory[] } {
  const kwSorted = [...kw].sort((a, b) => b.score - a.score);
  const vecSorted = [...vec].sort((a, b) => b.score - a.score);
  return { kwSorted, vecSorted };
}

/** 加权融合（默认 0.5/0.5；单源命中则退化为该源分）。 */
function fuseWeighted(
  kw: readonly RankedMemory[],
  vec: readonly RankedMemory[],
  cfg: Required<FusionConfig>,
): FusedCandidate[] {
  const kwMap = new Map(kw.map((c) => [c.row.id, c]));
  const vecMap = new Map(vec.map((c) => [c.row.id, c]));
  const ids = new Set<string>([...kwMap.keys(), ...vecMap.keys()]);
  const out: FusedCandidate[] = [];
  for (const id of ids) {
    const kc = kwMap.get(id);
    const vc = vecMap.get(id);
    const sources: CandidateSource[] = [];
    if (kc !== undefined) sources.push("keyword");
    if (vc !== undefined) sources.push("vector");
    let wSum = 0;
    let score = 0;
    if (kc !== undefined) {
      score += cfg.keywordWeight * kc.score;
      wSum += cfg.keywordWeight;
    }
    if (vc !== undefined) {
      score += cfg.vectorWeight * vc.score;
      wSum += cfg.vectorWeight;
    }
    const row = (kc ?? vc)!.row;
    out.push({
      row,
      score: wSum === 0 ? 0 : score / wSum,
      keywordScore: kc?.score,
      vectorScore: vc?.score,
      sources,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** RRF 融合（名次敏感，k 默认 60）。 */
function fuseRrf(
  kw: readonly RankedMemory[],
  vec: readonly RankedMemory[],
  cfg: Required<FusionConfig>,
): FusedCandidate[] {
  const { kwSorted, vecSorted } = normalizeSource(kw, vec);
  const acc = new Map<string, FusedCandidate>();
  const put = (rank: number, src: CandidateSource, c: RankedMemory): void => {
    const existing = acc.get(c.row.id);
    if (existing === undefined) {
      acc.set(c.row.id, {
        row: c.row,
        score: 1 / (cfg.rrfK + rank),
        keywordScore: src === "keyword" ? c.score : undefined,
        vectorScore: src === "vector" ? c.score : undefined,
        sources: [src],
      });
      return;
    }
    if (src === "keyword") existing.keywordScore = c.score;
    else existing.vectorScore = c.score;
    existing.sources.push(src);
    existing.score += 1 / (cfg.rrfK + rank);
  };
  kwSorted.forEach((c, i) => put(i + 1, "keyword", c));
  vecSorted.forEach((c, i) => put(i + 1, "vector", c));
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/**
 * 融合关键词与向量候选。
 * @returns 按融合分降序的唯一候选集（row 去重）
 */
export function fuse(
  kw: readonly RankedMemory[],
  vec: readonly RankedMemory[],
  strategy: FusionStrategy,
  config?: FusionConfig,
): FusedCandidate[] {
  const cfg: Required<FusionConfig> = {
    strategy,
    keywordWeight: config?.keywordWeight ?? 0.5,
    vectorWeight: config?.vectorWeight ?? 0.5,
    rrfK: config?.rrfK ?? 60,
  };
  return strategy === "rrf"
    ? fuseRrf(kw, vec, cfg)
    : fuseWeighted(kw, vec, cfg);
}
