/**
 * R5 域命令（CLI 接线层）：experience / profile / feedback / conflict /
 * quarantine / error-intel。入口 index.ts 通过 R5_USAGE 与各 cmd* 注册。
 */
import { readFileSync } from "node:fs";
import { resolveStoreFile } from "../paths.js";
import { FEEDBACK_KINDS } from "../schema/enums.js";
import { openStoreWithTakeover } from "../store/db.js";
import { listAllMemoryItems } from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import {
  createConflictReview,
  detectMemoryConflicts,
  discardConflictReview,
  listConflictReviews,
  resolveConflictReview,
} from "../memory/conflict.js";
import {
  applyMemoryFeedback,
  listMemoryFeedback,
} from "../memory/feedback.js";
import {
  autoQuarantineLowConfidence,
  listQuarantinedMemories,
  promoteMemory,
  quarantineMemory,
  rejectMemory,
} from "../memory/quarantine.js";
import {
  advanceExperiencePhase,
  createExperience,
  getExperience,
  listExperiences,
} from "../memory/experience.js";
import {
  backfillProfileCategories,
  classifyProfile,
} from "../memory/profile.js";
import { recommendExperiences } from "../memory/error-intel.js";

export const R5_USAGE = `R5 domain commands:
  experience create --summary <s> --problem <p> [--solution] [--project-id] [--scope]
  experience show <id>
  experience list [--phase <phase>]
  experience advance <id> [--phase <next>]
  profile list [--category <c> | --unclassified]
  profile classify --text <文本>
  profile backfill [--threshold <0-1>]
  feedback <memory-id> <kind>  (kind: ${FEEDBACK_KINDS.join("/")})
  feedback --list [--memory-id <id>]
  conflict detect <memory-id>
  conflict list [--status open|resolved|discarded]
  conflict discard <review-id>
  conflict resolve <review-id> --resolution merge|link|supersede|keep_separate
      [--victim <id>] [--merged <content>] [--note <note>]
  conflict lineage <memory-id>
  quarantine list | add <id> --reason <r> | promote <id> | reject <id> [--note] | auto [--threshold <0-1>]
  error-intel --text <err> | --file <path> [--project-id] [--limit <n>]
`;

function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.indexOf(flag) >= 0;
}

function fail(msg: string): never {
  console.error(`dsh-memory: ${msg}`);
  process.exit(1);
}

function listLike(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 打开 DB（含旧库接管/迁移），完成后关闭。 */
function withStore<T>(args: string[], fn: (db: SqlDatabase) => T): T {
  const opened = openStoreWithTakeover({
    file: resolveStoreFile({
      dataDir: getFlag(args, "--data-dir"),
      dbFile: getFlag(args, "--db-file"),
    }),
  });
  try {
    return fn(opened.store.db);
  } finally {
    opened.store.db.close();
  }
}

/* ---------------- experience ---------------- */

export function cmdExperience(args: string[]): void {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "create": {
      const summary = getFlag(rest, "--summary");
      const problem = getFlag(rest, "--problem");
      if (!summary || !problem) {
        fail("experience create 需要 --summary 与 --problem");
      }
      withStore(rest, (db) => {
        const { id, phase } = createExperience(db, {
          summary,
          problem,
          solution: getFlag(rest, "--solution"),
          projectId: getFlag(rest, "--project-id"),
          scope: getFlag(rest, "--scope") as
            | "session"
            | "project"
            | "global"
            | "generalized"
            | undefined,
        });
        console.log(`created : ${id}`);
        console.log(`phase   : ${phase}`);
      });
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) fail("experience show <id>");
      withStore(rest, (db) => {
        const exp = getExperience(db, id);
        if (exp === null) fail(`experience not found: ${id}`);
        console.log(`id         : ${exp.memory.id}`);
        console.log(`summary    : ${exp.memory.content}`);
        console.log(`phase      : ${exp.memory.experiencePhase ?? "-"}`);
        console.log(`scope      : ${exp.memory.scope}`);
        console.log(`project    : ${exp.memory.projectId ?? "-"}`);
        console.log(`confidence : ${exp.memory.confidence}`);
        console.log(`utility    : ${exp.memory.utility}`);
        console.log(`problem    : ${exp.details.problem}`);
        if (exp.details.rootCause) console.log(`root cause : ${exp.details.rootCause}`);
        if (exp.details.solution) console.log(`solution   : ${exp.details.solution}`);
        if (exp.details.verification) {
          console.log(`verification: ${exp.details.verification}`);
        }
        if (exp.details.lesson) console.log(`lesson     : ${exp.details.lesson}`);
        for (const fa of exp.details.failedAttempts) {
          console.log(`attempt    : ${fa.attempt} -> ${fa.outcome}`);
        }
        console.log(`applicability: ${exp.details.applicability.join(", ") || "-"}`);
        console.log(`technologies : ${exp.details.technologies.join(", ") || "-"}`);
      });
      return;
    }
    case "list": {
      withStore(rest, (db) => {
        const exps = listExperiences(db, {
          phase: getFlag(rest, "--phase") as never,
          projectId: getFlag(rest, "--project-id"),
        });
        for (const exp of exps) {
          console.log(
            `${exp.memory.id}  ${exp.memory.experiencePhase ?? "-"}  ${exp.memory.content}`,
          );
        }
        console.log(`(${exps.length} experiences)`);
      });
      return;
    }
    case "advance": {
      const id = rest[0];
      if (!id) fail("experience advance <id> [--phase <next>]");
      withStore(rest, (db) => {
        const next = advanceExperiencePhase(
          db,
          id,
          getFlag(rest, "--phase") as never,
        );
        console.log(`${id} -> ${next}`);
      });
      return;
    }
    default:
      fail(`unknown experience subcommand: ${sub ?? "-"}`);
  }
}

/* ---------------- profile ---------------- */

export function cmdProfile(args: string[]): void {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "classify": {
      const text = getFlag(rest, "--text");
      if (!text) fail("profile classify 需要 --text <文本>");
      console.log(classifyProfile(text));
      return;
    }
    case "list": {
      withStore(rest, (db) => {
        const want = getFlag(rest, "--category");
        const rows = listAllMemoryItems(db).filter(
          (row) =>
            row.type === "personal" &&
            row.hidden === 0 &&
            (want !== undefined
              ? row.profileCategory === want
              : true) &&
            (hasFlag(rest, "--unclassified")
              ? row.profileCategory === null
              : true),
        );
        for (const row of rows) {
          console.log(
            `${row.profileCategory ?? "unclassified".padEnd(8)}  ${row.id}  ${row.content}`,
          );
        }
        console.log(`(${rows.length} profile memories)`);
      });
      return;
    }
    case "backfill": {
      withStore(rest, (db) => {
        const changed = backfillProfileCategories(db);
        const quarantined = autoQuarantineLowConfidence(
          db,
          Number(getFlag(rest, "--threshold") ?? 0.6),
        );
        console.log(`classified: ${changed} memories`);
        console.log(`quarantined low-confidence inferred: ${quarantined}`);
      });
      return;
    }
    default:
      fail(`unknown profile subcommand: ${sub ?? "-"}`);
  }
}

/* ---------------- feedback ---------------- */

export function cmdFeedback(args: string[]): void {
  if (args[0] === "list" || args[0] === "--list" || args[0] === undefined) {
    withStore(args, (db) => {
      const rows = listMemoryFeedback(db, getFlag(args, "--memory-id"));
      for (const f of rows) {
        console.log(
          `${f.id}  ${f.memoryId}  ${f.kind}  conf ${f.confidenceBefore}->${f.confidenceAfter}  util ${f.utilityBefore}->${f.utilityAfter}`,
        );
      }
      console.log(`(${rows.length} feedback events)`);
    });
    return;
  }
  const [memoryId, kind] = args;
  if (!memoryId || !kind) {
    fail(`usage: feedback <memory-id> <kind>; kind in ${FEEDBACK_KINDS.join("/")}`);
  }
  if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    fail(`kind must be one of: ${FEEDBACK_KINDS.join("/")}`);
  }
  withStore(args.slice(2), (db) => {
    const r = applyMemoryFeedback(db, memoryId, kind as never, {
      note: getFlag(args.slice(2), "--note"),
      actor: getFlag(args.slice(2), "--actor") ?? "user",
    });
    console.log(`memory   : ${memoryId}`);
    console.log(`kind     : ${kind}`);
    console.log(`confidence: ${r.confidenceBefore} -> ${r.confidenceAfter}`);
    console.log(`utility  : ${r.utilityBefore} -> ${r.utilityAfter}`);
  });
}

/* ---------------- conflict ---------------- */

export function cmdConflict(args: string[]): void {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "detect": {
      const id = rest[0];
      if (!id) fail("conflict detect <memory-id>");
      withStore(rest, (db) => {
        const cands = detectMemoryConflicts(db, id);
        if (cands.length === 0) {
          console.log("no conflict candidates");
          return;
        }
        for (const c of cands) {
          const review = createConflictReview(db, {
            memoryAId: id,
            memoryBId: c.otherId,
            relation: c.relation,
            basis: c.basis,
            actor: "user",
          });
          console.log(
            `${review.id}  ${c.relation}  ${c.basis}  vs ${c.otherId}  [${review.status}]`,
          );
        }
      });
      return;
    }
    case "list": {
      withStore(rest, (db) => {
        const rows = listConflictReviews(
          db,
          getFlag(rest, "--status") as never,
        );
        for (const r of rows) {
          console.log(
            `${r.id}  ${r.status}  ${r.relation}  ${r.memoryAId} <-> ${r.memoryBId}  ${r.resolution ?? "-"}`,
          );
        }
        console.log(`(${rows.length} reviews)`);
      });
      return;
    }
    case "discard": {
      const id = rest[0];
      if (!id) fail("conflict discard <review-id>");
      withStore(rest, (db) => {
        discardConflictReview(db, id, "user");
        console.log(`discarded: ${id}`);
      });
      return;
    }
    case "resolve": {
      const id = rest[0];
      const resolution = getFlag(rest, "--resolution");
      if (!id || !resolution) {
        fail("conflict resolve <review-id> --resolution <r>");
      }
      withStore(rest, (db) => {
        resolveConflictReview(db, id, {
          resolution: resolution as never,
          actor: "user",
          victimId: getFlag(rest, "--victim"),
          mergedContent: getFlag(rest, "--merged"),
          decisionNote: getFlag(rest, "--note"),
        });
        console.log(`resolved : ${id} (${resolution})`);
      });
      return;
    }
    case "lineage": {
      const id = rest[0];
      if (!id) fail("conflict lineage <memory-id>");
      withStore(rest, (db) => {
        const rows = db
          .prepare(
            `SELECT relation, other_memory_id AS other, note
             FROM memory_lineage WHERE memory_id = ? ORDER BY created_at`,
          )
          .all(id) as Array<{ relation: string; other: string; note: string | null }>;
        for (const r of rows) {
          console.log(`${r.relation}  ->  ${r.other}${r.note ? `  (${r.note})` : ""}`);
        }
        if (rows.length === 0) console.log("no lineage records");
      });
      return;
    }
    default:
      fail(`unknown conflict subcommand: ${sub ?? "-"}`);
  }
}

/* ---------------- quarantine ---------------- */

export function cmdQuarantine(args: string[]): void {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list": {
      withStore(rest, (db) => {
        const rows = listQuarantinedMemories(db);
        for (const row of rows) {
          console.log(
            `${row.id}  ${row.sourceKind}  conf=${row.confidence}  ${row.content}`,
          );
        }
        console.log(`(${rows.length} quarantined)`);
      });
      return;
    }
    case "add": {
      const id = rest[0];
      const reason = getFlag(rest, "--reason");
      if (!id || !reason) fail("quarantine add <id> --reason <r>");
      withStore(rest, (db) => {
        quarantineMemory(db, id, reason, "user");
        console.log(`quarantined: ${id}`);
      });
      return;
    }
    case "promote": {
      const id = rest[0];
      if (!id) fail("quarantine promote <id>");
      withStore(rest, (db) => {
        promoteMemory(db, id);
        console.log(`promoted  : ${id}`);
      });
      return;
    }
    case "reject": {
      const id = rest[0];
      if (!id) fail("quarantine reject <id> [--note]");
      withStore(rest, (db) => {
        rejectMemory(db, id, getFlag(rest, "--note") ?? "rejected by user");
        console.log(`rejected  : ${id}`);
      });
      return;
    }
    case "auto": {
      withStore(rest, (db) => {
        const n = autoQuarantineLowConfidence(
          db,
          Number(getFlag(rest, "--threshold") ?? 0.6),
        );
        console.log(`auto-quarantined: ${n}`);
      });
      return;
    }
    default:
      fail(`unknown quarantine subcommand: ${sub ?? "-"}`);
  }
}

/* ---------------- error-intel ---------------- */

export function cmdErrorIntel(args: string[]): void {
  const text =
    getFlag(args, "--text") ??
    (getFlag(args, "--file")
      ? readFileSync(getFlag(args, "--file")!, "utf8")
      : undefined);
  if (text === undefined || text.trim().length === 0) {
    fail("error-intel 需要 --text <错误文本> 或 --file <路径>");
  }
  withStore(args, (db) => {
    const advice = recommendExperiences(db, text, {
      projectId: getFlag(args, "--project-id"),
      limit: Number(getFlag(args, "--limit") ?? 5),
    });
    console.log(`category   : ${advice.category}`);
    console.log(`signal     : ${advice.signal || "-"}`);
    console.log(`terms      : ${advice.terms.join(" ") || "-"}`);
    console.log(`matches    : ${advice.matches.length}`);
    for (const m of advice.matches) {
      console.log(`  [${m.tier}] ${m.id}  ${m.summary}`);
    }
    console.log("diagnosis order:");
    for (const step of advice.diagnosisOrder) {
      console.log(`  ${step}`);
    }
  });
}

/* ---------------- entry wiring 辅助 ---------------- */

export function r5Dispatch(args: string[]): void {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "experience":
      cmdExperience(rest);
      return;
    case "profile":
      cmdProfile(rest);
      return;
    case "feedback":
      cmdFeedback(rest);
      return;
    case "conflict":
      cmdConflict(rest);
      return;
    case "quarantine":
      cmdQuarantine(rest);
      return;
    case "error-intel":
      cmdErrorIntel(rest);
      return;
    default:
      console.error(R5_USAGE);
      process.exit(2);
  }
}
