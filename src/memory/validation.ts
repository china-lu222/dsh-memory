import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../store/sqlite.js";
import { updateMemoryItem } from "../store/repository.js";
import { writeTelemetry } from "../store/telemetry.js";

export interface HygieneChange {
  id: string;
  field: string;
  from: string;
  to: string;
}

export interface HygieneResult {
  runId: string;
  actor: string;
  dryRun: boolean;
  scanned: number;
  changed: number;
  events: number;
  skipped: number;
  changes: HygieneChange[];
  status: "succeeded";
  startedAt: string;
  finishedAt: string;
}

export interface EvidenceOutcome {
  changed: boolean;
  applied: boolean;
  memoryId?: string;
  confidenceBefore?: number;
  confidenceAfter?: number;
  reason?: string;
}

export interface EvidenceValidationInput {
  memoryId?: string;
  projectId?: string;
  outcome: "solved" | "confirmed" | "denied" | "failed";
}

interface ScanRow {
  id: string;
  userEdited: number;
  temporalState: string;
  validUntil: string | null;
}

function persistValidationRun(
  db: SqlDatabase,
  opts: {
    runId: string;
    kind: "hygiene" | "evidence";
    actor: string;
    dryRun: boolean;
    scanned: number;
    changed: number;
    events: number;
    skipped: number;
    report: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO validation_runs
       (run_id, kind, actor, scanned, changed, events, skipped, dry_run, status,
        report_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.kind,
    opts.actor,
    opts.scanned,
    opts.changed,
    opts.events,
    opts.skipped,
    opts.dryRun ? 1 : 0,
    JSON.stringify(opts.report),
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

/**
 * 连续校验（确定性 hygiene 扫描，Q050/Q081/Q092）：
 * - 用户编辑记忆（user_edited）永不自动降级/覆盖/改期；
 * - 仅对真实变化写 memory.update 事件，无变化不产生事件；
 * - 结果落 validation_runs + telemetry，单条变更自带 Audit。
 */
export function runHygieneScan(
  db: SqlDatabase,
  opts: { actor?: string; dryRun?: boolean; maxItems?: number } = {},
): HygieneResult {
  const dryRun = opts.dryRun ?? false;
  const actor = opts.actor ?? "validator";
  const startedAt = new Date().toISOString();
  const changes: HygieneChange[] = [];
  const rows = db
    .prepare(
      `SELECT id, user_edited AS userEdited, temporal_state AS temporalState,
              valid_until AS validUntil
       FROM memory_items ORDER BY rowid`,
    )
    .all() as unknown as ScanRow[];
  let scanned = 0;
  let skipped = 0;
  let events = 0;
  const now = Date.now();
  for (const row of rows) {
    if (Number(row.userEdited) === 1) {
      skipped++;
      continue;
    }
    if (row.temporalState !== "current" || row.validUntil === null) {
      continue;
    }
    const expires = new Date(row.validUntil).getTime();
    if (!Number.isFinite(expires) || expires > now) {
      continue;
    }
    scanned++;
    changes.push({
      id: row.id,
      field: "temporalState",
      from: row.temporalState,
      to: "expired",
    });
    if (!dryRun) {
      updateMemoryItem(db, row.id, { temporalState: "expired" });
      events++;
    }
  }
  const result: HygieneResult = {
    runId: randomUUID(),
    actor,
    dryRun,
    scanned,
    changed: changes.length,
    events,
    skipped,
    changes,
    status: "succeeded",
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  persistValidationRun(db, {
    runId: result.runId,
    kind: "hygiene",
    actor,
    dryRun,
    scanned,
    changed: result.changed,
    events,
    skipped,
    report: {
      dryRun,
      changes: dryRun ? changes : changes.map((c) => ({ ...c })),
      sampled: changes.length,
    },
  });
  writeTelemetry(db, {
    kind: "job",
    key: "validation.scan",
    value: { dryRun, scanned, changed: result.changed, events, skipped },
    actor,
  });
  return result;
}

interface EvidenceRow {
  id: string;
  confidence: number;
  userEdited: number;
}

/**
 * 单条证据校验入口（tool behavior / feedback 结果 → confidence 增量）。
 * user_edited 记忆锁定不修改；无变化不写事件。
 */
export function applyEvidenceValidation(
  db: SqlDatabase,
  input: EvidenceValidationInput,
  opts: { actor?: string; dryRun?: boolean } = {},
): EvidenceOutcome {
  const actor = opts.actor ?? "validator";
  const dryRun = opts.dryRun ?? false;
  let candidate: EvidenceRow | null = null;
  if (input.memoryId !== undefined) {
    const row = db
      .prepare(
        `SELECT id, confidence, user_edited AS userEdited
         FROM memory_items WHERE id = ?`,
      )
      .get(input.memoryId) as EvidenceRow | undefined;
    candidate = row ?? null;
  } else if (input.projectId !== undefined) {
    const row = db
      .prepare(
        `SELECT id, confidence, user_edited AS userEdited
         FROM memory_items
         WHERE project_id = ? AND temporal_state = 'current' AND hidden = 0
           AND type IN ('experience','project_knowledge')
         ORDER BY user_edited ASC, confidence DESC LIMIT 1`,
      )
      .get(input.projectId) as EvidenceRow | undefined;
    candidate = row ?? null;
  }
  if (!candidate) {
    const outcome: EvidenceOutcome = {
      changed: false,
      applied: false,
      reason: "no-match",
    };
    persistValidationRun(db, {
      runId: randomUUID(),
      kind: "evidence",
      actor,
      dryRun,
      scanned: 0,
      changed: 0,
      events: 0,
      skipped: 1,
      report: { input, outcome },
    });
    return outcome;
  }
  if (Number(candidate.userEdited) === 1) {
    const outcome: EvidenceOutcome = {
      changed: false,
      applied: false,
      memoryId: candidate.id,
      confidenceBefore: candidate.confidence,
      reason: "user-edited-lock",
    };
    persistValidationRun(db, {
      runId: randomUUID(),
      kind: "evidence",
      actor,
      dryRun,
      scanned: 1,
      changed: 0,
      events: 0,
      skipped: 1,
      report: { input, outcome },
    });
    return outcome;
  }
  const delta = input.outcome === "solved" || input.outcome === "confirmed"
    ? 0.05
    : -0.05;
  const next = Math.min(0.95, Math.max(0.2, candidate.confidence + delta));
  if (Math.abs(next - candidate.confidence) < 1e-9) {
    const outcome: EvidenceOutcome = {
      changed: false,
      applied: false,
      memoryId: candidate.id,
      confidenceBefore: candidate.confidence,
      reason: "no-change",
    };
    persistValidationRun(db, {
      runId: randomUUID(),
      kind: "evidence",
      actor,
      dryRun,
      scanned: 1,
      changed: 0,
      events: 0,
      skipped: 0,
      report: { input, outcome },
    });
    return outcome;
  }
  const outcome: EvidenceOutcome = {
    changed: true,
    applied: !dryRun,
    memoryId: candidate.id,
    confidenceBefore: candidate.confidence,
    confidenceAfter: next,
  };
  if (!dryRun) {
    updateMemoryItem(db, candidate.id, { confidence: next });
  }
  persistValidationRun(db, {
    runId: randomUUID(),
    kind: "evidence",
    actor,
    dryRun,
    scanned: 1,
    changed: 1,
    events: dryRun ? 0 : 1,
    skipped: 0,
    report: { input, outcome, delta },
  });
  writeTelemetry(db, {
    kind: "job",
    key: "validation.evidence",
    value: {
      memoryId: candidate.id,
      outcome: input.outcome,
      dryRun,
      before: candidate.confidence,
      after: next,
    },
    actor,
  });
  return outcome;
}
