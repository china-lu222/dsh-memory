import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store/db.js";
import type { SqlDatabase } from "../src/store/sqlite.js";
import {
  archiveMemoryItem,
  getMemoryItemById,
  insertMemoryItem,
  listAllMemoryItems,
  updateMemoryItem,
} from "../src/store/repository.js";
import { classifyProfile, backfillProfileCategories } from "../src/memory/profile.js";
import {
  advanceExperiencePhase,
  createExperience,
  getExperience,
  getExperienceDetails,
  listExperiences,
  saveExperienceDetails,
} from "../src/memory/experience.js";
import {
  FEEDBACK_DELTAS,
  applyMemoryFeedback,
  listMemoryFeedback,
} from "../src/memory/feedback.js";
import {
  createConflictReview,
  detectMemoryConflicts,
  discardConflictReview,
  listConflictReviews,
  resolveConflictReview,
} from "../src/memory/conflict.js";
import {
  autoQuarantineLowConfidence,
  listQuarantinedMemories,
  promoteMemory,
  quarantineMemory,
  rejectMemory,
} from "../src/memory/quarantine.js";
import {
  classifyError,
  recommendExperiences,
} from "../src/memory/error-intel.js";
import { adoptMemoryFile } from "../src/projection/adopt.js";
import { renderMemoryFile } from "../src/projection/render.js";

let dir: string;
let db: SqlDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-mem-r5-"));
  db = openStore({ file: join(dir, "memory.db") }).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedPersonal(content: string, extra: Record<string, unknown> = {}) {
  return insertMemoryItem(
    db,
    {
      type: "personal",
      scope: "global",
      content,
      sourceKind: "explicit",
      ...extra,
    } as never,
    "user",
  );
}

function seedExperience(summary: string, problem = `${summary} problem`) {
  return createExperience(db, {
    summary,
    problem,
    solution: `solution to ${summary}`,
  });
}

function allOfType(type: string) {
  return listAllMemoryItems(db).filter((r) => r.type === type);
}

/* ---------------- Profile Builder（Q030/Q037/Q044） ---------------- */

describe("profile builder", () => {
  it("classifies personal statements deterministically", () => {
    expect(classifyProfile("user prefers vim")).toBe("preference");
    expect(classifyProfile("user mainly uses vim")).toBe("fact");
    expect(classifyProfile("i want to learn Rust")).toBe("goal");
    expect(classifyProfile("must not run npm install directly")).toBe("constraint");
    expect(classifyProfile("working style: prefer tdd")).toBe("working_style");
    expect(classifyProfile("anything unspecified")).toBe("fact");
  });

  it("backfills unclassified personal memories via the public update channel", () => {
    seedPersonal("user prefers dark mode", { profileCategory: null });
    seedPersonal("user mainly uses neovim", { profileCategory: null });
    seedPersonal("user wants to learn typescript", { profileCategory: "goal" });

    expect(backfillProfileCategories(db)).toBe(2);
    const personal = allOfType("personal");
    expect(personal).toHaveLength(3);
    expect(personal[0]!.profileCategory).toBe("preference");
    expect(personal[1]!.profileCategory).toBe("fact");
    expect(personal[2]!.profileCategory).toBe("goal");
  });
});

/* ---------------- Experience 生命周期（Q040-Q052/Q065） ---------------- */

describe("experience lifecycle", () => {
  it("creates candidate and advances along legal transitions", () => {
    const { id, phase } = seedExperience("migrate sqlite schema safely");
    expect(phase).toBe("candidate");
    const exp = getExperience(db, id)!;
    expect(exp.memory.type).toBe("experience");
    expect(exp.details.solution).toContain("solution to migrate");

    expect(advanceExperiencePhase(db, id)).toBe("investigating");
    expect(advanceExperiencePhase(db, id)).toBe("solution-found");
    expect(advanceExperiencePhase(db, id, "verified")).toBe("verified");
    expect(advanceExperiencePhase(db, id, "validated")).toBe("validated");
  });

  it("rejects illegal jumps and direct high-phase creation", () => {
    const { id } = seedExperience("fix memory leak in cache");
    expect(() => advanceExperiencePhase(db, id, "validated")).toThrow(
      /invalid phase transition/,
    );
    expect(() =>
      createExperience(db, {
        summary: "jump straight to verified",
        problem: "x",
        experiencePhase: "verified" as never,
      }),
    ).toThrow(/start at candidate or investigating/);
  });

  it("round-trips all detail fields through upsert", () => {
    const { id } = seedExperience("handle database connection pool exhaustion");
    const before = getExperienceDetails(db, id)!;
    const enriched: typeof before = {
      ...before,
      rootCause: "pool size too small",
      failedAttempts: [{ attempt: "raise timeout", outcome: "still fails" }],
      applicability: ["node", "postgres"],
      environment: "linux",
    };
    saveExperienceDetails(db, id, enriched, "user");
    const after = getExperienceDetails(db, id)!;
    expect(after.rootCause).toBe("pool size too small");
    expect(after.failedAttempts).toEqual([
      { attempt: "raise timeout", outcome: "still fails" },
    ]);
    expect(after.applicability).toEqual(["node", "postgres"]);
    expect(after.environment).toBe("linux");
  });

  it("locks user-edited experiences against system writes (Q047/Q050)", () => {
    const { id } = seedExperience("user reported workaround for auth");
    updateMemoryItem(db, id, { userEdited: true }, "user");
    expect(() => advanceExperiencePhase(db, id, undefined, "system")).toThrow(
      /user-edited/,
    );
    expect(advanceExperiencePhase(db, id, undefined, "user")).toBe("investigating");
  });

  it("lists with phase filtering", () => {
    const a = seedExperience("fix flaky ci test");
    const b = seedExperience("debug websocket reconnect loop");
    advanceExperiencePhase(db, b.id, "verified");
    expect(listExperiences(db)).toHaveLength(2);
    expect(listExperiences(db, { phase: "verified" })).toHaveLength(1);
    expect(listExperiences(db, { phase: "verified" })[0]!.memory.id).toBe(b.id);
    expect(listExperiences(db)[0]!.memory.id).toBe(a.id);
  });
});

/* ---------------- Feedback / Utility Learning（Q058/Q065/Q082） ---------------- */

describe("feedback and utility learning", () => {
  it("applies confirm/deny/not-helpful deltas within clamps", () => {
    const row = seedPersonal("user prefers split panes", {
      confidence: 0.5,
      utility: 0.5,
    });

    const confirm = applyMemoryFeedback(db, row.id, "confirm", { actor: "user" });
    expect(confirm.confidenceAfter).toBe(0.6);
    expect(confirm.utilityAfter).toBe(0.65);

    const deny = applyMemoryFeedback(db, row.id, "deny", { actor: "user" });
    expect(deny.confidenceAfter).toBeCloseTo(0.45);
    expect(deny.utilityAfter).toBeCloseTo(0.45);

    const unhelpful = applyMemoryFeedback(db, row.id, "not_helpful", {
      actor: "user",
    });
    expect(unhelpful.utilityAfter).toBeCloseTo(0.2);
  });

  it("records every feedback event with before/after values", () => {
    const row = seedPersonal("user mainly uses zsh");
    applyMemoryFeedback(db, row.id, "confirm", { note: "确实如此", actor: "user" });
    const events = listMemoryFeedback(db, row.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("confirm");
    expect(events[0]!.note).toBe("确实如此");
    expect(events[0]!.confidenceAfter).toBeGreaterThan(
      events[0]!.confidenceBefore,
    );
  });

  it("archives memories marked obsolete without mutating content", () => {
    const row = seedPersonal("user old tooling fact");
    const result = applyMemoryFeedback(db, row.id, "obsolete", { actor: "user" });
    const after = getMemoryItemById(db, row.id)!;
    expect(result.utilityAfter).toBe(0.1);
    expect(after.temporalState).toBe("historical");
    expect(after.content).toBe("user old tooling fact");
  });

  it("solved promotes an experience to verified exactly once", () => {
    const { id } = seedExperience("fix stale nginx cache");
    const result = applyMemoryFeedback(db, id, "solved", { actor: "user" });
    const row = getMemoryItemById(db, id)!;
    expect(row.experiencePhase).toBe("verified");
    // solved 增量只落一次（无叠加）。
    expect(result.confidenceAfter).toBeCloseTo(0.7 + FEEDBACK_DELTAS.solved.confidence);
    expect(result.utilityAfter).toBeCloseTo(0.5 + FEEDBACK_DELTAS.solved.utility);
  });

  it("refuses solved before a solution is recorded", () => {
    const created = createExperience(db, {
      summary: "random network flake",
      problem: "unexpected network drop",
    });
    expect(() =>
      applyMemoryFeedback(db, created.id, "solved", { actor: "user" }),
    ).toThrow(/no solution recorded/);
  });

  it("guards user-edited memories from system feedback", () => {
    const row = seedPersonal("user handwritten note");
    updateMemoryItem(db, row.id, { userEdited: true }, "user");
    expect(() =>
      applyMemoryFeedback(db, row.id, "confirm", { actor: "system" }),
    ).toThrow(/user-edited/);
    // 用户显式反馈仍允许。
    expect(() =>
      applyMemoryFeedback(db, row.id, "confirm", { actor: "user" }),
    ).not.toThrow();
  });
});

/* ---------------- Conflict Resolution（Q076/Q096/Q097） ---------------- */

describe("conflict detection and review queue", () => {
  it("detects duplicate personal memories as same_fact", () => {
    const a = seedPersonal("user prefers vim for all editing");
    const b = seedPersonal("user prefers vim for all editing");
    const candidates = detectMemoryConflicts(db, a.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.relation).toBe("same_fact");
    expect(candidates[0]!.otherId).toBe(b.id);
  });

  it("detects allow-vs-deny contradictions on shared actions", () => {
    const a = seedPersonal("always use npm for installing packages");
    const b = seedPersonal("never use npm for installing packages");
    const candidates = detectMemoryConflicts(db, a.id);
    const contradiction = candidates.find((c) => c.otherId === b.id);
    expect(contradiction?.relation).toBe("contradiction");
  });

  it("creates open reviews idempotently", () => {
    const a = seedPersonal("user prefers tabs over spaces");
    const b = seedPersonal("user prefers tabs over spaces");
    const first = createConflictReview(db, {
      memoryAId: a.id,
      memoryBId: b.id,
      relation: "same_fact",
      basis: "duplicate content",
      actor: "user",
    });
    const second = createConflictReview(db, {
      memoryAId: a.id,
      memoryBId: b.id,
      relation: "same_fact",
      basis: "duplicate content",
      actor: "user",
    });
    expect(second.id).toBe(first.id);
    expect(listConflictReviews(db, "open")).toHaveLength(1);
  });

  it("supersede resolution retires the victim and records lineage", () => {
    const a = seedPersonal("user prefers vim");
    const b = seedPersonal("user prefers emacs");
    const review = createConflictReview(db, {
      memoryAId: a.id,
      memoryBId: b.id,
      relation: "contradiction",
      basis: "allow vs deny",
      actor: "user",
    });
    resolveConflictReview(db, review.id, {
      resolution: "supersede",
      actor: "user",
      decisionNote: "vim wins",
    });
    expect(getMemoryItemById(db, b.id)!.temporalState).toBe("superseded");
    const lineage = db
      .prepare(
        `SELECT relation, other_memory_id AS other FROM memory_lineage
         WHERE memory_id = ?`,
      )
      .all(a.id) as Array<{ relation: string; other: string }>;
    expect(lineage).toEqual([{ relation: "supersedes", other: b.id }]);
    expect(listConflictReviews(db, "open")).toHaveLength(0);
  });

  it("merge resolution combines content and archives one side", () => {
    const a = seedPersonal("use vim for python");
    const b = seedPersonal("use vim for latex");
    const review = createConflictReview(db, {
      memoryAId: a.id,
      memoryBId: b.id,
      relation: "shared_pattern",
      basis: "high similarity",
      actor: "user",
    });
    resolveConflictReview(db, review.id, {
      resolution: "merge",
      actor: "user",
      mergedContent: "use vim for python and latex",
    });
    expect(getMemoryItemById(db, a.id)!.content).toBe("use vim for python and latex");
    expect(getMemoryItemById(db, b.id)!.temporalState).toBe("superseded");
  });

  it("discards reviews and rejects further resolution", () => {
    const a = seedPersonal("user prefers x");
    const b = seedPersonal("user prefers x");
    const review = createConflictReview(db, {
      memoryAId: a.id,
      memoryBId: b.id,
      relation: "same_fact",
      basis: "false positive",
      actor: "user",
    });
    discardConflictReview(db, review.id, "user");
    expect(listConflictReviews(db, "discarded")).toHaveLength(1);
    expect(() =>
      resolveConflictReview(db, review.id, {
        resolution: "keep_separate",
        actor: "user",
      }),
    ).toThrow(/not open/);
  });
});

/* ---------------- Memory Quarantine（Q078/Q079/Q089） ---------------- */

describe("memory quarantine", () => {
  it("auto-quarantines only low-confidence inferred memories", () => {
    const low = insertMemoryItem(
      db,
      {
        type: "personal",
        scope: "global",
        content: "user might like rust",
        sourceKind: "inferred",
        confidence: 0.4,
      },
      "system",
    );
    const high = insertMemoryItem(
      db,
      {
        type: "personal",
        scope: "global",
        content: "user clearly likes rust",
        sourceKind: "inferred",
        confidence: 0.8,
      },
      "system",
    );
    const explicit = insertMemoryItem(
      db,
      {
        type: "personal",
        scope: "global",
        content: "user explicit preference",
        sourceKind: "explicit",
        confidence: 0.4,
      },
      "user",
    );
    expect(autoQuarantineLowConfidence(db, 0.6)).toBe(1);
    expect(getMemoryItemById(db, low.id)!.hidden).toBe(1);
    expect(getMemoryItemById(db, high.id)!.hidden).toBe(0);
    expect(getMemoryItemById(db, explicit.id)!.hidden).toBe(0);
    expect(listQuarantinedMemories(db)).toHaveLength(1);
  });

  it("promote lifts confidence to the floor and clears the flag", () => {
    const low = insertMemoryItem(
      db,
      {
        type: "personal",
        scope: "global",
        content: "user might prefer go",
        sourceKind: "inferred",
        confidence: 0.4,
      },
      "system",
    );
    autoQuarantineLowConfidence(db, 0.6);
    promoteMemory(db, low.id, "user");
    const row = getMemoryItemById(db, low.id)!;
    expect(row.hidden).toBe(0);
    expect(row.confidence).toBe(0.7);
  });

  it("reject retires a quarantined memory with audit trail", () => {
    const row = seedPersonal("user one-off throwaway note");
    quarantineMemory(db, row.id, "低置信且无来源", "system");
    rejectMemory(db, row.id, "user认为无效", "user");
    const after = getMemoryItemById(db, row.id)!;
    expect(after.hidden).toBe(1);
    expect(after.temporalState).toBe("historical");
    expect(after.utility).toBe(0.05);
    expect(listQuarantinedMemories(db)).toHaveLength(1);
  });

  it("guards double-quarantine and promote of active memories", () => {
    const row = seedPersonal("user normal preference");
    expect(() => promoteMemory(db, row.id, "user")).toThrow(/not quarantined/);
    quarantineMemory(db, row.id, "暂时不放行", "user");
    expect(() =>
      quarantineMemory(db, row.id, "again", "system"),
    ).toThrow(/already quarantined/);
  });
});

/* ---------------- Error Intelligence（Q053-Q056/Q063） ---------------- */

describe("error intelligence", () => {
  it("classifies common error categories by rules", () => {
    expect(classifyError("Error: getaddrinfo ENOTFOUND api.example.com").category).toBe("network");
    expect(classifyError("bash: vite: command not found").category).toBe("shell");
    expect(classifyError("EACCES: permission denied, open /opt/x").category).toBe("permission");
    expect(classifyError("FATAL ERROR: Ineffective mark-compacts near heap limit").category).toBe("memory");
    expect(classifyError("everything works fine").category).toBe("other");
  });

  it("surfaces verified experience matches at the high-applicable tier", () => {
    const { id } = seedExperience(
      "sqlite no such table error fixed by running migrations",
    );
    advanceExperiencePhase(db, id, "verified");
    const advice = recommendExperiences(db, "sqlite error: no such table users", {
      projectId: undefined,
    });
    expect(advice.category).toBe("database");
    expect(advice.matches.length).toBeGreaterThan(0);
    const top = advice.matches[0]!;
    expect(top.id).toBe(id);
    expect(top.tier).toBe("verified-highly-applicable");
    expect(advice.diagnosisOrder.length).toBeGreaterThan(0);
  });

  it("downgrades candidate-phase matches and reports historical failures", () => {
    const { id } = seedExperience(
      "sqlite no such table error fixed by running migrations",
    );
    const candidateAdvice = recommendExperiences(
      db,
      "sqlite error: no such table users",
    );
    expect(candidateAdvice.matches[0]!.tier).toBe("possible-low-confidence");

    advanceExperiencePhase(db, id, "verified");
    archiveMemoryItem(db, id, "user");
    const historical = recommendExperiences(
      db,
      "sqlite error: no such table users",
    );
    expect(historical.matches[0]!.tier).toBe("historical-failure");
  });

  it("returns empty matches when nothing relevant is stored", () => {
    const advice = recommendExperiences(db, "k8s pod evicted due to disk pressure");
    expect(advice.terms.length).toBeGreaterThan(0);
    expect(advice.matches).toHaveLength(0);
  });
});

/* ---------------- R5 adopt round-trip（文件可编辑字段） ---------------- */

describe("adopt R5 editable frontmatter", () => {
  it("applies profile_category/summary/temporal edits and suppresses loops", () => {
    const row = seedPersonal("user prefers vim over emacs");
    expect(row.profileCategory).toBeNull();

    const rendered = renderMemoryFile(row);
    const edited = rendered.replace("---\n", "---\nprofile_category: preference\nsummary: vim fan\n");
    const result = adoptMemoryFile(db, "mem/personal.md", edited);
    expect(result.status).toBe("updated");
    const after = getMemoryItemById(db, row.id)!;
    expect(after.profileCategory).toBe("preference");
    expect(after.summary).toBe("vim fan");
    expect(after.userEdited).toBe(1);
    expect(after.sourceKind).toBe("user-edited");

    // 系统投影回环抑制：文件与 DB 投影一致时不视为用户改动。
    expect(adoptMemoryFile(db, "mem/personal.md", renderMemoryFile(after)).status).toBe(
      "skipped",
    );
  });

  it("rejects invalid enum values in edited frontmatter", () => {
    const row = seedPersonal("user prefers tabs");
    const edited = renderMemoryFile(row).replace(
      "---\n",
      "---\nprofile_category: bogus_category\n",
    );
    const result = adoptMemoryFile(db, "mem/personal.md", edited);
    expect(result.status).toBe("rejected");
    expect(String(result.reason)).toContain("profile_category");
  });
});

/* ---------------- cross-feature: solved experience shows up in intel ---------------- */

describe("cross-feature integration", () => {
  it("learns a solution via feedback then surfaces it as applicable", () => {
    const { id } = seedExperience("sqlite database locked error fixed by retrying writes");
    applyMemoryFeedback(db, id, "solved", { actor: "user" });
    const row = getMemoryItemById(db, id)!;
    expect(row.experiencePhase).toBe("verified");
    const advice = recommendExperiences(db, "sqlite database is locked error", {});
    expect(advice.matches.map((m) => m.id)).toContain(id);
  });
});
