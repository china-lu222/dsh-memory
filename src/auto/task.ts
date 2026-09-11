/**
 * Auto Long-Term Memory — 任务边界与 durable 任务（阶段 3）。
 *
 * 把 autoLearn 从「调用方热路径同步执行」改为「提交任务 → Worker 消费」：
 *  - `submitAutoLearn`：在调用方（会话/任务结束/CLI/API）事务内做廉价 gate 与
 *    敏感预检；可学习内容作为 auto.learn 事件（payload = AutoLearnRequest）写入
 *    events 表后立即返回，不阻塞交互 —— Task Boundary。敏感命中在边界即拦截并
 *    audit 留痕，避免敏感原文落入队列。
 *  - `toAutoLearnRequest`：Worker/重放侧对 payload 的防御性还原；非法 payload
 *    抛错 → 退避重试直至 dead，接线 bug 不静默（见 worker/worker.ts 注释）。
 *
 * Reliability 由 R6 队列承载：入队幂等（同 idempotency_key 去重）、认领-租约
 * 崩溃 resume、失败指数退避、超限 dead（CLI `heal --requeue` 可修复）。执行端
 * 调用 service.autoLearn，其内部对确定性 memoryId 同样幂等。
 */

import { createHash } from "node:crypto";
import { AUTO_ACTIONS, AUTO_TASKS } from "./durable.js";
import { enqueueEvent } from "../store/events.js";
import { makeMemoryId, writeDomainAudit } from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { collapseLine } from "../ingest/text.js";
import { gateText } from "./gate.js";
import { checkSensitive } from "./sensitive.js";
import type { TaskBoundaryProvenance, TaskExperienceRequest } from "./experience.js";
import type { AutoLearnRequest, AutoLearnSubmit } from "./types.js";

const ORIGINS: ReadonlySet<string> = new Set([
  "remember",
  "conversation",
  "task-end",
  "api",
]);

const digest16 = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** auto.learn 幂等键：同 origin + 同项目 + 同文本（折叠空白）至多一条任务。 */
function taskKey(request: AutoLearnRequest): string {
  const project = request.projectId ?? "-";
  return `${AUTO_TASKS.learn}:${request.origin}:${project}:${digest16(
    collapseLine(request.text),
  )}`;
}

/**
 * 敏感拦截留痕（边界执行；与 service.autoLearn 的 traceBlocked 同一动作、
 * 同一 digest 规则，blocked 原文不落入队列也不落 memory store）。
 */
function traceBlocked(
  db: SqlDatabase,
  request: AutoLearnRequest,
  text: string,
  rule: string,
  reason: string,
): string {
  const digest = makeMemoryId("personal", "global", collapseLine(text));
  writeDomainAudit(
    db,
    request.actor ?? `auto:${request.origin}`,
    AUTO_ACTIONS.sensitive,
    digest,
    undefined,
    { rule, reason, chars: text.length },
  );
  return digest;
}

/**
 * 提交一条自动学习任务（任务边界入口）。
 *
 * gate 未达 learnable/remember（闲聊/瞬时/提问/噪声）与敏感命中不产生任务；
 * 其余把完整 request（含原文与来源上下文）持久化进 durable 队列，供后台
 * worker 稍后执行 autoLearn。调用方可在自己事务内调用（commit 前事件不可见）。
 *
 * @param db 已迁移的 memory store
 * @param request 输入与来源上下文（autoLearn 同语义）
 * @returns 提交结果；taskId 为空时通过 intent/reason/blockedDigest 区分原因
 */
export function submitAutoLearn(
  db: SqlDatabase,
  request: AutoLearnRequest,
): AutoLearnSubmit {
  const text = collapseLine(request.text);
  const gate = gateText(text, request.origin);
  if (gate.intent !== "remember" && gate.intent !== "learnable") {
    return { intent: gate.intent, reason: gate.reason, taskId: null, duplicate: false };
  }

  const sensitive = checkSensitive(text);
  if (sensitive.blocked) {
    return {
      intent: gate.intent,
      reason: sensitive.reason,
      taskId: null,
      duplicate: false,
      blockedDigest: traceBlocked(db, request, text, sensitive.rule, sensitive.reason),
    };
  }

  const id = enqueueEvent(db, {
    type: AUTO_TASKS.learn,
    payload: request,
    idempotencyKey: taskKey(request),
  });
  return { intent: gate.intent, taskId: id, duplicate: id === null };
}

/**
 * auto.task-experience 幂等键：同项目 + 同会话 + 同 turn 至多一条经验任务。
 *
 * 边界上游已按「一轮对话只产出一条经验」抽取，故 turn 粒度即内容粒度；
 * 重放或重复投递同一 turn 不会产生第二条经验（worker 侧 id 亦确定）。
 */
function experienceTaskKey(provenance: TaskBoundaryProvenance): string {
  const project = provenance.projectId ?? "-";
  const session = provenance.sessionId ?? "-";
  return `${AUTO_TASKS.taskExperience}:${project}:${session}:${provenance.turn}`;
}

/**
 * 提交一条任务边界经验任务（R8.1 目标 2 的 Task Boundary 入口）。
 *
 * 抽取与校验已由 experience.deriveTaskExperience 在边界完成，本函数只做
 * 幂等入队；因此队列中不会出现「最终无经验」的空任务行。
 *
 * @param db 已迁移的 memory store
 * @param request 已校验的经验候选与边界事实
 * @returns 任务事件 id；同键任务已存在时为 null 且 duplicate 为 true
 */
export function submitTaskExperience(
  db: SqlDatabase,
  request: TaskExperienceRequest,
): { taskId: string | null; duplicate: boolean } {
  const id = enqueueEvent(db, {
    type: AUTO_TASKS.taskExperience,
    payload: request,
    idempotencyKey: experienceTaskKey(request.provenance),
  });
  return { taskId: id, duplicate: id === null };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`auto.task-experience payload ${field} 非字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  return requireString(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`auto.task-experience payload ${field} 非数组`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

/**
 * 还原 auto.task-experience 事件 payload 为 TaskExperienceRequest
 * （worker/replay 消费入口）。payload 来自队列 JSON，不可信：字段缺失或类型
 * 错误一律抛错，交由 worker 退避重试直至 dead，接线 bug 不静默。
 *
 * @param payload 队列事件 payload
 * @returns 校验后的任务请求
 */
export function toTaskExperienceRequest(payload: unknown): TaskExperienceRequest {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("auto.task-experience payload 不是对象");
  }
  const p = payload as Record<string, unknown>;
  const rawProvenance = p.provenance;
  if (typeof rawProvenance !== "object" || rawProvenance === null) {
    throw new Error("auto.task-experience payload 缺少 provenance 对象");
  }
  const rawCandidate = p.candidate;
  if (typeof rawCandidate !== "object" || rawCandidate === null) {
    throw new Error("auto.task-experience payload 缺少 candidate 对象");
  }
  const provenanceSource = rawProvenance as Record<string, unknown>;
  const candidateSource = rawCandidate as Record<string, unknown>;
  const turn = provenanceSource.turn;
  if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) {
    throw new Error(
      `auto.task-experience payload provenance.turn 非法: ${String(turn)}`,
    );
  }
  const sessionId = provenanceSource.sessionId;
  if (sessionId !== null && typeof sessionId !== "string") {
    throw new Error("auto.task-experience payload provenance.sessionId 非法");
  }
  const projectId = provenanceSource.projectId;
  if (projectId !== null && typeof projectId !== "string") {
    throw new Error("auto.task-experience payload provenance.projectId 非法");
  }
  const summary = requireString(candidateSource.summary, "candidate.summary");
  if (summary.trim().length === 0) {
    throw new Error("auto.task-experience payload candidate.summary 为空");
  }
  return {
    provenance: {
      sessionId,
      turn,
      projectId,
      reason: requireString(provenanceSource.reason, "provenance.reason"),
    },
    candidate: {
      summary,
      problem: requireString(candidateSource.problem, "candidate.problem"),
      context: optionalString(candidateSource.context, "candidate.context"),
      symptoms: requireStringArray(candidateSource.symptoms, "candidate.symptoms"),
      rootCause: optionalString(candidateSource.rootCause, "candidate.rootCause"),
      solution: requireString(candidateSource.solution, "candidate.solution"),
      lesson: optionalString(candidateSource.lesson, "candidate.lesson"),
      technologies: requireStringArray(
        candidateSource.technologies,
        "candidate.technologies",
      ),
    },
  };
}

/**
 * 还原 auto.learn 事件 payload 为 AutoLearnRequest（worker/replay 消费入口）。
 * payload 来自队列 JSON，不可信：字段缺失/类型错误抛错，交由 worker 重试/死信。
 */
export function toAutoLearnRequest(payload: unknown): AutoLearnRequest {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("auto.learn payload 不是对象");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== "string" || p.text.trim().length === 0) {
    throw new Error("auto.learn payload 缺少非空 text");
  }
  if (typeof p.origin !== "string" || !ORIGINS.has(p.origin)) {
    throw new Error(`auto.learn payload origin 非法: ${String(p.origin)}`);
  }
  const request: AutoLearnRequest = {
    text: p.text,
    origin: p.origin as AutoLearnRequest["origin"],
  };
  if (typeof p.projectId === "string" && p.projectId.length > 0) {
    request.projectId = p.projectId;
  }
  if (typeof p.actor === "string" && p.actor.length > 0) {
    request.actor = p.actor;
  }
  if (typeof p.sourceRef === "string" && p.sourceRef.length > 0) {
    request.sourceRef = p.sourceRef;
  }
  return request;
}
