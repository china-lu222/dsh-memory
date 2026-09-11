/**
 * Task Boundary 自动经验学习 — 经验抽取与校验（R8.1 目标 2）。
 *
 * 任务边界链路：turn/end → 对话摘要 → 经验抽取 → 校验 → experience_details。
 * 本模块负责「摘要 → 抽取 → 校验」的确定性部分；落库由 persistTaskExperience
 * 经既有 experience 域（createExperience → memory_items + experience_details +
 * audit + memory.create 事件）完成，不另建写入路径。
 *
 * 精度约束（与 ingest / conversation 规则同口径）：
 *  - 只认「问题句 + 解决句」同时出现，且解决句位于问题句之后；缺任一不产出经验，
 *    不用模板补全 —— 空经验比编造经验更有价值；
 *  - 所有字段都取自对话原句（collapseLine 归一化），不做改写、不做归因推断；
 *  - 敏感内容在边界校验阶段拦截，不进入队列也不落库。
 */

import { collapseLine } from "../ingest/text.js";
import type { ExperiencePhase } from "../schema/enums.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { createExperience, DEFAULT_PHASE } from "../memory/experience.js";
import { getMemoryItemById, makeMemoryId } from "../store/repository.js";
import type { ConversationObservation } from "./types.js";
import { checkSensitive } from "./sensitive.js";

/** 任务边界事实：一轮对话结束时的宿主状态。 */
export interface TaskBoundaryProvenance {
  /** 宿主会话 id；载荷缺失时为 null。 */
  sessionId: string | null;
  /** 宿主 turn 序号（turn/end payload.turn）。 */
  turn: number;
  /** 会话所属项目；null 表示未提供（经验落 session/global scope）。 */
  projectId: string | null;
  /** turn/end 的 reason.kind（completed/aborted/error/…）。 */
  reason: string;
}

/** 任务边界的完整输入：对话观测 + 边界事实。 */
export interface TaskBoundaryInput {
  provenance: TaskBoundaryProvenance;
  observations: readonly ConversationObservation[];
}

/** 抽取出的经验候选（字段全部来自对话原句）。 */
export interface TaskExperienceCandidate {
  /** 解决句（经验标题，也是 memory content 与检索面）。 */
  summary: string;
  problem: string;
  context: string;
  symptoms: string[];
  rootCause: string;
  solution: string;
  lesson: string;
  technologies: string[];
}

/**
 * `auto.task-experience` 任务载荷。
 *
 * 抽取与校验已在任务边界完成，队列只承载已通过的候选；worker 侧仅做落库，
 * 因此队列中不会出现待判断的原始对话（避免无用队列行）。
 */
export interface TaskExperienceRequest {
  provenance: TaskBoundaryProvenance;
  candidate: TaskExperienceCandidate;
}

/** 边界校验结果（判别联合：invalid 携带可读原因，用于诊断与统计）。 */
export type TaskExperienceValidation =
  | { status: "ok" }
  | { status: "invalid"; reason: string };

/** 边界派生结果：抽取与校验的组合结论。 */
export type TaskExperienceOutcome =
  | { status: "ok"; candidate: TaskExperienceCandidate }
  /** 该轮对话没有「问题 → 解决」证据，不产生经验（不是错误）。 */
  | { status: "no-experience" }
  | { status: "invalid"; reason: string };

/** 摘要/字段长度上限（与 ingest 口径一致，避免超长字段进记忆库）。 */
const MAX_SUMMARY = 180;
const MAX_FIELD = 300;
const MAX_SYMPTOM = 200;
const MAX_SYMPTOMS = 3;
/** 参与抽取的观测条数上限（超出取最近 N 条，边界内存有界）。 */
const MAX_OBSERVATIONS = 40;

/** 问题信号：出现即认为该句描述了一个待解决的问题。 */
const PROBLEM_SIGNAL =
  /报错|错误|异常|失败|崩溃|踩坑|不能|无法|不生效|没生效|失效|超时|卡住|挂掉|Error|Exception|failed|failure|crash|timeout|TypeError|undefined is not|bug\b|BUG/i;

/** 解决信号：出现即认为该句给出了可行的处置。 */
const RESOLUTION_SIGNAL =
  /解决|修复|修好|改为|改成|换成|换用|定位到|排查出|找到了|绕过|规避|原因是|根因|fix(?:ed|es)?\b|resolv(?:e|ed|es)\b|workaround|root\s+cause/i;

/** 归因信号：用于填 rootCause。 */
const CAUSE_SIGNAL =
  /原因(?:是|在于|为)?|是因为|根因|因为|由于|due to|caused by|because|root\s+cause/i;

/** 教训信号：只在对话显式给出「以后/下次」类提醒时才记录教训。 */
const LESSON_SIGNAL =
  /以后|下次|后续|记住|注意|避免|不要再|别再|应该|务必|always\b|never\b|next time|remember to/i;

/** 技术栈词表：只做「出现即记录」的确定性扫描，不做推断。 */
const TECHNOLOGIES: readonly string[] = [
  "TypeScript",
  "JavaScript",
  "Node.js",
  "Node",
  "SQLite",
  "PostgreSQL",
  "MySQL",
  "Redis",
  "React",
  "Vue",
  "Svelte",
  "Python",
  "Rust",
  "Go",
  "Java",
  "Docker",
  "Kubernetes",
  "pnpm",
  "npm",
  "yarn",
  "Vite",
  "Vitest",
  "webpack",
  "SQL",
  "HTTP",
  "HTTPS",
  "SSE",
  "WebSocket",
  "JSON",
  "YAML",
  "TOML",
  "CSS",
  "HTML",
  "REST",
  "GraphQL",
  "Git",
  "Cordis",
  "Windows",
  "Linux",
  "macOS",
];

/** 句子切分：句末标点与换行为界，保留句子内容本身。 */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface PositionedSentence {
  role: "user" | "assistant";
  text: string;
}

function positionSentences(
  observations: readonly ConversationObservation[],
): PositionedSentence[] {
  const out: PositionedSentence[] = [];
  for (const observation of observations.slice(-MAX_OBSERVATIONS)) {
    for (const sentence of splitSentences(observation.text)) {
      out.push({ role: observation.role, text: sentence });
    }
  }
  return out;
}

/**
 * 确定性的对话摘要：各角色首句按出现顺序拼接，去重后截断。
 * 不用模型总结，摘要内容全部可回溯到原句。
 * @param observations 该轮对话的观测（按时间顺序）
 * @returns 一句话摘要；无可用观测时为空串
 */
export function summarizeTaskConversation(
  observations: readonly ConversationObservation[],
): string {
  const parts: string[] = [];
  const seenRoles = new Set<string>();
  for (const observation of observations) {
    if (seenRoles.has(observation.role)) continue;
    const first = splitSentences(observation.text)[0];
    if (first === undefined) continue;
    seenRoles.add(observation.role);
    parts.push(first);
  }
  return collapseLine(parts.join(" / "), MAX_SUMMARY);
}

function detectTechnologies(text: string): string[] {
  const found: string[] = [];
  for (const tech of TECHNOLOGIES) {
    const pattern = new RegExp(
      `(?:^|[^A-Za-z0-9_])${tech.replaceAll(".", "\\.")}[^A-Za-z0-9_]|${tech.replaceAll(".", "\\.")}$`,
    );
    if (pattern.test(text)) found.push(tech);
  }
  return found;
}

/**
 * 经验抽取：从一轮对话中找出「问题句 → 解决句」证据对。
 *
 * 要求问题句与解决句同时存在且解决句在后；只在对话出现了解决信号时产出，
 * 因此纯粹的困难陈述（没问题处置）不会变成经验。
 * @param input 任务边界输入（观测 + 边界事实）
 * @returns 经验候选；无充分证据时返回 null
 */
export function extractTaskExperience(
  input: TaskBoundaryInput,
): TaskExperienceCandidate | null {
  const sentences = positionSentences(input.observations);
  const problemIndex = sentences.findIndex(
    (s) => PROBLEM_SIGNAL.test(s.text) && !RESOLUTION_SIGNAL.test(s.text),
  );
  if (problemIndex < 0) return null;
  const solutionOffset = sentences
    .slice(problemIndex + 1)
    .findIndex((s) => RESOLUTION_SIGNAL.test(s.text));
  if (solutionOffset < 0) return null;
  const solutionIndex = problemIndex + 1 + solutionOffset;

  const problem = collapseLine(sentences[problemIndex]!.text, MAX_FIELD);
  const solution = collapseLine(sentences[solutionIndex]!.text, MAX_FIELD);
  if (problem.length === 0 || solution.length === 0) return null;

  const between = sentences.slice(problemIndex + 1, solutionIndex + 1);
  const cause = between.find((s) => CAUSE_SIGNAL.test(s.text));
  const symptoms = sentences
    .filter(
      (s, index) =>
        index !== problemIndex &&
        index !== solutionIndex &&
        PROBLEM_SIGNAL.test(s.text),
    )
    .slice(0, MAX_SYMPTOMS)
    .map((s) => collapseLine(s.text, MAX_SYMPTOM));
  const lesson = sentences
    .slice(solutionIndex)
    .find((s) => LESSON_SIGNAL.test(s.text));
  const wholeText = sentences.map((s) => s.text).join("\n");

  return {
    summary: collapseLine(sentences[solutionIndex]!.text, MAX_SUMMARY),
    problem,
    context: summarizeTaskConversation(input.observations),
    symptoms,
    rootCause: cause === undefined ? "" : collapseLine(cause.text, MAX_FIELD),
    solution,
    lesson: lesson === undefined ? "" : collapseLine(lesson.text, MAX_SYMPTOM),
    technologies: detectTechnologies(wholeText),
  };
}

/**
 * 边界校验：非空、长度受限、无敏感内容。
 *
 * 与 task.ts 的 auto.learn 边界一致，敏感原文不进入 durable 队列。
 * @param candidate 抽取出的经验候选
 * @returns 校验结论；invalid 时携带可读原因
 */
export function validateTaskExperience(
  candidate: TaskExperienceCandidate,
): TaskExperienceValidation {
  if (candidate.summary.length === 0) {
    return { status: "invalid", reason: "经验摘要为空" };
  }
  if (candidate.problem.length === 0) {
    return { status: "invalid", reason: "经验缺少问题描述" };
  }
  if (candidate.solution.length === 0) {
    return { status: "invalid", reason: "经验缺少解决方案" };
  }
  if (candidate.summary.length > MAX_SUMMARY + 1) {
    return { status: "invalid", reason: "经验摘要超长" };
  }
  const sensitive = checkSensitive(
    `${candidate.summary}\n${candidate.problem}\n${candidate.solution}`,
  );
  if (sensitive.blocked) {
    return { status: "invalid", reason: sensitive.reason };
  }
  return { status: "ok" };
}

/**
 * 组合「摘要 → 抽取 → 校验」，供任务边界适配器一次调用。
 * @param input 任务边界输入
 * @returns 派生结论：ok 携带候选，否则说明不产出经验的原因
 */
export function deriveTaskExperience(
  input: TaskBoundaryInput,
): TaskExperienceOutcome {
  const candidate = extractTaskExperience(input);
  if (candidate === null) return { status: "no-experience" };
  const validation = validateTaskExperience(candidate);
  if (validation.status === "invalid") {
    return { status: "invalid", reason: validation.reason };
  }
  return { status: "ok", candidate };
}

/**
 * 落库（worker 侧）：经验主干 + experience_details，经既有 experience 域写入。
 *
 * 记忆 id 由 scope + summary 确定性生成，重复执行（重放/重复投递）读到既有行
 * 即返回，不产生第二条经验也不抛错 —— 队列至少一次投递语义下的幂等保证。
 * @param db 已迁移的 memory store
 * @param candidate 已通过边界校验的经验候选
 * @param provenance 任务边界事实（写入 experience context 供回溯）
 * @returns 经验 id 与当前 phase；created 表示本次是否真正新建
 */
export function persistTaskExperience(
  db: SqlDatabase,
  candidate: TaskExperienceCandidate,
  provenance: TaskBoundaryProvenance,
): { id: string; phase: ExperiencePhase; created: boolean } {
  const scope = provenance.projectId === null ? "session" : "project";
  const id = makeMemoryId("experience", scope, candidate.summary);
  const existing = getMemoryItemById(db, id);
  if (existing !== null) {
    return {
      id,
      phase: existing.experiencePhase ?? DEFAULT_PHASE,
      created: false,
    };
  }
  const { phase } = createExperience(
    db,
    {
      id,
      summary: candidate.summary,
      problem: candidate.problem,
      context: taskBoundaryContext(candidate, provenance),
      symptoms: candidate.symptoms,
      rootCause: candidate.rootCause,
      solution: candidate.solution,
      lesson: candidate.lesson,
      technologies: candidate.technologies,
      scope,
      ...(provenance.projectId === null ? {} : { projectId: provenance.projectId }),
      sourceKind: "derived",
      importance: "high",
      confidence: 0.6,
    },
    "system",
  );
  return { id, phase, created: true };
}

/**
 * experience context 文本：对话摘要 + 边界事实，保留经验来源可回溯。
 * @param candidate 经验候选
 * @param provenance 任务边界事实
 * @returns 单行 context 文本
 */
export function taskBoundaryContext(
  candidate: TaskExperienceCandidate,
  provenance: TaskBoundaryProvenance,
): string {
  const session = provenance.sessionId ?? "-";
  return collapseLine(
    `任务边界自动沉淀（session=${session} turn=${provenance.turn} reason=${provenance.reason}）：${candidate.context}`,
    MAX_FIELD,
  );
}
