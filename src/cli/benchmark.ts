/**
 * `dsh-memory benchmark` R7 CLI：运行 benchmark 并输出 JSON 报告。
 *
 * 样例：
 *   dsh-memory benchmark --data-dir ./data --iterations 3
 *   dsh-memory benchmark --db-file memory.db --seeds 6
 */

import { resolveStoreFile } from "../paths.js";
import { runBenchmark } from "../benchmark/run.js";
import type { BenchmarkConfig } from "../benchmark/types.js";

export const R7_USAGE = `benchmark:
  运行 R7-4 Benchmark（keyword / latency / cache-hit / context / token-budget），
  种子数据在事务内写入并在结束后回滚，不污染现有记忆；
  摘要写入 <store> 的 benchmark_runs 表。stdout 输出 JSON 报告。
  --data-dir <dir>    数据目录（默认 DSH_MEMORY_DATA_DIR 或 <插件根>/data）
  --db-file <name>    DB 文件名（默认 memory.db）
  --iterations <n>    每场景重复轮数（默认 3）
  --seeds <n>         种子主题数上限（默认 8，最多 8）
  --hybrid            尝试 hybrid 场景（需要外部向量钩子；插件内缺省跳过）`;

function takeValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined;
}

function positiveInt(args: string[], flag: string, fallback: number): number {
  const raw = takeValue(args, flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function cmdBenchmark(args: string[]): Promise<number> {
  const config: BenchmarkConfig = {
    dbFile: resolveStoreFile({
      dataDir: takeValue(args, "--data-dir"),
      dbFile: takeValue(args, "--db-file"),
    }),
    iterations: positiveInt(args, "--iterations", 3),
    seedCount: Math.min(8, positiveInt(args, "--seeds", 8)),
    hybrid: args.includes("--hybrid"),
  };
  try {
    const report = await runBenchmark(config);
    console.log(JSON.stringify(report, null, 2));
    return report.status === "ok" ? 0 : 1;
  } catch (err) {
    console.error(
      JSON.stringify(
        { runId: null, kind: "benchmark", status: "failed", error: (err as Error).message },
        null,
        2,
      ),
    );
    return 1;
  }
}
