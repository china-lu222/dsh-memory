// legacy-takeover: 验证“旧 JS 实现归档、新 TS 接管”的最小闭环。
// - 夹具按旧插件 schema（meta + memories + evidence + audit + session_runs）在临时目录造 memory.db，不引用 legacy-js/ 代码。
// - 断言：TS 打开既有旧库时同文件升级、不删除旧表/数据、一次性备份、可读写、可关闭重开。
// - apply() 用结构等价的假 Cordis Context 驱动；不改 DSH Core。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  inject,
  type CordisContext,
  type CordisLogger,
  type HttpResponseLike,
  type StoreStatus,
  type WebRoute,
} from "../src/cordis/apply.js";
import { openStore, openStoreWithTakeover } from "../src/store/db.js";
import { LEGACY_BACKUP_SUFFIX } from "../src/store/legacy.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { insertMemoryItem, listMemoryItems } from "../src/store/repository.js";
import { openSqlite } from "../src/store/sqlite.js";

import { MEMORY_PAGE_BASE } from "../src/webui/page.js";

const HEALTH_PATH = "/dsh-memory/api/health";
const CONFIG_PATH = "/dsh-memory/api/config";
const SEARCH_PATH = "/dsh-memory/api/search";
/** R7 WebUI 页面路由（接线层注册路径，顺序即注册顺序）。 */
const PAGE_ROUTES = [MEMORY_PAGE_BASE, `${MEMORY_PAGE_BASE}/app.js`];
/** R7 Memory Center admin 路由（接线层注册路径，顺序即注册顺序）。 */
const R7_ROUTE_PATHS = [
  "/dsh-memory/api/overview",
  "/dsh-memory/api/system",
  "/dsh-memory/api/system/validation",
  "/dsh-memory/api/system/consolidation",
  "/dsh-memory/api/system/cache/clear",
  "/dsh-memory/api/system/projection/rebuild",
  "/dsh-memory/api/memories",
  "/dsh-memory/api/memories/",
  "/dsh-memory/api/conflicts",
  "/dsh-memory/api/conflicts/",
  "/dsh-memory/api/quarantine",
  "/dsh-memory/api/quarantine/",
  "/dsh-memory/api/experiences",
  "/dsh-memory/api/experiences/",
];

/** 旧插件关键表的最小 DDL 夹具（TS 接管逻辑只识别表存在与否并统计行数）。 */
const LEGACY_DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE memories (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'derived', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  quote TEXT NOT NULL, observed_at INTEGER NOT NULL);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, action TEXT NOT NULL,
  actor TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE session_runs (
  session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

const LEGACY_MEMORIES = [
  { id: "mem-legacy-1", scope: "global", kind: "profile", content: "用户偏好 TypeScript", source: "user" },
  { id: "mem-legacy-2", scope: "project", kind: "experience", content: "sqlite-vec 需要原生扩展", source: "derived" },
];

function createLegacyStore(file: string): void {
  const opened = openSqlite(file);
  const db = opened.db;
  try {
    db.exec(LEGACY_DDL);
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '3')");
    const insert = db.prepare(
      "INSERT INTO memories (id, scope, kind, content, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    );
    for (const m of LEGACY_MEMORIES) insert.run(m.id, m.scope, m.kind, m.content, m.source, 1700000000000, 1700000000000);
    const evidence = db.prepare(
      "INSERT INTO evidence (id, memory_id, quote, observed_at) VALUES (?,?,?,?)",
    );
    evidence.run("ev-1", "mem-legacy-1", "用户偏好 TypeScript", 1700000000000);
  } finally {
    db.close();
  }
}
interface FakeCtx {
  ctx: CordisContext;
  log: { info: unknown[][]; warn: unknown[][]; error: unknown[][] };
  announced: { sections: number; disposed: number };
  routes: WebRoute[];
  dispose(): void;
}

function makeFakeCtx(): FakeCtx {
  const log = { info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  const announced = { sections: 0, disposed: 0 };
  const routes: WebRoute[] = [];
  const disposeListeners: Array<() => void> = [];
  const logger: CordisLogger = {
    info: (...args: unknown[]) => log.info.push(args),
    warn: (...args: unknown[]) => log.warn.push(args),
    error: (...args: unknown[]) => log.error.push(args),
  };
  const ctx: CordisContext = {
    logger,
    on: (event, listener) => {
      if (event === "dispose") disposeListeners.push(listener as () => void);
      return undefined;
    },
    inject: (_services, callback) => {
      callback({
        webServer: {
          register: (route) => {
            routes.push(route);
            return undefined;
          },
        },
      });
    },
    systemPrompt: {
      section: () => {
        announced.sections += 1;
        return () => {
          announced.disposed += 1;
        };
      },
    },
  };
  return {
    ctx,
    log,
    announced,
    routes,
    dispose: () => {
      for (const listener of disposeListeners) listener();
    },
  };
}

function containsArg(call: unknown[], needle: string): boolean {
  return call.some((arg) => String(arg).includes(needle));
}

interface HitResult {
  status: number;
  body: unknown;
}

function hit(fake: FakeCtx, routePath: string, method = "GET"): HitResult {
  const route = fake.routes.find((r) => r.path === routePath);
  expect(route).toBeDefined();
  let status = 0;
  let payload = "";
  const res: HttpResponseLike = {
    writeHead: (code) => {
      status = code;
    },
    end: (chunk) => {
      payload = chunk ?? payload;
    },
  };
  route!.handler({ method, url: routePath }, res);
  return { status, body: JSON.parse(payload) as unknown };
}

function bodyData<T>(result: HitResult): T {
  const body = result.body as { ok: boolean; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

describe("legacy takeover (TS R1)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-takeover-"));
    file = path.join(dir, "memory.db");
    createLegacyStore(file);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("接管既有旧库：同文件升级、数据保留、生成一次性备份、可最小读写", () => {
    const { store, takeover } = openStoreWithTakeover({ file });
    try {
      expect(takeover.detected).toBe(true);
      expect(takeover.schemaVersion).toBe(3);
      expect(takeover.legacyTables).toEqual(["memories", "evidence", "audit", "session_runs"]);
      expect(takeover.legacyRowCounts.memories).toBe(2);
      expect(takeover.legacyRowCounts.evidence).toBe(1);
      expect(takeover.backupPath).toBe(`${file}${LEGACY_BACKUP_SUFFIX}`);
      expect(takeover.backupCreated).toBe(true);

      const names = (
        store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((r) => r.name);
      for (const t of [
        "schema_migrations",
        "documents",
        "chunks",
        "memory_items",
        "memory_evidence",
        "memory_lineage",
        "audit_log",
        "events",
        "memories",
        "evidence",
        "audit",
        "session_runs",
      ]) {
        expect(names).toContain(t);
      }
      const ver = store.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
      expect(ver.v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);

      expect(listMemoryItems(store.db)).toHaveLength(0);
      insertMemoryItem(store.db, {
        type: "personal",
        scope: "global",
        content: "TS 接管后的第一条记忆",
        sourceKind: "explicit",
      });
      expect(listMemoryItems(store.db)).toHaveLength(1);
      // 写入 TS 条目后旧表行数仍不变（未清空/未替换）
      const legacy = store.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
      expect(legacy.c).toBe(2);
    } finally {
      store.db.close();
    }
  });

  it("关闭后可安全重开：数据持久、备份不重复创建", () => {
    const first = openStoreWithTakeover({ file });
    expect(first.takeover.backupCreated).toBe(true);
    insertMemoryItem(first.store.db, {
      type: "experience",
      scope: "project",
      content: "重开前写入的数据",
      sourceKind: "explicit",
    });
    first.store.db.close();

    const second = openStoreWithTakeover({ file });
    try {
      expect(second.takeover.detected).toBe(true);
      expect(second.takeover.backupCreated).toBe(false);
      expect(second.takeover.legacyRowCounts.memories).toBe(2);
      const items = listMemoryItems(second.store.db);
      expect(items).toHaveLength(1);
      expect(items[0]!.content).toBe("重开前写入的数据");
    } finally {
      second.store.db.close();
    }
  });
  it("插件入口可初始化：注册 announce 与最小路由，dispose 后安全关闭", () => {
    const fake = makeFakeCtx();
    apply(fake.ctx, { dataDir: dir, markdownEnabled: false });
    expect(fake.announced.sections).toBe(1);
    expect(fake.log.info.some((c) => containsArg(c, "store ready"))).toBe(true);
    expect(fake.routes.map((r) => r.path)).toEqual([HEALTH_PATH, CONFIG_PATH, SEARCH_PATH, ...R7_ROUTE_PATHS, ...PAGE_ROUTES]);

    const health = hit(fake, HEALTH_PATH);
    expect(health.status).toBe(200);
    const status = bodyData<StoreStatus>(health);
    expect(status.storePath).toBe(file);
    expect(status.schemaVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect(status.memoryCount).toBe(0);
    expect(status.driver.length).toBeGreaterThan(0);
    expect(status.legacy.detected).toBe(true);
    expect(status.legacy.rowCounts.memories).toBe(2);

    const cfg = hit(fake, CONFIG_PATH);
    expect(cfg.status).toBe(200);
    const config = bodyData<{ enabled: boolean; announceToAgent: boolean; storeOpen: boolean; storePath: string }>(cfg);
    expect(config).toMatchObject({ enabled: true, announceToAgent: true, storeOpen: true, storePath: file });

    expect(hit(fake, HEALTH_PATH, "POST").status).toBe(405);

    fake.dispose();
    expect(fake.announced.disposed).toBe(1);
    const reopened = openStore({ file });
    try {
      expect(listMemoryItems(reopened.db)).toHaveLength(0);
      const legacy = reopened.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
      expect(legacy.c).toBe(2);
    } finally {
      reopened.db.close();
    }
  });

  it("同一 Context 重复 apply 被守卫；dispose 后可重新初始化", () => {
    const fake = makeFakeCtx();
    apply(fake.ctx, { dataDir: dir, markdownEnabled: false });
    apply(fake.ctx, { dataDir: dir, markdownEnabled: false });
    expect(fake.log.warn.filter((c) => containsArg(c, "already active"))).toHaveLength(1);
    expect(fake.announced.sections).toBe(1);
    expect(fake.routes).toHaveLength(3 + R7_ROUTE_PATHS.length + PAGE_ROUTES.length);
    fake.dispose();
    apply(fake.ctx, { dataDir: dir, markdownEnabled: false });
    expect(fake.log.warn.filter((c) => containsArg(c, "already active"))).toHaveLength(1);
    expect(fake.announced.sections).toBe(2);
    fake.dispose();
  });

  it("enabled=false 时不初始化", () => {
    const fake = makeFakeCtx();
    apply(fake.ctx, { enabled: false, dataDir: dir });
    expect(fake.routes).toHaveLength(0);
    expect(fake.log.info).toHaveLength(0);
    expect(fake.announced.sections).toBe(0);
  });

  it("存储打开失败时记录 error 并抛出诊断", () => {
    writeFileSync(path.join(dir, "broken.db"), "not a sqlite database");
    const fake = makeFakeCtx();
    expect(() => apply(fake.ctx, { dataDir: dir, dbFile: "broken.db" })).toThrow(/store open\/migrate failed/);
    expect(fake.log.error.some((c) => containsArg(c, "broken.db"))).toBe(true);
  });
});

describe("归档独立性（R1）", () => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("入口导出约定与旧实现一致（named apply + inject）", () => {
    expect(typeof apply).toBe("function");
    expect(inject).toEqual(["systemPrompt"]);
  });

  it("被测源码不依赖 legacy-js / skills / DSH Core 运行时", () => {
    for (const rel of ["src/cordis/apply.ts", "src/store/db.ts", "src/paths.ts"]) {
      const imports = readFileSync(path.join(pluginRoot, rel), "utf8")
        .split("\n")
        .filter((line) => /^\s*import\s/.test(line))
        .join("\n");
      for (const forbidden of ["legacy-js", "skills/", "@deepseek-ai/"]) {
        expect(imports).not.toContain(forbidden);
      }
    }
  });
});

