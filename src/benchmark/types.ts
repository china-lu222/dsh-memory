/**
 * R7-4 Benchmark Evaluation 的共享类型与对外契约。
 *
 * Benchmark 直接在打开的真实 Store 上运行，种子数据包裹在单个事务内并在
 * 结束时 ROLLBACK，绝不污染生产记忆数据；结果摘要写入 benchmark_runs 表。
 */

import type { MemoryScope, MemoryType } from "../schema/enums.js";

export type BenchmarkScenarioStatus = "ok" | "skipped" | "failed";

/** 基准数据集的行生成配置。 */
export interface BenchmarkConfig {
  /** 结果要写入的 Store 文件（缺省为命令行 data-dir 下的 memory.db）。 */
  dbFile?: string;
  /** 每类场景的重复轮数（同一批查询跑 N 遍）。 */
  iterations?: number;
  /** 种子数据条数（3 个项目 × 若干主题）。 */
  seedCount?: number;
  /** 是否执行 hybrid 向量检索场景（需外部提供向量检索钩子，缺省 false）。 */
  hybrid?: boolean;
}

/** 单条延迟样本统计。 */
export interface LatencyStats {
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface KeywordScenarioMetrics {
  latency: LatencyStats;
  /** 平均候选数（零结果为 0，计入均值）。 */
  avgCandidates: number;
  /** 平均选中数（guard + budget 之后）。 */
  avgSelected: number;
  /** 平均预估 token。 */
  avgTokens: number;
  /** 无候选的轮次数。 */
  zeroHitRounds: number;
}

export interface ContextAssemblyMetrics {
  samples: number;
  avgTotal: number;
  avgProfile: number;
  avgProjectState: number;
  avgExperience: number;
  avgNegative: number;
  avgKnowledge: number;
  avgHistorical: number;
  avgTokens: number;
}

export interface TokenBudgetMetrics {
  samples: number;
  /** selector 使用的上下文预算常量。 */
  budgetTokens: number;
  avgEstimateTokens: number;
  maxEstimateTokens: number;
  /** 估计值超过预算的轮次占比。 */
  overBudgetRate: number;
}

export interface CacheHitMetrics {
  warmQueries: number;
  hits: number;
  misses: number;
  hitRate: number;
  /** 命中轮平均耗时 vs 未命中轮平均耗时。 */
  warmAvgMs: number;
  coldAvgMs: number;
}

/** 单个场景结果。 */
export interface BenchmarkScenarioResult {
  name: string;
  status: BenchmarkScenarioStatus;
  /** skipped/failed 时的原因。 */
  reason?: string;
  samples?: number;
  keyword?: KeywordScenarioMetrics;
  contextAssembly?: ContextAssemblyMetrics;
  tokenBudget?: TokenBudgetMetrics;
  cacheHit?: CacheHitMetrics;
  latency?: LatencyStats;
}

/** 一次 benchmark 运行的整体报告（CLI JSON 输出、benchmark_runs.summary_json 内容）。 */
export interface BenchmarkReport {
  runId: string;
  kind: "benchmark";
  engine: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  dbFile: string;
  config: BenchmarkConfig;
  scenarios: BenchmarkScenarioResult[];
}

/** 持久化到 benchmark_runs 表的一行（config/results/summary 分列）。 */
export interface BenchmarkRunRecord {
  run_id: string;
  kind: string;
  config_json: string;
  results_json: string;
  summary_json: string;
  started_at: string;
  finished_at: string;
}

/** benchmark runner 的可注入能力（便于单元测试与混合检索扩展）。 */
export interface BenchmarkOptions {
  /** hybrid 场景使用的向量检索函数（q: 查询，limit: 上限）。 */
  hybridSearch?: (q: string, limit: number) => Promise<string[]>;
  /** 进度/错误输出；缺省静默。 */
  onLog?: (line: string) => void;
}

/** 基准数据集中的一条种子记忆。 */
export interface BenchmarkSeed {
  type: MemoryType;
  scope: MemoryScope;
  projectId?: string;
  content: string;
}
