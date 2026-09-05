// r7-benchmark: R7-4 benchmark 运行器行为验证。
// - 种子数据包裹在事务内并回滚：跑完不污染 memory_items；
// - 运行报告持久化到 benchmark_runs；
// - 默认场景全部 ok（keyword / cache-hit / context / token-budget / latency）。

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBenchmark } from "../src/benchmark/run.js";
import { openStore } from "../src/store/db.js";

const SCENARIOS = [
  "keyword-retrieval",
  "context-assembly",
  "token-budget",
  "cache-hit-rate",
  "latency",
  "hybrid-retrieval",
];

describe("R7-4 benchmark runner", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-bench-"));

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("在种子事务回滚后运行记录落库、production 行零残留", async () => {
    const file = path.join(dir, "memory.db");
    const report = await runBenchmark({ dbFile: file, iterations: 1, seedCount: 8 });

    expect(report.status).toBe("ok");
    expect(report.runId).toBeTruthy();
    const names = report.scenarios.map((s) => s.name);
    for (const name of SCENARIOS) expect(names).toContain(name);

    const db = openStore({ file }).db;
    try {
      const runs = db
        .prepare("SELECT COUNT(*) AS c FROM benchmark_runs")
        .get() as { c: number };
      expect(runs.c).toBe(1);
      const memories = db
        .prepare("SELECT COUNT(*) AS c FROM memory_items")
        .get() as { c: number };
      // 种子与 benchmark 缓存全部随事务回滚，用户记忆零污染。
      expect(memories.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keyword / context / token-budget 场景产出数值化指标", async () => {
    const file = path.join(dir, "memory-2.db");
    const report = await runBenchmark({ dbFile: file, iterations: 2, seedCount: 8 });
    const keyword = report.scenarios.find((s) => s.name === "keyword-retrieval");
    expect(keyword?.status).toBe("ok");
    expect(keyword?.keyword?.latency.samples).toBe(20);
    expect(keyword?.keyword?.zeroHitRounds).toBeGreaterThanOrEqual(0);

    const context = report.scenarios.find((s) => s.name === "context-assembly");
    expect(context?.status).toBe("ok");
    expect(context?.contextAssembly?.samples).toBe(20);

    const token = report.scenarios.find((s) => s.name === "token-budget");
    expect(token?.status).toBe("ok");
    expect(token?.tokenBudget?.budgetTokens).toBe(2000);
    expect(token?.tokenBudget?.overBudgetRate).toBeGreaterThanOrEqual(0);

    const cache = report.scenarios.find((s) => s.name === "cache-hit-rate");
    expect(cache?.status).toBe("ok");
    expect(cache?.cacheHit?.warmQueries).toBe(10);
  });
});
