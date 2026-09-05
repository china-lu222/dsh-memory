#!/usr/bin/env node
/**
 * dsh-memory CLI（TS R1：init / migrate / status / version）
 * 数据默认 <插件根>/data/memory.db（沿用旧 JS 插件的同文件升级路径）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestText } from "../ingest/pipeline.js";
import { resolveStoreFile } from "../paths.js";
import { MarkdownProjectionService } from "../projection/service.js";
import { retrieve } from "../retrieval/pipeline.js";
import type { MemoryScope } from "../schema/enums.js";
import { openStore, openStoreWithTakeover } from "../store/db.js";
import { r5Dispatch, R5_USAGE } from "./r5.js";
import {
  cmdBackup,
  cmdConsolidate,
  cmdEvents,
  cmdGeneralize,
  cmdHeal,
  cmdQueueDrain,
  cmdReplay,
  cmdRestore,
  cmdSnapshot,
  cmdValidate,
  cmdVerify,
  R6_USAGE,
} from "./r6.js";
import { cmdBenchmark, R7_USAGE } from "./benchmark.js";
import {
  isLegacyStore,
  LEGACY_BACKUP_SUFFIX,
  legacyRowCounts,
  legacySchemaVersionOf,
  tableNamesOf,
  type LegacyTakeoverReport,
} from "../store/legacy.js";

const USAGE = `dsh-memory <command> [--data-dir <dir>] [--db-file <name>]

Commands:
  init                    初始化/迁移（必要时安全接管旧库）
  migrate                 显式执行并打印“旧库同文件升级”报告
  ingest                  摄取文本并提取记忆（--text <文本> [--project-id <id>]）
  search                  关键词检索（--query <文本> [--scope] [--project] [--limit]）
  experience/profile/feedback/conflict/quarantine/error-intel   R5 域命令（见 help）
  events/queue/consolidate/generalize/heal/validate             R6 维护命令（见 help）
  benchmark               R7 基准评估（输出 JSON，写入 benchmark_runs）
  status                  显示存储状态、驱动与统计
  version                 打印版本
  help                    打印帮助

Options:
  --data-dir <dir>        数据目录（默认 DSH_MEMORY_DATA_DIR 或 <插件根>/data）
  --db-file <name>        DB 文件名（默认 memory.db）
  --text <text>           摄取文本（ingest 命令）
  --project-id <id>       项目上下文（ingest 命令，可选）
  --query <text>          检索查询（search 命令）
  --scope <scope>         作用域过滤（search 命令，可选）
  --project <id>          项目过滤（search 命令，可选）
  --limit <n>             结果上限（search 命令，默认 8）
`;

interface CliArgs {
  dataDir?: string;
  dbFile?: string;
  text?: string;
  projectId?: string;
  query?: string;
  scope?: string;
  project?: string;
  limit?: string;
}

function parseArgs(args: string[]): CliArgs {
  const out: CliArgs = {};
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
  };
  out.dataDir = take("--data-dir");
  out.dbFile = take("--db-file");
  out.text = take("--text");
  out.projectId = take("--project-id");
  out.query = take("--query");
  out.scope = take("--scope");
  out.project = take("--project");
  out.limit = take("--limit");
  return out;
}

function fail(msg: string): never {
  console.error(`dsh-memory: ${msg}`);
  process.exit(1);
}

function cmdVersion(): void {
  const pkg = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      "utf8",
    ),
  ) as { version: string };
  console.log(`dsh-memory ${pkg.version}`);
}

function printTakeover(t: LegacyTakeoverReport): void {
  if (!t.detected) {
    console.log(`legacy     : absent（纯 TS schema，无旧库接管）`);
    return;
  }
  console.log(`legacy     : present（旧 JS 插件表保留，供无损回滚）`);
  if (t.schemaVersion !== undefined) {
    console.log(`legacy meta: schema_version=${t.schemaVersion}`);
  }
  console.log(
    `integrity  : ${t.integrityOk ? "ok" : `FAILED: ${t.integrityMessage}`}`,
  );
  console.log(
    `backup     : ${t.backupPath}${t.backupCreated ? "（本轮创建）" : "（已存在，保留首份）"}`,
  );
  const counts = Object.entries(t.legacyRowCounts)
    .map(([tbl, n]) => `${tbl}=${n}`)
    .join(", ");
  console.log(`legacy rows: ${counts || "-"}`);
}

function cmdMigrate(args: string[]): void {
  const opts = parseArgs(args);
  const file = resolveStoreFile(opts);
  const { store, takeover } = openStoreWithTakeover({ file });
  try {
    console.log(`store file : ${file}`);
    printTakeover(takeover);
    const ver = store.db
      .prepare("SELECT MAX(version) AS v FROM schema_migrations")
      .get() as { v: number | null };
    const count = store.db
      .prepare("SELECT COUNT(*) AS c FROM memory_items")
      .get() as { c: number };
    console.log(`ts schema v: ${ver.v ?? 0}`);
    console.log(`memory rows: ${count.c}`);
    console.log(`driver     : ${store.driver}`);
    console.log(`migrate    : ok`);
  } finally {
    store.db.close();
  }
}

function cmdStatus(args: string[]): void {
  const opts = parseArgs(args);
  const file = resolveStoreFile(opts);
  const store = openStore({ file });
  try {
    const tables = tableNamesOf(store.db).sort();
    const count = store.db
      .prepare("SELECT COUNT(*) AS c FROM memory_items")
      .get() as { c: number };
    const ver = store.db
      .prepare("SELECT MAX(version) AS v FROM schema_migrations")
      .get() as { v: number | null };
    const legacy = isLegacyStore(store.db);
    console.log(`store file : ${file}`);
    console.log(`driver     : ${store.driver}`);
    console.log(`  note     : ${store.driverNote}`);
    console.log(`schema v   : ${ver.v ?? 0}`);
    console.log(`memory rows: ${count.c}`);
    console.log(`legacy     : ${legacy ? "present" : "absent"}`);
    if (legacy) {
      const sv = legacySchemaVersionOf(store.db);
      if (sv !== undefined) console.log(`legacy meta: schema_version=${sv}`);
      const rows = legacyRowCounts(store.db);
      console.log(
        `legacy rows: ${Object.entries(rows)
          .map(([t, n]) => `${t}=${n}`)
          .join(", ") || "-"}`,
      );
      const backup = `${file}${LEGACY_BACKUP_SUFFIX}`;
      console.log(
        `backup     : ${existsSync(backup) ? backup : "缺失（未接管过）"}`,
      );
    }
    console.log(`tables     : ${tables.join(", ")}`);
  } finally {
    store.db.close();
  }
}

function cmdInit(args: string[]): void {
  const opts = parseArgs(args);
  const file = resolveStoreFile(opts);
  const { store, takeover } = openStoreWithTakeover({ file });
  try {
    console.log(`initialized store at ${file}`);
    console.log(`driver: ${store.driver} — ${store.driverNote}`);
    if (takeover.detected) {
      printTakeover(takeover);
    }
  } finally {
    store.db.close();
  }
}

function cmdIngest(args: string[]): void {
  const opts = parseArgs(args);
  const text = opts.text;
  if (text === undefined || text.trim().length === 0) {
    fail("ingest 需要 --text <文本>");
  }
  const file = resolveStoreFile(opts);
  const { store } = openStoreWithTakeover({ file });
  try {
    const result = ingestText(store.db, text, { projectId: opts.projectId });
    console.log(`created : ${result.created}`);
    console.log(`skipped : ${result.skipped}`);
    if (result.memoryIds.length > 0) {
      console.log(`memory  : ${result.memoryIds.join(", ")}`);
      // CLI 环境无宿主订阅，显式重建投影（DB → MD）。
      const root = join(dirname(file), "memory");
      const projection = new MarkdownProjectionService(store.db, root);
      projection.resyncAll();
      console.log(`markdown: ${root}`);
    }
  } finally {
    store.db.close();
  }
}

function cmdSearch(args: string[]): void {
  const opts = parseArgs(args);
  const query = opts.query;
  if (query === undefined || query.trim().length === 0) {
    fail("search 需要 --query <文本>");
  }
  const file = resolveStoreFile(opts);
  const store = openStore({ file });
  try {
    const limitRaw = opts.limit !== undefined ? Number(opts.limit) : 8;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 8;
    const result = retrieve(store.db, {
      query,
      filter: {
        scope: opts.scope as MemoryScope | undefined,
        projectId: opts.project,
      },
      limit,
    });
    const t = result.telemetry;
    console.log(`query     : ${t.query}`);
    console.log(`gate      : ${t.gate.shouldRetrieve ? "pass" : `blocked (${t.gate.reason})`}`);
    console.log(`kind      : ${t.plan.kind}`);
    console.log(`terms     : ${t.queryTerms.join(" ") || "-"}`);
    console.log(`candidates: ${t.candidateCount}`);
    console.log(`selected  : ${t.selectedCount}`);
    console.log(`related   : ${t.relatedCount}`);
    console.log(`latency   : ${t.latencyMs}ms`);
    console.log(`tokens    : ${t.estimatedTokens}`);
    const c = result.context;
    const sections = [
      ["profile", c.profile],
      ["projectState", c.projectState],
      ["experience", c.experience],
      ["negative", c.negative],
      ["knowledge", c.knowledge],
      ["historical", c.historical],
    ] as const;
    for (const [name, items] of sections) {
      if (items.length === 0) continue;
      console.log(`\n[${name}]`);
      for (const m of items) {
        console.log(`  (${m.score.toFixed(3)}) ${m.row.content}`);
      }
    }
  } finally {
    store.db.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      cmdInit(rest);
      break;
    case "migrate":
      cmdMigrate(rest);
      break;
    case "ingest":
      cmdIngest(rest);
      break;
    case "search":
      cmdSearch(rest);
      break;
    case "status":
      cmdStatus(rest);
      break;
    case "version":
    case "--version":
    case "-v":
      cmdVersion();
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      console.log(R5_USAGE);
      console.log(R6_USAGE);
      console.log(R7_USAGE);
      break;
    case "events":
      cmdEvents(rest);
      break;
    case "queue":
      await cmdQueueDrain(rest);
      break;
    case "consolidate":
      cmdConsolidate(rest);
      break;
    case "generalize":
      cmdGeneralize(rest);
      break;
    case "heal":
      cmdHeal(rest);
      break;
    case "snapshot":
      cmdSnapshot(rest);
      break;
    case "backup":
      cmdBackup(rest);
      break;
    case "restore":
      cmdRestore(rest);
      break;
    case "replay":
      cmdReplay(rest);
      break;
    case "verify":
      cmdVerify(rest);
      break;
    case "validate":
      cmdValidate(rest);
      break;
    case "benchmark":
      await cmdBenchmark(rest);
      break;
    default:
      r5Dispatch(process.argv.slice(2));
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
