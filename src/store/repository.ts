import { createHash, randomUUID } from "node:crypto";
import type { SqlDatabase } from "./sqlite.js";
import { withTransaction } from "./sqlite.js";
import {
  enqueueEvent,
  publishMemoryEvent,
  type MemoryEventType,
} from "./events.js";
import type {
  ExperiencePhase,
  Importance,
  MemoryScope,
  MemoryType,
  ProfileCategory,
  ProjectCategory,
  SourceKind,
  TemporalState,
} from "../schema/enums.js";

/** 新建记忆条目（缺省 id 用 randomUUID；传入确定性 id 用于幂等去重）。 */
export interface NewMemoryItem {
  id?: string;
  type: MemoryType;
  scope: MemoryScope;
  content: string;
  projectId?: string;
  importance?: Importance;
  confidence?: number;
  sourceKind?: SourceKind;
  /** Q104 三层正交状态 */
  experiencePhase?: ExperiencePhase;
  temporalState?: TemporalState;
  lifecycleStatus?: string;
  /** R5：Profile/Experience 的短名与分类、学习到的 utility（反馈更新）。 */
  summary?: string;
  profileCategory?: ProfileCategory;
  projectCategory?: ProjectCategory;
  utility?: number;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}

/** 更新记忆条目时可变更的字段。 */
export interface MemoryItemPatch {
  content?: string;
  importance?: Importance;
  confidence?: number;
  sourceKind?: SourceKind;
  userEdited?: boolean;
  /** 隔离/抑制位（R5 Quarantine，Q078/Q089）；true=进入隔离，false=解除。 */
  hidden?: boolean;
  experiencePhase?: ExperiencePhase | null;
  temporalState?: TemporalState;
  lifecycleStatus?: string | null;
  summary?: string | null;
  profileCategory?: ProfileCategory | null;
  projectCategory?: ProjectCategory | null;
  utility?: number;
  observedAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface MemoryItemRow {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  projectId: string | null;
  content: string;
  importance: Importance;
  confidence: number;
  sourceKind: SourceKind;
  experiencePhase: ExperiencePhase | null;
  temporalState: TemporalState;
  lifecycleStatus: string | null;
  userEdited: number;
  hidden: number;
  summary: string | null;
  profileCategory: ProfileCategory | null;
  projectCategory: ProjectCategory | null;
  utility: number;
  observedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  lastVerifiedAt: string | null;
  lastUsedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const iso = () => new Date().toISOString();

/**
 * 记忆全局版本水位（R6 Memory Cache 失效依据）：任何 memory_items 写入
 * （insert/update/archive/restore）在**同一事务**内把水位推进到当前时间。
 * 缓存指纹包含该水位 → 记忆一变，旧缓存自然失效（version-aware invalidation）。
 */
function bumpMemoryWatermark(db: SqlDatabase): void {
  const now = iso();
  db.prepare(
    `INSERT INTO system_meta (key, value, updated_at) VALUES ('memory.watermark', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(now, now);
}

/** 确定性 id（type+scope+content 的 SHA-256 前 24 位），用于幂等去重。 */
export function makeMemoryId(
  type: MemoryType,
  scope: MemoryScope,
  content: string,
  projectId?: string,
): string {
  const seed = `${type}\u0000${scope}\u0000${projectId ?? ""}\u0000${content}`;
  return `mem_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 24)}`;
}

const COLS = `id,type,scope,project_id AS projectId,content,importance,confidence,
  source_kind AS sourceKind,experience_phase AS experiencePhase,temporal_state AS temporalState,
  lifecycle_status AS lifecycleStatus,user_edited AS userEdited,hidden,
  summary,profile_category AS profileCategory,project_category AS projectCategory,utility,
  observed_at AS observedAt,valid_from AS validFrom,valid_until AS validUntil,
  last_verified_at AS lastVerifiedAt,last_used_at AS lastUsedAt,version,
  created_at AS createdAt,updated_at AS updatedAt`;

const INSERT_SQL = `INSERT INTO memory_items (
    id,type,scope,project_id,content,importance,confidence,source_kind,
    experience_phase,temporal_state,lifecycle_status,user_edited,hidden,
    summary,profile_category,project_category,utility,
    observed_at,valid_from,valid_until,version,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,1,?,?)`;

const UPDATE_SQL = `UPDATE memory_items SET
    type=?,scope=?,project_id=?,content=?,importance=?,confidence=?,source_kind=?,
    experience_phase=?,temporal_state=?,lifecycle_status=?,user_edited=?,hidden=?,
    summary=?,profile_category=?,project_category=?,utility=?,
    observed_at=?,valid_from=?,valid_until=?,last_verified_at=?,last_used_at=?,
    version=?,updated_at=?
  WHERE id=?`;

interface AuditAction {
  action: string;
  event: MemoryEventType;
}

const ACTIONS: Record<MemoryEventType, AuditAction> = {
  "memory.create": { action: "memory.create", event: "memory.create" },
  "memory.update": { action: "memory.update", event: "memory.update" },
  "memory.archive": { action: "memory.archive", event: "memory.archive" },
  "memory.restore": { action: "memory.restore", event: "memory.restore" },
};

/** 在事务内追加一条 audit 行。 */
function writeAudit(
  db: SqlDatabase,
  actor: string,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
): void {
  db.prepare(
    `INSERT INTO audit_log (id,ts,actor,action,entity_type,entity_id,before_json,after_json)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    iso(),
    actor,
    action,
    "memory_item",
    entityId,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
  );
}

/**
 * 在事务内追加 queued 事件行（R6 Durable Outbox）：结构化提交与事件同事务，
 * commit 失败则无事件；幂等键 `${type}:${memoryId}:${version}` 防同版本重复入队。
 */
function writeEvent(
  db: SqlDatabase,
  type: MemoryEventType,
  memoryId: string,
  version: number,
): void {
  enqueueEvent(db, {
    type,
    memoryId,
    entityVersion: version,
    payload: { memoryId, version },
  });
}

/** 同步 FTS5 全文索引（content 变更时 delete + insert）。 */
function syncFts5(db: SqlDatabase, id: string, content: string): void {
  db.prepare("DELETE FROM memory_items_fts WHERE memory_id = ?").run(id);
  db.prepare(
    "INSERT INTO memory_items_fts (memory_id, content) VALUES (?, ?)",
  ).run(id, content);
}

/** 将行对象按 UPDATE 参数顺序展开。 */
function rowParams(row: MemoryItemRow): (string | number | null)[] {
  return [
    row.type,
    row.scope,
    row.projectId,
    row.content,
    row.importance,
    row.confidence,
    row.sourceKind,
    row.experiencePhase,
    row.temporalState,
    row.lifecycleStatus,
    row.userEdited,
    row.hidden,
    row.summary,
    row.profileCategory,
    row.projectCategory,
    row.utility,
    row.observedAt,
    row.validFrom,
    row.validUntil,
    row.lastVerifiedAt,
    row.lastUsedAt,
    row.version,
    row.updatedAt,
    row.id,
  ];
}

/** repository 已按其 event 语义独立入队的事件类型（避免同一操作产生重复 durable 事件）。 */
const RESERVED_EVENT_ACTIONS = new Set([
  "memory.create",
  "memory.update",
  "memory.archive",
  "memory.restore",
]);

/**
 * 追加一条 audit 记录（R5 域操作复用同一审计通道；调用方自管事务）。
 *
 * R6：非 reserved（即域操作专属 action，如 feedback.solved / conflict.resolve /
 * memory.promote / experience.advance 等）同步写一条 durable 事件行，由 Worker
 * 消费做派生工作（缓存失效/后台整合/验证触发）。域事件与 repository 的
 * memory.* 事件互补：memory.update 已覆盖通用“记忆变了 → 投影/向量/缓存”路径，
 * 此处提供语义事件（谁改的、改了什么域动作），供后台任务接线。
 */
export function writeDomainAudit(
  db: SqlDatabase,
  actor: string,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
): void {
  writeAudit(db, actor, action, entityId, before, after);
  if (!RESERVED_EVENT_ACTIONS.has(action)) {
    enqueueEvent(db, {
      type: action,
      memoryId: entityId,
      payload: { actor, action, entityId },
      idempotencyKey: randomUUID(),
    });
  }
}

/**
 * 变更公共路径：读旧行 → 应用 mutation → version+1 → 单事务写
 * UPDATE + audit(before/after) + event → 广播内存事件。
 */
function applyChange(
  db: SqlDatabase,
  id: string,
  mutate: (row: MemoryItemRow) => MemoryItemRow,
  kind: MemoryEventType,
  actor: string,
): MemoryItemRow {
  const existing = getMemoryItemById(db, id);
  if (existing === null) {
    throw new Error(`memory item not found: ${id}`);
  }
  const mutated = mutate({ ...existing });
  const next: MemoryItemRow = {
    ...mutated,
    version: existing.version + 1,
    updatedAt: iso(),
  };
  const audit = ACTIONS[kind];
  withTransaction(db, () => {
    db.prepare(UPDATE_SQL).run(...rowParams(next));
    writeAudit(db, actor, audit.action, id, existing, next);
    writeEvent(db, audit.event, id, next.version);
    syncFts5(db, id, next.content);
    bumpMemoryWatermark(db);
  });
  publishMemoryEvent({
    type: audit.event,
    memoryId: id,
    version: next.version,
    at: next.updatedAt,
  });
  return getMemoryItemById(db, id)!;
}

/**
 * 创建记忆条目（Structured Store 先提交；审计 + 事件记录）。
 * Q102 ChangeSet 一致性的“先提交”侧：派生层（Markdown Projection）由事件驱动。
 */
export function insertMemoryItem(
  db: SqlDatabase,
  input: NewMemoryItem,
  actor = "system",
  options: { skipTransaction?: boolean } = {},
): MemoryItemRow {
  const now = iso();
  const id = input.id ?? randomUUID();
  const body = () => {
    const insert = db.prepare(INSERT_SQL);
    insert.run(
      id,
      input.type,
      input.scope,
      input.projectId ?? null,
      input.content,
      input.importance ?? "normal",
      input.confidence ?? 0.5,
      input.sourceKind ?? "derived",
      input.experiencePhase ?? null,
      input.temporalState ?? "current",
      input.lifecycleStatus ?? null,
      input.summary ?? null,
      input.profileCategory ?? null,
      input.projectCategory ?? null,
      input.utility ?? 0.5,
      input.observedAt ?? null,
      input.validFrom ?? null,
      input.validUntil ?? null,
      now,
      now,
    );
    writeAudit(db, actor, "memory.create", id, undefined, {
      type: input.type,
      scope: input.scope,
      content: input.content,
    });
    writeEvent(db, "memory.create", id, 1);
    syncFts5(db, id, input.content);
    bumpMemoryWatermark(db);
  };
  if (options.skipTransaction === true) {
    // 批量写入并入调用方已开启的外层事务（如 benchmark 种子一次性回滚）。
    body();
  } else {
    withTransaction(db, body);
  }
  const row = getMemoryItemById(db, id)!;
  publishMemoryEvent({
    type: "memory.create",
    memoryId: id,
    version: 1,
    at: now,
  });
  return row;
}

/** 更新记忆条目（content/importance/confidence/source 等）。 */
export function updateMemoryItem(
  db: SqlDatabase,
  id: string,
  patch: MemoryItemPatch,
  actor = "system",
): MemoryItemRow {
  return applyChange(
    db,
    id,
    (row) => ({
      ...row,
      content: patch.content ?? row.content,
      importance: patch.importance ?? row.importance,
      confidence: patch.confidence ?? row.confidence,
      sourceKind: patch.sourceKind ?? row.sourceKind,
      userEdited: patch.userEdited === true ? 1 : row.userEdited,
      hidden: patch.hidden === undefined ? row.hidden : (patch.hidden ? 1 : 0),
      experiencePhase:
        patch.experiencePhase === undefined
          ? row.experiencePhase
          : patch.experiencePhase,
      temporalState: patch.temporalState ?? row.temporalState,
      lifecycleStatus:
        patch.lifecycleStatus === undefined
          ? row.lifecycleStatus
          : patch.lifecycleStatus,
      summary:
        patch.summary === undefined ? row.summary : patch.summary,
      profileCategory:
        patch.profileCategory === undefined
          ? row.profileCategory
          : patch.profileCategory,
      projectCategory:
        patch.projectCategory === undefined
          ? row.projectCategory
          : patch.projectCategory,
      utility: patch.utility ?? row.utility,
      observedAt: patch.observedAt === undefined ? row.observedAt : patch.observedAt,
      validFrom: patch.validFrom === undefined ? row.validFrom : patch.validFrom,
      validUntil:
        patch.validUntil === undefined ? row.validUntil : patch.validUntil,
    }),
    "memory.update",
    actor,
  );
}

/** 归档记忆：temporal_state → historical（Q82 正式六态，保留 version/audit）。 */
export function archiveMemoryItem(
  db: SqlDatabase,
  id: string,
  actor = "system",
): MemoryItemRow {
  return applyChange(
    db,
    id,
    (row) => ({ ...row, temporalState: "historical" }),
    "memory.archive",
    actor,
  );
}

/** 恢复归档记忆：temporal_state → current。 */
export function restoreMemoryItem(
  db: SqlDatabase,
  id: string,
  actor = "system",
): MemoryItemRow {
  return applyChange(
    db,
    id,
    (row) => ({ ...row, temporalState: "current" }),
    "memory.restore",
    actor,
  );
}

export function getMemoryItemById(
  db: SqlDatabase,
  id: string,
): MemoryItemRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM memory_items WHERE id = ?`).get(id);
  return (r as unknown as MemoryItemRow) ?? null;
}

/** 列出活跃记忆（temporal_state 非 historical），按创建时间排序。 */
export function listMemoryItems(db: SqlDatabase): MemoryItemRow[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM memory_items WHERE temporal_state != 'historical' ORDER BY created_at`,
    )
    .all() as unknown as MemoryItemRow[];
}

/** 列出全部记忆（含已归档），用于投影全量重建。 */
export function listAllMemoryItems(db: SqlDatabase): MemoryItemRow[] {
  return db
    .prepare(`SELECT ${COLS} FROM memory_items ORDER BY created_at`)
    .all() as unknown as MemoryItemRow[];
}
