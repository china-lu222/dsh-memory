// R2：Ingest + Markdown Projection 双向同步测试。
// 覆盖：创建→MD、更新→MD、MD→DB、非法 frontmatter、version/audit、
// 幂等、重启一致性、多记忆隔离、Experience Q104 三层状态。

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestText } from "../src/ingest/pipeline.js";
import { pathFor } from "../src/projection/markdown.js";
import { MarkdownProjectionService } from "../src/projection/service.js";
import { openStore } from "../src/store/db.js";
import {
  archiveMemoryItem,
  getMemoryItemById,
  insertMemoryItem,
  listAllMemoryItems,
  restoreMemoryItem,
  updateMemoryItem,
} from "../src/store/repository.js";
import type { SqlDatabase } from "../src/store/sqlite.js";

describe("R2 ingest + markdown projection", () => {
  let dir: string;
  let file: string;
  let db: SqlDatabase;
  let root: string;
  let service: MarkdownProjectionService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dshm-r2-"));
    file = path.join(dir, "memory.db");
    db = openStore({ file }).db;
    root = path.join(dir, "memory");
    service = new MarkdownProjectionService(db, root);
    service.start();
  });

  afterEach(() => {
    service.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const absOf = (rowId: string): string => {
    const row = getMemoryItemById(db, rowId)!;
    return path.join(root, pathFor(row));
  };

  it("Test1: insert → auto-generates Markdown", () => {
    const row = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "I prefer TypeScript",
      sourceKind: "explicit",
    });
    const abs = absOf(row.id);
    expect(existsSync(abs)).toBe(true);
    const text = readFileSync(abs, "utf8");
    expect(text).toContain(`memory_id: ${row.id}`);
    expect(text).toContain("type: personal");
    expect(text).toContain("temporal_state: current");
    expect(text).toContain("I prefer TypeScript");
  });

  it("Test2: update → Markdown sync + version bump", () => {
    const row = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "old content",
      sourceKind: "explicit",
    });
    updateMemoryItem(db, row.id, { content: "new content" });
    const text = readFileSync(absOf(row.id), "utf8");
    expect(text).toContain("new content");
    expect(text).toContain("version: 2");
  });

  it("Test3: edit Markdown → reverse-updates DB (user edit protected)", () => {
    const row = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "I prefer TypeScript",
      sourceKind: "explicit",
    });
    const abs = absOf(row.id);
    const edited = readFileSync(abs, "utf8").replace(
      "I prefer TypeScript",
      "I prefer Rust",
    );
    writeFileSync(abs, edited, "utf8");
    const results = service.scanAndAdopt();
    expect(results.some((r) => r.status === "updated")).toBe(true);
    const updated = getMemoryItemById(db, row.id)!;
    expect(updated.content).toBe("I prefer Rust");
    expect(updated.sourceKind).toBe("user-edited");
    expect(updated.userEdited).toBe(1);
  });

  it("Test4: invalid frontmatter → rejected (DB unchanged)", () => {
    const row = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "content",
      sourceKind: "explicit",
    });
    const abs = absOf(row.id);
    const bad = readFileSync(abs, "utf8").replace(
      "temporal_state: current",
      "temporal_state: bogus",
    );
    writeFileSync(abs, bad, "utf8");
    const results = service.scanAndAdopt();
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    expect(getMemoryItemById(db, row.id)!.temporalState).toBe("current");
  });

  it("Test5: version + audit + event on update", () => {
    const row = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "v1",
      sourceKind: "explicit",
    });
    expect(row.version).toBe(1);
    updateMemoryItem(db, row.id, { content: "v2" });
    expect(getMemoryItemById(db, row.id)!.version).toBe(2);
    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity_id = ?")
      .get(row.id) as { c: number };
    expect(audit.c).toBe(2);
    const events = db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE payload_json LIKE ?")
      .get(`%${row.id}%`) as { c: number };
    expect(events.c).toBe(2);
  });

  it("Test6: duplicate ingest is idempotent (no duplicate memory)", () => {
    const r1 = ingestText(db, "I mainly use TypeScript");
    expect(r1.created).toBe(1);
    const r2 = ingestText(db, "I mainly use TypeScript");
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(listAllMemoryItems(db)).toHaveLength(1);
  });

  it("Test7: restart (dispose + resync) keeps projection consistent", () => {
    const row = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "persisted",
      sourceKind: "explicit",
    });
    service.dispose();
    const s2 = new MarkdownProjectionService(db, root);
    s2.start();
    try {
      const abs = absOf(row.id);
      expect(existsSync(abs)).toBe(true);
      expect(readFileSync(abs, "utf8")).toContain("persisted");
    } finally {
      s2.dispose();
    }
  });

  it("Test7b: restart adopts pending user edit (no loss)", () => {
    const row = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "before edit",
      sourceKind: "explicit",
    });
    const abs = absOf(row.id);
    writeFileSync(
      abs,
      readFileSync(abs, "utf8").replace("before edit", "after edit"),
      "utf8",
    );
    service.dispose();
    const s2 = new MarkdownProjectionService(db, root);
    s2.start();
    try {
      expect(getMemoryItemById(db, row.id)!.content).toBe("after edit");
      expect(getMemoryItemById(db, row.id)!.version).toBe(2);
    } finally {
      s2.dispose();
    }
  });

  it("Test8: multiple memories are isolated (no cross-overwrite)", () => {
    const a = insertMemoryItem(db, {
      type: "personal",
      scope: "global",
      content: "AAA",
      sourceKind: "explicit",
    });
    const b = insertMemoryItem(db, {
      type: "negative",
      scope: "global",
      content: "BBB",
      sourceKind: "explicit",
    });
    const c = insertMemoryItem(db, {
      type: "project_knowledge",
      scope: "project",
      projectId: "p1",
      content: "CCC",
      sourceKind: "explicit",
    });
    expect(pathFor(getMemoryItemById(db, a.id)!)).not.toBe(
      pathFor(getMemoryItemById(db, b.id)!),
    );
    updateMemoryItem(db, a.id, { content: "AAA2" });
    expect(getMemoryItemById(db, b.id)!.content).toBe("BBB");
    expect(getMemoryItemById(db, c.id)!.content).toBe("CCC");
    expect(existsSync(path.join(root, "constraints", `${b.id}.md`))).toBe(true);
    expect(existsSync(path.join(root, "projects", "p1", `${c.id}.md`))).toBe(
      true,
    );
  });

  it("Test9: experience preserves Q104 three orthogonal states; archive/restore migrate file", () => {
    const row = insertMemoryItem(db, {
      type: "experience",
      scope: "project",
      projectId: "p1",
      content: "fixed sqlite-vec native load",
      sourceKind: "explicit",
      experiencePhase: "solution-found",
      temporalState: "current",
    });
    const liveRel = pathFor(row);
    expect(liveRel).toBe(`experiences/${row.id}.md`);
    const text = readFileSync(path.join(root, liveRel), "utf8");
    expect(text).toContain("type: experience");
    expect(text).toContain("experience_phase: solution-found");
    expect(text).toContain("temporal_state: current");

    archiveMemoryItem(db, row.id);
    expect(existsSync(path.join(root, liveRel))).toBe(false);
    expect(existsSync(path.join(root, "archive", liveRel))).toBe(true);
    expect(getMemoryItemById(db, row.id)!.temporalState).toBe("historical");

    restoreMemoryItem(db, row.id);
    expect(existsSync(path.join(root, liveRel))).toBe(true);
    expect(getMemoryItemById(db, row.id)!.temporalState).toBe("current");
  });
});
