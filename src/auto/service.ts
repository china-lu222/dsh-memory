/**
 * Auto Long-Term Memory — 自动学习编排（阶段 2，单入口 autoLearn）。
 *
 * 链：输入（remember/会话/API）→ gate 分级 → 敏感过滤 → 抽取/分类 → 评估 →
 * scope/sourceKind/id 解析 → 写入 repository → 冲突 review / 低置信隔离。
 *
 * 写入全部走 repository 的 insertMemoryItem（幂等确定性 id + memory.create
 * audit/event）；已有同 id 记忆直接跳过。自动侧不改写既有记忆：命中同型近似
 * 由 detectMemoryConflicts 生成 conflict.open review 进评审队列，低置信 inferred
 * 写入后立即隔离（hidden=1）。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import {
  getMemoryItemById,
  insertMemoryItem,
  makeMemoryId,
  writeDomainAudit,
} from "../store/repository.js";
import { createConflictReview, detectMemoryConflicts } from "../memory/conflict.js";
import { quarantineMemory } from "../memory/quarantine.js";
import { collapseLine } from "../ingest/text.js";
import { gateText, stripRememberPrefix } from "./gate.js";
import { checkSensitive } from "./sensitive.js";
import { classifyContent } from "./classifier.js";
import { extractAutoCandidates } from "./extractor.js";
import { evaluateAutoCandidates, AUTO_QUARANTINE_THRESHOLD } from "./evaluator.js";
import { resolveAutoCandidates } from "./scoper.js";
import { AUTO_ACTIONS } from "./durable.js";
import type {
  AutoLearnOutcome,
  AutoLearnRequest,
  GateIntent,
  LearnContext,
  ResolvedAutoCandidate,
} from "./types.js";

function outcome(intent: GateIntent, reason?: string): AutoLearnOutcome {
  return {
    intent,
    reason,
    created: [],
    skipped: 0,
    conflicts: 0,
    quarantined: [],
    blocked: [],
  };
}

function toContext(request: AutoLearnRequest): LearnContext {
  return {
    origin: request.origin,
    projectId: request.projectId ?? null,
    actor: request.actor ?? `auto:${request.origin}`,
    sourceRef: request.sourceRef,
  };
}

/** 敏感拦截留痕（不含原文；用内容哈希做 entityId）。 */
function traceBlocked(
  db: SqlDatabase,
  ctx: LearnContext,
  text: string,
  rule: string,
  reason: string,
): string {
  const digest = makeMemoryId("personal", "global", collapseLine(text));
  writeDomainAudit(db, ctx.actor, AUTO_ACTIONS.sensitive, digest, undefined, {
    rule,
    reason,
    chars: text.length,
  });
  return digest;
}

/** 写入阶段：幂等插入 → 低置信隔离 → 冲突 review 入队。 */
function writeCandidates(
  db: SqlDatabase,
  rows: ResolvedAutoCandidate[],
  ctx: LearnContext,
  current: AutoLearnOutcome,
): void {
  for (const row of rows) {
    if (getMemoryItemById(db, row.memoryId) !== null) {
      current.skipped += 1;
      continue;
    }
    insertMemoryItem(
      db,
      {
        id: row.memoryId,
        type: row.type,
        scope: row.scope,
        content: row.content,
        projectId: row.projectId ?? undefined,
        importance: row.importance,
        confidence: row.confidence,
        sourceKind: row.sourceKind,
        summary: row.summary,
      },
      ctx.actor,
    );
    current.created.push(row.memoryId);

    const lowConfidence =
      row.sourceKind === "inferred" &&
      row.confidence < AUTO_QUARANTINE_THRESHOLD;
    if (lowConfidence) {
      quarantineMemory(
        db,
        row.memoryId,
        `auto: low confidence ${row.confidence}`,
        ctx.actor,
      );
      current.quarantined.push(row.memoryId);
      continue;
    }
    for (const cand of detectMemoryConflicts(db, row.memoryId)) {
      const review = createConflictReview(db, {
        memoryAId: row.memoryId,
        memoryBId: cand.otherId,
        relation: cand.relation,
        basis: `auto-learn ${cand.basis}`,
        actor: ctx.actor,
      });
      if (review.status === "open") current.conflicts += 1;
    }
  }
}

/**
 * 自动学习单入口（幂等：同输入重复调用不产生重复记忆/评审）。
 * @param db 已迁移的 memory store
 * @param request 输入与来源上下文
 */
export function autoLearn(
  db: SqlDatabase,
  request: AutoLearnRequest,
): AutoLearnOutcome {
  const ctx = toContext(request);
  const text = collapseLine(request.text);
  const gate = gateText(text, request.origin);

  if (gate.intent !== "remember" && gate.intent !== "learnable") {
    return outcome(gate.intent, gate.reason);
  }

  const sensitive = checkSensitive(text);
  if (sensitive.blocked) {
    const res = outcome(gate.intent, sensitive.reason);
    res.blocked.push(
      traceBlocked(db, ctx, text, sensitive.rule, sensitive.reason),
    );
    return res;
  }

  // 显式「记住」：整句即事实（前缀剥离），type 由 classifier 给出。
  if (gate.intent === "remember") {
    const body = collapseLine(stripRememberPrefix(text));
    if (body.length === 0) {
      return outcome("noisy", "empty remember content");
    }
    const classify = classifyContent(body);
    const candidates = extractAutoCandidates(body, { classify });
    const evaluated = evaluateAutoCandidates(candidates, ctx, "remember");
    const rows = resolveAutoCandidates(evaluated, ctx, "remember");
    const res = outcome("remember");
    writeCandidates(db, rows, ctx, res);
    return res;
  }

  // 自动学习（conversation/api）：仅规则显式命中的自述产出候选。
  const candidates = extractAutoCandidates(text);
  if (candidates.length === 0) {
    return outcome("learnable", "no rule-matched fact");
  }
  const evaluated = evaluateAutoCandidates(candidates, ctx, "learnable");
  const rows = resolveAutoCandidates(evaluated, ctx, "learnable");
  const res = outcome("learnable");
  writeCandidates(db, rows, ctx, res);
  return res;
}
