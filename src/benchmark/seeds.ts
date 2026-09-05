/**
 * R7-4 基准种子数据集：多项目、多主题的英文开发记忆样本。
 *
 * 数据在 benchmark 事务内写入并在结束时回滚，仅为 keyword/hybrid 检索链提供
 * 真实可命中内容，不进入用户的生产记忆。
 */

import type { BenchmarkSeed } from "./types.js";

/** 主题模板：每个主题包含 2 行「决策记忆」，供 query 命中。 */
const TOPIC_ROWS: Array<{ topic: string; rows: [string, string] }> = [
  {
    topic: "sync retry",
    rows: [
      "Data sync job applies exponential backoff retry with max 5 attempts and jitter.",
      "Sync conflicts after network partition are queued and reconciled by the sync worker.",
    ],
  },
  {
    topic: "token budget",
    rows: [
      "Context assembly keeps estimated tokens under the 2000 token budget by selecting top-ranked memories.",
      "Over-budget retrieval rounds fall back to stricter guard filtering before assembly.",
    ],
  },
  {
    topic: "cache key",
    rows: [
      "Retrieval cache key covers query, scope, project id and limit; fingerprint includes memory watermark.",
      "Cache invalidation clears stale payloads whenever a memory update bumps the watermark.",
    ],
  },
  {
    topic: "auth session",
    rows: [
      "API auth uses short-lived access tokens refreshed from a rotating refresh token store.",
      "Session revocation writes a tombstone row checked on every authenticated request.",
    ],
  },
  {
    topic: "deploy rollback",
    rows: [
      "Deployments tag releases and support instant rollback when the health check fails for two minutes.",
      "Canary deploy starts with five percent traffic and promotes after error budget stays green.",
    ],
  },
  {
    topic: "e2e timeout",
    rows: [
      "E2E suite raises the default step timeout to thirty seconds on slow CI runners.",
      "Flaky browser tests are retried once and reported separately from hard failures.",
    ],
  },
  {
    topic: "index query",
    rows: [
      "Memory keyword index uses FTS5 with prefix matching over the normalized content column.",
      "Hybrid ranking fuses keyword scores with vector similarity using reciprocal rank fusion.",
    ],
  },
  {
    topic: "quarantine policy",
    rows: [
      "Low confidence conflicting memories are quarantined instead of silently overwriting facts.",
      "Quarantined rows can be promoted back after a human review confirms the evidence.",
    ],
  },
];

/** 每轮用于检索链的查询样本（可命中多个主题）。 */
const QUERY_SAMPLES = [
  "What retry strategy does the sync job use when the network partition recovers?",
  "How does context assembly stay within the token budget for retrieval?",
  "Which parts of the request feed the retrieval cache key?",
  "How are auth sessions revoked after a refresh token rotates?",
  "When does the deploy pipeline trigger a rollback of a release?",
  "How long is the default step timeout for browser e2e tests on CI?",
  "How are keyword scores combined with vector similarity in hybrid ranking?",
  "What happens to conflicting low confidence memories before overwrite?",
  "Why do sync retries use exponential backoff with jitter?",
  "Does the cache fingerprint include the memory watermark?",
];

/** 生成确定性种子行（项目范围 × 主题副本）。 */
export function buildSeedDataset(projectCount = 3, rowsPerProject?: number): BenchmarkSeed[] {
  const cap = rowsPerProject ?? TOPIC_ROWS.length;
  const out: BenchmarkSeed[] = [];
  for (let p = 1; p <= projectCount; p++) {
    const projectId = `bench-project-${p}`;
    TOPIC_ROWS.slice(0, cap).forEach((topic, t) => {
      out.push(
        { type: "project_knowledge", scope: "project", projectId, content: topic.rows[0] },
        { type: "project_knowledge", scope: "project", projectId, content: topic.rows[1] },
      );
      void t;
    });
  }
  return out;
}

/** 返回可重复的查询样本。 */
export function getQuerySamples(): string[] {
  return [...QUERY_SAMPLES];
}
