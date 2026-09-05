/**
 * R7-4 Benchmark Runner：
 *   - 打开真实 Store（自动应用 migration v8）；
 *   - 在单事务内写入种子数据 → 运行各场景 → ROLLBACK（不污染生产数据）；
 *   - 场景：keyword-retrieval、latency、cache-hit-rate、context-assembly、
 *     token-budget，hybrid-retrieval（需要外部向量钩子，缺省 skipped）。
 *   - 结果持久化到 benchmark_runs 并返回结构化 BenchmarkReport。
 */

import { randomUUID } from "node:crypto";
import { MemoryCache } from "../cache/memory-cache.js";
import { retrieve, type RetrievalRuntime } from "../retrieval/pipeline.js";
import type { MetadataFilter, RetrievalTelemetry } from "../retrieval/types.js";
import { openStore } from "../store/db.js";
import { insertMemoryItem } from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { insertBenchmarkRun } from "./record.js";
import { buildSeedDataset, getQuerySamples } from "./seeds.js";
import type {
  BenchmarkConfig,
  BenchmarkOptions,
  BenchmarkReport,
  BenchmarkScenarioResult,
  CacheHitMetrics,
  ContextAssemblyMetrics,
  KeywordScenarioMetrics,
  LatencyStats,
  TokenBudgetMetrics,
} from "./types.js";

/** selector 使用的上下文预算（pipeline 内常量，基准对照口径）。 */
const BUDGET_TOKENS = 2000;
const ROUND2 = (n: number) => Math.round(n * 100) / 100;

function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { samples: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx] ?? 0;
  };
  return {
    samples: samples.length,
    avgMs: ROUND2(samples.reduce((a, b) => a + b, 0) / samples.length),
    p50Ms: ROUND2(p(0.5)),
    p95Ms: ROUND2(p(0.95)),
    maxMs: ROUND2(sorted[sorted.length - 1] ?? 0),
  };
}

interface KeywordSample {
  telemetry: RetrievalTelemetry;
  contextLayers: Record<string, number>;
  totalContext: number;
}

/** 运行 keyword 检索链并收集样本。 */
function runKeywordSamples(
  db: SqlDatabase,
  queries: string[],
  rounds: number,
  runtime: RetrievalRuntime = {},
): KeywordSample[] {
  const filter: MetadataFilter = { scope: "project" };
  const samples: KeywordSample[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const query of queries) {
      const result = retrieve(db, { query, filter, limit: 10 }, runtime);
      const context = result.context;
      const layers = {
        profile: context.profile.length,
        projectState: context.projectState.length,
        experience: context.experience.length,
        negative: context.negative.length,
        knowledge: context.knowledge.length,
        historical: context.historical.length,
      };
      const totalContext = Object.values(layers).reduce((a, b) => a + b, 0);
      samples.push({ telemetry: result.telemetry, contextLayers: layers, totalContext });
    }
  }
  return samples;
}

function keywordMetrics(samples: KeywordSample[]): KeywordScenarioMetrics {
  const latencies = samples.map((s) => s.telemetry.latencyMs);
  const zeroHitRounds = samples.filter((s) => s.telemetry.candidateCount === 0).length;
  const avg = (key: "candidateCount" | "selectedCount" | "estimatedTokens") =>
    samples.length === 0
      ? 0
      : ROUND2(samples.reduce((a, s) => a + s.telemetry[key], 0) / samples.length);
  return {
    latency: latencyStats(latencies),
    avgCandidates: avg("candidateCount"),
    avgSelected: avg("selectedCount"),
    avgTokens: avg("estimatedTokens"),
    zeroHitRounds,
  };
}

function contextMetrics(samples: KeywordSample[]): ContextAssemblyMetrics {
  const sum = (key: keyof KeywordSample["contextLayers"]) =>
    samples.length === 0
      ? 0
      : samples.reduce((a, s) => a + (s.contextLayers[key] ?? 0), 0) / samples.length;
  return {
    samples: samples.length,
    avgTotal: ROUND2(samples.reduce((a, s) => a + s.totalContext, 0) / Math.max(1, samples.length)),
    avgProfile: ROUND2(sum("profile")),
    avgProjectState: ROUND2(sum("projectState")),
    avgExperience: ROUND2(sum("experience")),
    avgNegative: ROUND2(sum("negative")),
    avgKnowledge: ROUND2(sum("knowledge")),
    avgHistorical: ROUND2(sum("historical")),
    avgTokens: ROUND2(
      samples.reduce((a, s) => a + s.telemetry.estimatedTokens, 0) / Math.max(1, samples.length),
    ),
  };
}

function tokenBudgetMetrics(samples: KeywordSample[]): TokenBudgetMetrics {
  const estimates = samples.map((s) => s.telemetry.estimatedTokens);
  const overBudget = estimates.filter((t) => t > BUDGET_TOKENS).length;
  return {
    samples: samples.length,
    budgetTokens: BUDGET_TOKENS,
    avgEstimateTokens: ROUND2(
      estimates.reduce((a, b) => a + b, 0) / Math.max(1, estimates.length),
    ),
    maxEstimateTokens: ROUND2(Math.max(0, ...estimates)),
    overBudgetRate: ROUND2(overBudget / Math.max(1, estimates.length)),
  };
}

/** Cache Hit Rate：冷跑填充 → 热跑计数。 */
function cacheHitMetrics(
  db: SqlDatabase,
  queries: string[],
): { metrics: CacheHitMetrics; latency: LatencyStats } {
  const cache = new MemoryCache(db);
  const runtime: RetrievalRuntime = { cache };
  const filter: MetadataFilter = { scope: "project" };
  const cold: number[] = [];
  const warm: number[] = [];
  let hits = 0;
  for (const query of queries) {
    const start = Date.now();
    void retrieve(db, { query, filter, limit: 10 }, runtime);
    cold.push(Date.now() - start);
  }
  for (const query of queries) {
    const start = Date.now();
    const second = retrieve(db, { query, filter, limit: 10 }, runtime);
    warm.push(Date.now() - start);
    if (second.cacheHit) hits += 1;
  }
  const hitRate = queries.length === 0 ? 0 : hits / queries.length;
  const avgMs = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return {
    metrics: {
      warmQueries: queries.length,
      hits,
      misses: queries.length - hits,
      hitRate: ROUND2(hitRate),
      warmAvgMs: ROUND2(avgMs(warm)),
      coldAvgMs: ROUND2(avgMs(cold)),
    },
    latency: latencyStats(warm),
  };
}

async function hybridScenario(
  config: BenchmarkConfig,
  options: BenchmarkOptions,
  queries: string[],
): Promise<BenchmarkScenarioResult> {
  if (config.hybrid !== true || options.hybridSearch === undefined) {
    return {
      name: "hybrid-retrieval",
      status: "skipped",
      reason:
        "未提供外部向量检索钩子（vector provider 未配置）。实现就绪：配置 hybridSearch 钩子即可执行。",
    };
  }
  const samples: number[] = [];
  for (let round = 0; round < (config.iterations ?? 1); round++) {
    for (const query of queries) {
      const start = Date.now();
      await options.hybridSearch(query, 10);
      samples.push(Date.now() - start);
    }
  }
  return {
    name: "hybrid-retrieval",
    status: "ok",
    samples: samples.length,
    latency: latencyStats(samples),
  };
}

/** 执行完整 benchmark。config.dbFile 为结果库文件。 */
export async function runBenchmark(
  config: BenchmarkConfig,
  options: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const file = config.dbFile;
  if (!file) throw new Error("benchmark 需要 dbFile（store 文件）");
  const startedAt = new Date().toISOString();
  const iterations = config.iterations ?? 3;
  const queries = getQuerySamples();
  const scenarios: BenchmarkScenarioResult[] = [];

  const store = openStore({ file });
  const db = store.db;
  try {
    db.exec("BEGIN");
    try {
      const topicLimit = Math.min(TOPIC_ROWS_LEN, config.seedCount ?? TOPIC_ROWS_LEN);
      const seeds = buildSeedDataset(3, topicLimit);
      for (const seed of seeds) {
        insertMemoryItem(db, seed, "benchmark", { skipTransaction: true });
      }

      const keywordSamples = runKeywordSamples(db, queries, iterations);
      scenarios.push({
        name: "keyword-retrieval",
        status: "ok",
        samples: keywordSamples.length,
        keyword: keywordMetrics(keywordSamples),
      });

      scenarios.push({
        name: "context-assembly",
        status: "ok",
        samples: keywordSamples.length,
        contextAssembly: contextMetrics(keywordSamples),
      });

      scenarios.push({
        name: "token-budget",
        status: "ok",
        samples: keywordSamples.length,
        tokenBudget: tokenBudgetMetrics(keywordSamples),
      });

      const { metrics: cacheMetrics, latency: cacheLatency } = cacheHitMetrics(db, queries);
      scenarios.push({
        name: "cache-hit-rate",
        status: "ok",
        samples: queries.length,
        cacheHit: cacheMetrics,
        latency: cacheLatency,
      });

      scenarios.push({
        name: "latency",
        status: "ok",
        samples: keywordSamples.length,
        latency: keywordMetrics(keywordSamples).latency,
      });

      scenarios.push(await hybridScenario(config, options, queries));

      db.exec("ROLLBACK");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    const report: BenchmarkReport = {
      runId: randomUUID(),
      kind: "benchmark",
      engine: "dsh-memory-r7-benchmark",
      startedAt,
      finishedAt: new Date().toISOString(),
      status: scenarios.some((s) => s.status === "failed") ? "failed" : "ok",
      dbFile: file,
      config,
      scenarios,
    };
    insertBenchmarkRun(db, report);
    return report;
  } finally {
    store.db.close();
  }
}

/** TOPIC_ROWS.length 的公开引用（供 seedCount 默认裁剪）。 */
const TOPIC_ROWS_LEN = 8;
