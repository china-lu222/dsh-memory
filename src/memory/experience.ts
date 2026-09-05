/**
 * Experience 域（R5）：Experience first-class memory（Q036–Q065）。
 *  - memory_items.type='experience' 作为主干（content=summary）；
 *  - experience_details 保存结构化明细（problem/symptoms/failed_attempts/
 *    solution/applicability/lesson/technologies…），禁止退化为 content 字符串；
 *  - experience_phase 流转（Q40，Q104 正交层一）由可配置 TRANSITIONS 驱动，
 *    拒绝跳跃与非法状态。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import {
  insertMemoryItem,
  getMemoryItemById,
  listAllMemoryItems,
  updateMemoryItem,
  writeDomainAudit,
  makeMemoryId,
} from "../store/repository.js";
import type { ExperiencePhase } from "../schema/enums.js";

export interface NewExperience {
  /** 可选显式 id；缺省按 type/scope/content 确定生成。 */
  id?: string;
  projectId?: string;
  scope?: "session" | "project" | "global" | "generalized";
  /** 一句话经验标题（memory content 与 FTS 检索面）。 */
  summary: string;
  problem: string;
  context?: string;
  symptoms?: string[];
  rootCause?: string;
  failedAttempts?: Array<{ attempt: string; outcome: string }>;
  solution?: string;
  verification?: string;
  validation?: string;
  applicability?: string[];
  lesson?: string;
  technologies?: string[];
  environment?: string;
  importance?: "critical" | "high" | "normal" | "low" | "disposable";
  confidence?: number;
  sourceKind?: "explicit" | "user-edited" | "derived" | "inferred";
  experiencePhase?: ExperiencePhase;
  observedAt?: string;
}

/** experience_details 行（JSON 列已解包）。 */
export interface ExperienceDetails {
  problem: string;
  context: string;
  symptoms: string[];
  rootCause: string;
  failedAttempts: Array<{ attempt: string; outcome: string }>;
  solution: string;
  verification: string;
  validation: string;
  applicability: string[];
  lesson: string;
  technologies: string[];
  environment: string;
}

export interface Experience {
  memory: ReturnType<typeof getMemoryItemById> extends infer R
    ? Exclude<R, null>
    : never;
  details: ExperienceDetails;
}

/** phase 流转图（R5，可配置 transitions）。不允许的跳跃直接抛错。 */
export const EXPERIENCE_TRANSITIONS: Record<
  ExperiencePhase,
  ExperiencePhase[]
> = {
  // candidate → investigating：进入调查；
  // candidate → verified：用户直接确认方案解决（Q65 solved），允许跳级但仅到 verified。
  candidate: ["investigating", "verified"],
  investigating: ["solution-found"],
  "solution-found": ["verified"],
  verified: ["validated"],
  validated: [],
};

export const DEFAULT_PHASE: ExperiencePhase = "candidate";

/** 把普通 JSON 文本列安全解包；坏数据按空集合处理并在结果里由调用方复核。 */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function parseAttempts(
  raw: string | null | undefined,
): Array<{ attempt: string; outcome: string }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is { attempt: string; outcome: string } =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as { attempt: unknown }).attempt === "string" &&
        typeof (x as { outcome: unknown }).outcome === "string",
    );
  } catch {
    return [];
  }
}

/** 读取 experience_details 行（未创建时返回空详情模板）。 */
export function getExperienceDetails(
  db: SqlDatabase,
  memoryId: string,
): ExperienceDetails | null {
  const row = db
    .prepare("SELECT * FROM experience_details WHERE memory_id = ?")
    .get(memoryId) as
    | {
        problem: string;
        context: string;
        symptoms_json: string;
        root_cause: string;
        failed_attempts_json: string;
        solution: string;
        verification: string;
        validation: string;
        applicability_json: string;
        lesson: string;
        technologies_json: string;
        environment: string;
      }
    | undefined;
  if (!row) return null;
  return {
    problem: row.problem,
    context: row.context,
    symptoms: parseStringArray(row.symptoms_json),
    rootCause: row.root_cause,
    failedAttempts: parseAttempts(row.failed_attempts_json),
    solution: row.solution,
    verification: row.verification,
    validation: row.validation,
    applicability: parseStringArray(row.applicability_json),
    lesson: row.lesson,
    technologies: parseStringArray(row.technologies_json),
    environment: row.environment,
  };
}

const UPSERT_DETAILS_SQL = `INSERT INTO experience_details (
    memory_id,problem,context,symptoms_json,root_cause,failed_attempts_json,
    solution,verification,validation,applicability_json,lesson,
    technologies_json,environment,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(memory_id) DO UPDATE SET
    problem=excluded.problem, context=excluded.context,
    symptoms_json=excluded.symptoms_json, root_cause=excluded.root_cause,
    failed_attempts_json=excluded.failed_attempts_json,
    solution=excluded.solution, verification=excluded.verification,
    validation=excluded.validation, applicability_json=excluded.applicability_json,
    lesson=excluded.lesson, technologies_json=excluded.technologies_json,
    environment=excluded.environment, updated_at=excluded.updated_at`;

/**
 * 全量保存经验明细。编辑锁定（Q047/Q050）：系统自动更新被用户编辑过的经验会被拒。
 * @param actor user 或 system
 */
export function saveExperienceDetails(
  db: SqlDatabase,
  memoryId: string,
  details: ExperienceDetails,
  actor: "user" | "system" = "system",
): void {
  const existing = getMemoryItemById(db, memoryId);
  if (existing === null) {
    throw new Error(`memory item not found: ${memoryId}`);
  }
  if (existing.type !== "experience") {
    throw new Error(`memory item is not an experience: ${memoryId}`);
  }
  if (existing.userEdited === 1 && actor !== "user") {
    throw new Error(
      `experience is user-edited; only explicit user changes may proceed: ${memoryId}`,
    );
  }
  const before = getExperienceDetails(db, memoryId);
  db.prepare(UPSERT_DETAILS_SQL).run(
    memoryId,
    details.problem,
    details.context,
    JSON.stringify(details.symptoms),
    details.rootCause,
    JSON.stringify(details.failedAttempts),
    details.solution,
    details.verification,
    details.validation,
    JSON.stringify(details.applicability),
    details.lesson,
    JSON.stringify(details.technologies),
    details.environment,
    new Date().toISOString(),
  );
  writeDomainAudit(
    db,
    actor,
    "experience.details",
    memoryId,
    before,
    details,
  );
}

/** 构建一条结构化 Experience：memory 主干 + experience_details 明细。 */
export function createExperience(
  db: SqlDatabase,
  input: NewExperience,
  actor: "user" | "system" = "user",
): { id: string; phase: ExperiencePhase } {
  if (!input.summary.trim()) throw new Error("experience summary is required");
  if (!input.problem.trim()) throw new Error("experience problem is required");
  const scope =
    input.scope ?? (input.projectId ? "project" : "session");
  const phase = input.experiencePhase ?? DEFAULT_PHASE;
  if (phase !== DEFAULT_PHASE && phase !== "investigating") {
    // 新建即已验证/沉淀需显式 sourceKind 与证据链，避免静默自证。
    throw new Error(
      `new experience must start at candidate or investigating, got ${phase}`,
    );
  }
  const id = input.id ?? makeMemoryId("experience", scope, input.summary);
  insertMemoryItem(
    db,
    {
      id,
      type: "experience",
      scope,
      projectId: input.projectId,
      content: input.summary,
      summary: input.summary,
      importance: input.importance ?? "high",
      confidence: input.confidence ?? 0.7,
      sourceKind: input.sourceKind ?? "explicit",
      experiencePhase: phase,
      observedAt: input.observedAt,
    },
    actor,
  );
  saveExperienceDetails(
    db,
    id,
    {
      problem: input.problem,
      context: input.context ?? "",
      symptoms: input.symptoms ?? [],
      rootCause: input.rootCause ?? "",
      failedAttempts: input.failedAttempts ?? [],
      solution: input.solution ?? "",
      verification: input.verification ?? "",
      validation: input.validation ?? "",
      applicability: input.applicability ?? [],
      lesson: input.lesson ?? "",
      technologies: input.technologies ?? [],
      environment: input.environment ?? "",
    },
    actor,
  );
  return { id, phase };
}

/** 读取完整经验（主干 + 明细）。非 experience 或不存在返回 null。 */
export function getExperience(db: SqlDatabase, id: string): Experience | null {
  const memory = getMemoryItemById(db, id);
  if (memory === null || memory.type !== "experience") return null;
  const details = getExperienceDetails(db, id);
  if (details === null) {
    throw new Error(
      `experience ${id} has no experience_details; store is inconsistent`,
    );
  }
  return { memory, details };
}

export interface ExperienceFilter {
  phase?: ExperiencePhase;
  projectId?: string;
  /** 默认只返回非 historical。 */
  includeHistorical?: boolean;
}

/** 列出经验（可按 phase/project 过滤）。 */
export function listExperiences(
  db: SqlDatabase,
  filter: ExperienceFilter = {},
): Experience[] {
  const rows = listAllMemoryItems(db).filter(
    (row) =>
      row.type === "experience" &&
      (filter.phase === undefined || row.experiencePhase === filter.phase) &&
      (filter.projectId === undefined ||
        row.projectId === filter.projectId) &&
      (filter.includeHistorical === true ||
        row.temporalState !== "historical"),
  );
  return rows
    .map((row) => getExperience(db, row.id))
    .filter((x): x is Experience => x !== null);
}

/**
 * 推进经验 phase。next 缺省走默认后继；
 * 非法的跳跃（不在 TRANSITIONS[next-of-from] 内）抛错，杜绝静默伪推进。
 */
export function advanceExperiencePhase(
  db: SqlDatabase,
  id: string,
  next?: ExperiencePhase,
  actor: "user" | "system" = "user",
): ExperiencePhase {
  const row = getMemoryItemById(db, id);
  if (row === null || row.type !== "experience") {
    throw new Error(`experience not found: ${id}`);
  }
  const from = row.experiencePhase ?? DEFAULT_PHASE;
  if (row.userEdited === 1 && actor !== "user") {
    throw new Error(
      `experience is user-edited; only explicit user changes may proceed: ${id}`,
    );
  }
  const allowed = EXPERIENCE_TRANSITIONS[from];
  const target = next ?? allowed[0]!;
  if (!allowed.includes(target)) {
    throw new Error(
      `invalid phase transition ${from} -> ${target}; allowed: ${allowed.join(", ")}`,
    );
  }
  const updated = updateMemoryItem(
    db,
    id,
    { experiencePhase: target },
    actor,
  );
  return updated.experiencePhase ?? from;
}
