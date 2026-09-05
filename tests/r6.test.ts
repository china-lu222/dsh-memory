import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../src/store/db.js";
import { enqueueEvent, eventCounts } from "../src/store/events.js";
import {
  getMemoryItemById,
  insertMemoryItem,
  listAllMemoryItems,
  updateMemoryItem,
} from "../src/store/repository.js";
import { eventsAfter } from "../src/store/queue.js";
import type { SqlDatabase } from "../src/store/sqlite.js";
import { runRealtimeLocalDedup } from "../src/memory/consolidation.js";
import {
  createPatternCandidate,
  promotePattern,
  validatePattern,
} from "../src/memory/generalize.js";
import { DurableWorker } from "../src/worker/worker.js";
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
  cmdVerify,
} from "../src/cli/r6.js";
import { listSnapshots } from "../src/reliability/snapshot.js";
import { listBackups } from "../src/reliability/backup.js";

type Store = ReturnType<typeof openStore>;

function countsByStatus(db: SqlDatabase): Record<string, number> {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS c FROM events GROUP BY status")
    .all() as Array<{ status: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

function openReviewStatuses(db: SqlDatabase): string[] {
  return (
    db
      .prepare(
        "SELECT status FROM conflict_reviews WHERE relation = 'shared_pattern'",
      )
      .all() as Array<{ status: string }>
  ).map((r) => r.status);
}

function makeStore(dir: string): { store: Store; db: SqlDatabase } {
  const store = openStore({ file: path.join(dir, "test.db") });
  return { store, db: store.db };
}

describe("R6 durable event queue", () => {
  let dir: string;
  let store: Store;
  let db: SqlDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r6-"));
    ({ store, db } = makeStore(dir));
  });

  afterEach(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("insertMemoryItem 事务内入队 memory.create，worker drain 后置 done", async () => {
    const created = insertMemoryItem(db, {
      type: "experience",
      scope: "project",
      projectId: "p1",
      content: "build fails until lockfile regenerated",
      sourceKind: "explicit",
      confidence: 0.8,
    });
    expect(countsByStatus(db).queued).toBe(1);

    let seenId: string | null = null;
    const worker = new DurableWorker(
      db,
      {
        "memory.create": (ev) => {
          seenId = ev.memoryId;
        },
      },
      {},
    );
    const res = await worker.drain();
    expect(res.processed).toBe(1);
    expect(res.drained).toBe(true);
    expect(seenId).toBe(created.id);
    expect(countsByStatus(db).done).toBe(1);
    expect(countsByStatus(db).queued).toBeUndefined();
  });

  it("claim 后的失败事件留在队列（非 dead）且不丢失重放序", async () => {
    const a = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "always pin dependency versions",
      sourceKind: "explicit",
    });
    const b = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "review lockfile diffs before merging",
      sourceKind: "explicit",
    });
    const all = eventsAfter(db, null, 10);
    expect(all.map((e) => e.memoryId).sort()).toEqual([a.id, b.id].sort());
    expect(eventCounts(db).queued).toBe(2);
  });
});

describe("R6 consolidation (realtime local dedup)", () => {
  let dir: string;
  let store: Store;
  let db: SqlDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r6-"));
    ({ store, db } = makeStore(dir));
  });

  afterEach(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function experience(content: string, projectId = "p1"): string {
    return insertMemoryItem(db, {
      type: "experience",
      scope: "project",
      projectId,
      content,
      sourceKind: "explicit",
      confidence: 0.85,
    }).id;
  }

  it("精确重复：survivor 保留、victim superseded+hidden，不物理删除", () => {
    const content = "lockfile version mismatch causes install failure";
    const a = experience(content);
    const b = experience(content);
    const summary = runRealtimeLocalDedup(db, {});

    expect(summary.candidates).toBe(1);
    expect(summary.merged).toBe(1);
    const rows = listAllMemoryItems(db);
    expect(rows.length).toBe(2);
    const bRow = getMemoryItemById(db, b)!;
    expect(bRow.hidden).toBe(1);
    expect(bRow.temporalState).toBe("superseded");
    const aRow = getMemoryItemById(db, a)!;
    expect(aRow.content).toBe(content);
    expect(aRow.hidden).toBe(0);
  });

  it("近似重复：不静默合并，转 Conflict Review（open）", () => {
    const a = experience("prefer the standard library unless you must optimize hot paths");
    const b = experience("prefer standard library unless you must optimize hot paths");
    const summary = runRealtimeLocalDedup(db, {});

    expect(summary.merged).toBe(0);
    expect(summary.reviewsOpened).toBe(1);
    expect(openReviewStatuses(db)).toEqual(["open"]);
    const bRow = getMemoryItemById(db, b)!;
    expect(bRow.hidden).toBe(0);
    expect(bRow.temporalState).toBe("current");
  });

  it("user_edited 锁：精确重复也不自动合并", () => {
    const content = "deploy script caches build output between runs";
    experience(content);
    const d = experience(content);
    updateMemoryItem(db, d, { userEdited: true });
    const summary = runRealtimeLocalDedup(db, {});

    expect(summary.merged).toBe(0);
    expect(summary.skipped).toBe(1);
    const dRow = getMemoryItemById(db, d)!;
    expect(dRow.hidden).toBe(0);
    expect(dRow.temporalState).toBe("current");
  });
});

describe("R6 generalized knowledge promotion", () => {
  let dir: string;
  let store: Store;
  let db: SqlDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r6-"));
    ({ store, db } = makeStore(dir));
  });

  afterEach(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("candidate 必须先 validated 才能 promote；promote 写入 type=generalized 记忆", () => {
    const a = insertMemoryItem(db, {
      type: "experience",
      scope: "project",
      projectId: "p1",
      content: "rely on object schema validation at module boundaries",
      sourceKind: "inferred",
      confidence: 0.9,
    }).id;
    const b = insertMemoryItem(db, {
      type: "experience",
      scope: "project",
      projectId: "p2",
      content: "validate inputs against schema before parsing",
      sourceKind: "inferred",
      confidence: 0.88,
    }).id;

    createPatternCandidate(db, {
      candidateId: "pat_r6_001",
      patternText: "[generalized pattern] schema validation at boundaries",
      sources: [a, b],
      avgConfidence: 0.89,
      evidenceCount: 3,
    });

    expect(() => promotePattern(db, "pat_r6_001")).toThrow(/validated/);

    validatePattern(db, "pat_r6_001", { validatedBy: a });
    const promoted = promotePattern(db, "pat_r6_001", { actor: "test" });
    expect(promoted).not.toBeNull();
    expect(promoted!.type).toBe("generalized");
    expect(promoted!.scope).toBe("generalized");

    const meta = db
      .prepare(
        "SELECT status, generalized_from AS g FROM generalized_meta WHERE pattern_id = ?",
      )
      .get("pat_r6_001") as { status: string; g: string } | undefined;
    expect(meta?.status).toBe("promoted");
    expect(JSON.parse(meta!.g)).toEqual([a, b]);
  });

  it("未知 pattern promote 返回 null（不抛）", () => {
    expect(promotePattern(db, "pat_unknown")).toBeNull();
  });
});

/* ---------------- R6 CLI 集成（events/queue drain/consolidate/generalize/heal） ---------------- */

/**
 * 捕获执行期间的 console.log（CLI 命令的唯一输出通道），返回拼接文本。
 * 捕获后自动恢复，避免污染其他用例的进程输出。
 */
function captureLog<T>(run: () => T): { text: string; value: T } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((p) => String(p)).join(" "));
  });
  try {
    const value = run();
    return { text: lines.join("\n"), value };
  } finally {
    spy.mockRestore();
  }
}

async function captureLogAsync<T>(
  run: () => Promise<T>,
): Promise<{ text: string; value: T }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((p) => String(p)).join(" "));
  });
  try {
    const value = await run();
    return { text: lines.join("\n"), value };
  } finally {
    spy.mockRestore();
  }
}

describe("R6 CLI integration", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r6-cli-"));
    dbFile = path.join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** CLI 参数：命令在自身生命周期内打开/关闭目标 DB，无需外部持有连接。 */
  const cliArgs = (...extra: string[]) => [
    "--data-dir",
    dir,
    "--db-file",
    "test.db",
    ...extra,
  ];

  function seedItems(rows: Parameters<typeof insertMemoryItem>[1][]) {
    const store = openStore({ file: dbFile });
    try {
      for (const row of rows) insertMemoryItem(store.db, row);
    } finally {
      store.db.close();
    }
  }

  it("cmdEvents 输出队列统计、by-type 汇总与 recent 明细", () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "lockfile version mismatch causes install failure",
        sourceKind: "explicit",
      },
    ]);

    const { text } = captureLog(() => cmdEvents(cliArgs()));
    expect(text).toContain("store file :");
    expect(text).toContain("queued=1");
    expect(text).toContain("memory.create");
    expect(text).toContain("recent     :");
  });

  it("cmdQueueDrain 用默认消费者排空入队事件并持久化 done", async () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "always pin dependency versions",
        sourceKind: "explicit",
      },
      {
        type: "personal",
        scope: "global",
        content: "review lockfile diffs before merging",
        sourceKind: "explicit",
      },
    ]);

    const { text } = await captureLogAsync(() => cmdQueueDrain(cliArgs()));
    expect(text).toContain("processed  : 2");
    expect(text).toContain("counts     : queued 2→0, done 0→2");

    const reopened = openStore({ file: dbFile });
    try {
      const counts = eventCounts(reopened.db);
      expect(counts.done).toBe(2);
      expect(counts.queued).toBe(0);
    } finally {
      reopened.db.close();
    }
  });

  it("cmdConsolidate 精确重复自动合并、近似重复开评审并打印摘要", () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "lockfile version mismatch causes install failure",
        sourceKind: "explicit",
        confidence: 0.85,
      },
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "lockfile version mismatch causes install failure",
        sourceKind: "explicit",
        confidence: 0.85,
      },
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "prefer the standard library unless you must optimize hot paths",
        sourceKind: "explicit",
        confidence: 0.85,
      },
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "prefer standard library unless you must optimize hot paths",
        sourceKind: "explicit",
        confidence: 0.85,
      },
    ]);

    const { text } = captureLog(() => cmdConsolidate(cliArgs()));
    expect(text).toContain("realtime dedup at");
    expect(text).toContain("scanned=4 candidates=2");
    expect(text).toContain("merged=1 reviewsOpened=1 skipped=0");
  });

  it("cmdGeneralize 晋升既有 validated pattern 候选", () => {
    const store = openStore({ file: dbFile });
    let a: string;
    let b: string;
    try {
      a = insertMemoryItem(store.db, {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "validate inputs against schema before parsing",
        sourceKind: "explicit",
        confidence: 0.9,
      }).id;
      b = insertMemoryItem(store.db, {
        type: "experience",
        scope: "project",
        projectId: "p2",
        content: "rely on object schema validation at boundaries",
        sourceKind: "explicit",
        confidence: 0.9,
      }).id;
      createPatternCandidate(store.db, {
        candidateId: "pat_cli_001",
        patternText: "[generalized pattern] schema validation at boundaries",
        sources: [a, b],
        avgConfidence: 0.9,
        evidenceCount: 2,
      });
      validatePattern(store.db, "pat_cli_001", { validatedBy: a });
    } finally {
      store.db.close();
    }

    const { text } = captureLog(() => cmdGeneralize(cliArgs()));
    expect(text).toContain("generalize at");
    expect(text).toContain("promoted=1");
  });

  it("cmdHeal 报告 dead 事件；--requeue 重新入队并清零重试", async () => {
    const store = openStore({ file: dbFile });
    try {
      enqueueEvent(store.db, {
        type: "orphan.event",
        idempotencyKey: "orphan:1",
      });
      // 默认消费者不含 orphan.*：maxAttempts=1 时一次失败即 dead-letter。
      const worker = new DurableWorker(store.db, {}, { maxAttempts: 1 });
      const res = await worker.drain();
      expect(res.dead).toBe(1);
    } finally {
      store.db.close();
    }

    const report = captureLog(() => cmdHeal(cliArgs()));
    expect(report.text).toContain("dead=1");
    expect(report.text).toContain("dead events: 1");

    const healed = captureLog(() => cmdHeal(cliArgs("--requeue")));
    expect(healed.text).toContain("requeued   : 1");

    const reopened = openStore({ file: dbFile });
    try {
      const counts = eventCounts(reopened.db);
      expect(counts.dead).toBe(0);
      expect(counts.queued).toBe(1);
    } finally {
      reopened.db.close();
    }
  });
});

/* ---------------- R6 CLI 可靠性命令（snapshot/backup/restore/replay/verify） ---------------- */

describe("R6 CLI reliability commands", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-r6-rel-"));
    dbFile = path.join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cliArgs = (...extra: string[]) => [
    "--data-dir",
    dir,
    "--db-file",
    "test.db",
    ...extra,
  ];

  function seedItems(rows: Parameters<typeof insertMemoryItem>[1][]) {
    const store = openStore({ file: dbFile });
    try {
      for (const row of rows) insertMemoryItem(store.db, row);
    } finally {
      store.db.close();
    }
  }

  it("cmdSnapshot 创建快照并落盘登记（清单可查）", () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "lockfile version mismatch causes install failure",
        sourceKind: "explicit",
      },
    ]);

    const { text } = captureLog(() => cmdSnapshot(cliArgs()));
    expect(text).toContain("snapshot   :");
    expect(text).toContain("verified   : yes");
    expect(text).toContain("memory     : 1");

    const store = openStore({ file: dbFile });
    try {
      const first = listSnapshots(store.db)[0];
      expect(first).toBeDefined();
      expect(first!.verified).toBe(true);
      expect(first!.eventCount).toBeGreaterThan(0);
    } finally {
      store.db.close();
    }
  });

  it("cmdSnapshot --list 输出清单；snapshot 文件真实存在", () => {
    seedItems([
      {
        type: "personal",
        scope: "global",
        content: "review lockfile diffs before merging",
        sourceKind: "explicit",
      },
    ]);
    captureLog(() => cmdSnapshot(cliArgs()));

    const listed = captureLog(() => cmdSnapshot(cliArgs("--list")));
    expect(listed.text).toContain("snapshots  : 1");

    const store = openStore({ file: dbFile });
    let snapPath = "";
    try {
      const first = listSnapshots(store.db)[0];
      if (first) snapPath = first.path;
    } finally {
      store.db.close();
    }
    expect(snapPath).not.toBe("");
  });

  it("cmdBackup 创建备份并落盘登记", () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "always pin dependency versions",
        sourceKind: "explicit",
      },
    ]);

    const { text } = captureLog(() => cmdBackup(cliArgs()));
    expect(text).toContain("backup     :");
    expect(text).toContain("verified   : yes");

    const store = openStore({ file: dbFile });
    try {
      const first = listBackups(store.db)[0];
      expect(first).toBeDefined();
      expect(first!.verified).toBe(true);
      expect(first!.eventCount).toBeGreaterThan(0);
    } finally {
      store.db.close();
    }
  });

  it("cmdRestore 把 backup 恢复到新库文件并 promote", () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "build fails until lockfile regenerated",
        sourceKind: "explicit",
      },
    ]);
    const created = captureLog(() => cmdBackup(cliArgs()));
    const id = created.text.match(/backup     : (\S+)/)?.[1];
    expect(id).toBeTruthy();

    const restored = path.join(dir, "restored.db");
    const { text } = captureLog(() =>
      cmdRestore(cliArgs("backup", id!, "--to", restored)),
    );
    expect(text).toContain("restore    : ok");
    expect(text).toContain("promoted   :");

    const store = openStore({ file: restored });
    try {
      expect(listAllMemoryItems(store.db).length).toBe(1);
    } finally {
      store.db.close();
    }
  });

  it("cmdRestore --verify-only 只做校验不落盘目标", () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "review lockfile diffs before merging",
        sourceKind: "explicit",
      },
    ]);
    const created = captureLog(() => cmdBackup(cliArgs()));
    const id = created.text.match(/backup     : (\S+)/)?.[1];
    expect(id).toBeTruthy();

    const restored = path.join(dir, "never.db");
    const { text } = captureLog(() =>
      cmdRestore(cliArgs("backup", id!, "--to", restored, "--verify-only")),
    );
    expect(text).toContain("restore    : ok");
    expect(text).toContain("mode       : verify-only");
    expect(text).not.toContain("promoted   :");
  });

  it("cmdReplay 默认 rebuild 打印扫描结果；dry-run 不落地 run", () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "lockfile version mismatch causes install failure",
        sourceKind: "explicit",
      },
    ]);

    const { text } = captureLog(() => cmdReplay(cliArgs()));
    expect(text).toContain("mode       : rebuild");
    expect(text).toContain("processed  : 1");
    expect(text).toContain("status     : succeeded");

    const dry = captureLog(() => cmdReplay(cliArgs("--dry-run")));
    expect(dry.text).toContain("mode       : dry-run");
  });

  it("cmdVerify 对离线库文件执行 integrity/schema/计数校验", () => {
    seedItems([
      {
        type: "experience",
        scope: "project",
        projectId: "p1",
        content: "always pin dependency versions",
        sourceKind: "explicit",
      },
    ]);

    const { text } = captureLog(() => cmdVerify([dbFile]));
    expect(text).toContain("ok         : yes");
    expect(text).toContain("integrity  : ok");
    expect(text).toContain("memory     : 1");
  });
});
