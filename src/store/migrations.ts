import type { SqlDatabase } from "./sqlite.js";

/**
 * 迁移定义：v1 起的结构化记忆 Store 演进。
 * 决策：SQLite 为 Structured Memory Store Source of Truth（Q023）；
 * 派生层（Markdown Projection / Vector Index）不在此固化。
 *
 * 幂等性与命名空间：
 *  - 所有 CREATE TABLE / CREATE INDEX 均带 IF NOT EXISTS，允许在中断运行留下的
 *    对象上补齐而非报错；
 *  - 索引名一律使用 ts_ 前缀命名空间。TS schema 与旧 JS schema（决策 B 同文件
 *    共存，旧表永不删除）可能撞同名索引——真实取证：旧库 evidence 表上已有
 *    idx_evidence_memory，若新表 memory_evidence 也建同名索引会报
 *    “index idx_evidence_memory already exists” 并整体回滚。命名空间化后两者可共存。
 * 残留 schema 与当前期望不一致的风险由 migrate() 之后的取数冒烟/status 暴露，
 * 而非在此静默吞掉。
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: SqlDatabase) => void;
}

const iso = () => new Date().toISOString();

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-structured-memory-store",
    up(db) {
      db.exec(`
        -- 文档（摄取单元：file/url/text）
        CREATE TABLE IF NOT EXISTS documents (
          id           TEXT PRIMARY KEY,
          uri          TEXT NOT NULL UNIQUE,
          kind         TEXT NOT NULL CHECK (kind IN ('file','url','text')),
          title        TEXT,
          meta_json    TEXT NOT NULL DEFAULT '{}',
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );

        -- 分块（结构化存储的一部分，后续由 FTS/向量索引引用）
        CREATE TABLE IF NOT EXISTS chunks (
          id           TEXT PRIMARY KEY,
          document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          seq          INTEGER NOT NULL,
          content      TEXT NOT NULL,
          heading      TEXT,
          token_count  INTEGER,
          meta_json    TEXT NOT NULL DEFAULT '{}',
          created_at   TEXT NOT NULL,
          UNIQUE (document_id, seq)
        );

        -- 记忆条目（核心）：类型 / 范围 / importance / confidence / 来源
        -- 三层正交状态（Q104）：experience_phase（Q40）、temporal_state（Q82）
        -- lifecycle_status 为扩展位（全局 7 态未恢复，暂不限值，见 v1.1/Q106）
        CREATE TABLE IF NOT EXISTS memory_items (
          id                TEXT PRIMARY KEY,
          type              TEXT NOT NULL CHECK (type IN
            ('personal','project_knowledge','experience','negative','generalized')),
          scope             TEXT NOT NULL CHECK (scope IN
            ('session','project','global','generalized')),
          project_id        TEXT,
          content           TEXT NOT NULL,
          importance        TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN
            ('critical','high','normal','low','disposable')),
          confidence        REAL NOT NULL DEFAULT 0.5,
          source_kind       TEXT NOT NULL DEFAULT 'derived' CHECK (source_kind IN
            ('explicit','user-edited','derived','inferred')),

          -- Q104 三层正交状态
          experience_phase  TEXT CHECK (experience_phase IN
            ('candidate','investigating','solution-found','verified','validated')),
          temporal_state    TEXT NOT NULL DEFAULT 'current' CHECK (temporal_state IN
            ('current','historical','planned','expired','uncertain','superseded')),
          lifecycle_status  TEXT,             -- 扩展位，值不限定

          user_edited       INTEGER NOT NULL DEFAULT 0,  -- 用户编辑锁定（Q047/Q050）
          hidden            INTEGER NOT NULL DEFAULT 0,  -- 隔离/抑制位（Q089 guard）

          -- 时间语义（Q082）
          observed_at       TEXT,
          valid_from        TEXT,
          valid_until       TEXT,
          last_verified_at  TEXT,
          last_used_at      TEXT,

          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_memory_scope ON memory_items(scope, temporal_state);
        CREATE INDEX IF NOT EXISTS ts_memory_type  ON memory_items(type, temporal_state);
        CREATE INDEX IF NOT EXISTS ts_memory_project ON memory_items(project_id);
        CREATE INDEX IF NOT EXISTS ts_memory_phase ON memory_items(experience_phase);

        -- 证据（Q028/Q029）：引用 Session/Event，保留最小证据摘要
        CREATE TABLE IF NOT EXISTS memory_evidence (
          id              TEXT PRIMARY KEY,
          memory_id       TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          kind            TEXT NOT NULL DEFAULT 'session',
          session_ref     TEXT,
          event_ref       TEXT,
          evidence_ref    TEXT,
          evidence_summary TEXT,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_evidence_memory ON memory_evidence(memory_id);

        -- 血缘关系（Q076）扩展位：derived_from / merged_from / ... / related_to
        CREATE TABLE IF NOT EXISTS memory_lineage (
          id            TEXT PRIMARY KEY,
          memory_id     TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          relation      TEXT NOT NULL CHECK (relation IN
            ('derived_from','merged_from','supported_by','validated_by',
             'supersedes','contradicts','generalized_from','related_to')),
          other_memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          note          TEXT,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_lineage_memory ON memory_lineage(memory_id);

        -- 审计日志（Q049）：重要记忆变化必须进入 Audit Log
        CREATE TABLE IF NOT EXISTS audit_log (
          id          TEXT PRIMARY KEY,
          ts          TEXT NOT NULL,
          actor       TEXT NOT NULL,
          action      TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id   TEXT NOT NULL,
          before_json TEXT,
          after_json  TEXT
        );
        CREATE INDEX IF NOT EXISTS ts_audit_entity ON audit_log(entity_type, entity_id);

        -- 事件表位（Q100/Q101/Q103）：Event Log / Replay 的基础，R6 完整落地
        CREATE TABLE IF NOT EXISTS events (
          id              TEXT PRIMARY KEY,
          ts              TEXT NOT NULL,
          event_type      TEXT NOT NULL,
          payload_json    TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT UNIQUE,
          status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
            ('queued','processing','done','dead')),
          attempts        INTEGER NOT NULL DEFAULT 0,
          last_error      TEXT
        );
        CREATE INDEX IF NOT EXISTS ts_events_status ON events(status, ts);
      `);
    },
  },
  {
    version: 2,
    name: "memory-items-version",
    up(db) {
      // 幂等：ALTER TABLE 无 IF NOT EXISTS，先查列存在性再补。
      const cols = db
        .prepare("PRAGMA table_info(memory_items)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "version")) {
        db.exec(
          "ALTER TABLE memory_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;",
        );
      }
    },
  },
  {
    version: 3,
    name: "memory-items-fts5",
    up(db) {
      // 关键词检索（R3）：content 全文索引；memory_id 仅关联不参与匹配。
      // trigram tokenizer 对中英文子串匹配均友好（SQLite ≥3.34）。
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
          memory_id UNINDEXED,
          content,
          tokenize='trigram'
        );
      `);
    },
  },
  {
    version: 4,
    name: "r5-domains",
    up(db) {
      const addColumn = (name: string, ddl: string) => {
        const cols = db
          .prepare("PRAGMA table_info(memory_items)")
          .all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE memory_items ADD COLUMN ${ddl};`);
      };
      addColumn("summary", "summary TEXT");
      addColumn(
        "profile_category",
        "profile_category TEXT CHECK (profile_category IN ('preference','fact','skill','goal','constraint','working_style'))",
      );
      addColumn("utility", "utility REAL NOT NULL DEFAULT 0.5");

      // Experience 结构化明细（R5，Q036–Q065）：first-class，禁止退化为 content 字符串。
      // 嵌套集合（symptoms / failed_attempts / applicability / technologies）以 JSON 文本列保存。
      db.exec(`
        CREATE TABLE IF NOT EXISTS experience_details (
          memory_id          TEXT PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
          problem            TEXT NOT NULL,
          context            TEXT NOT NULL DEFAULT '',
          symptoms_json      TEXT NOT NULL DEFAULT '[]',
          root_cause         TEXT NOT NULL DEFAULT '',
          failed_attempts_json TEXT NOT NULL DEFAULT '[]',
          solution           TEXT NOT NULL DEFAULT '',
          verification       TEXT NOT NULL DEFAULT '',
          validation         TEXT NOT NULL DEFAULT '',
          applicability_json TEXT NOT NULL DEFAULT '[]',
          lesson             TEXT NOT NULL DEFAULT '',
          technologies_json  TEXT NOT NULL DEFAULT '[]',
          environment        TEXT NOT NULL DEFAULT '',
          updated_at         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_exp_tech ON experience_details(technologies_json);

        -- 用户反馈学习（R5，Q58/Q65）：显式记录 before/after，杜绝“只记录不改变排序”。
        CREATE TABLE IF NOT EXISTS feedback_events (
          id                TEXT PRIMARY KEY,
          memory_id         TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          kind              TEXT NOT NULL CHECK (kind IN
            ('confirm','deny','solved','not_helpful','obsolete')),
          note              TEXT,
          confidence_before REAL NOT NULL,
          confidence_after  REAL NOT NULL,
          utility_before    REAL NOT NULL,
          utility_after     REAL NOT NULL,
          actor             TEXT NOT NULL,
          created_at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_feedback_memory ON feedback_events(memory_id);

        -- 冲突评审（R5，Q096/Q097）：relation 为关系分类，resolution 为人工/自动决定。
        CREATE TABLE IF NOT EXISTS conflict_reviews (
          id            TEXT PRIMARY KEY,
          memory_a_id   TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          memory_b_id   TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          relation      TEXT NOT NULL CHECK (relation IN
            ('same_fact','same_event','different_event','shared_pattern',
             'parent_child','supplement','contradiction')),
          basis         TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN
            ('open','resolved','discarded')),
          resolution    TEXT CHECK (resolution IN
            ('merge','link','supersede','keep_separate')),
          decision_note TEXT,
          actor         TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          decided_at    TEXT
        );
        CREATE INDEX IF NOT EXISTS ts_conflict_pair ON conflict_reviews(memory_a_id, memory_b_id);
        CREATE INDEX IF NOT EXISTS ts_conflict_status ON conflict_reviews(status, created_at);
      `);
    },
  },
  {
    version: 5,
    name: "r5-project-knowledge-category",
    up(db) {
      // Project Knowledge 四类（R5 数据模型补正）：architecture/decision/dependency/current_issue
      const cols = db
        .prepare("PRAGMA table_info(memory_items)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "project_category")) {
        db.exec(
          "ALTER TABLE memory_items ADD COLUMN project_category TEXT CHECK (project_category IN ('architecture','decision','dependency','current_issue'));",
        );
        db.exec(
          "CREATE INDEX IF NOT EXISTS ts_memory_project_category ON memory_items(project_id, project_category);",
        );
      }
    },
  },
  {
    version: 6,
    name: "r6-durable-events-worker",
    up(db) {
      // events 表升级为 Durable Outbox/Queue（Q100/Q101/Q103）：补齐聚合标识、
      // 实体版本、下次可执行时间、认领租约、处理完成时间与结构化错误。
      const eventCols = db
        .prepare("PRAGMA table_info(events)")
        .all() as Array<{ name: string }>;
      const addEventCol = (name: string, ddl: string) => {
        if (!eventCols.some((c) => c.name === name)) {
          db.exec(`ALTER TABLE events ADD COLUMN ${ddl};`);
        }
      };
      addEventCol("memory_id", "memory_id TEXT");
      addEventCol("entity_version", "entity_version INTEGER");
      addEventCol("next_attempt_at", "next_attempt_at TEXT");
      addEventCol("claimed_at", "claimed_at TEXT");
      addEventCol("processed_at", "processed_at TEXT");
      addEventCol("error_json", "error_json TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS ts_events_queue ON events(status, next_attempt_at);");
      db.exec("CREATE INDEX IF NOT EXISTS ts_events_entity ON events(memory_id, event_type);");

      // 版本感知的 Memory Cache（Q059/Q100）：持久化结果缓存，指纹含 query/scope/project/
      // embedding 模型/记忆版本集合/检索实现版本。失效通过指纹变化或显式删除。
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_cache (
          cache_key       TEXT PRIMARY KEY,
          query           TEXT NOT NULL,
          scope           TEXT NOT NULL DEFAULT 'global',
          project_id      TEXT,
          fingerprint     TEXT NOT NULL,
          payload_json    TEXT NOT NULL,
          embedding_model TEXT,
          hits            INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_cache_fp ON memory_cache(fingerprint, updated_at);
      `);

      // 系统元数据（全局版本水位：cache 失效、检索实现版本、事件水位等）
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_meta (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // Snapshot / Replay / Backup / Restore / 后台作业 的作业账本（Q103）
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_jobs (
          job_id      TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN
            ('running','succeeded','failed','cancelled')),
          ref_json    TEXT NOT NULL DEFAULT '{}',
          result_json TEXT,
          error       TEXT,
          attempts    INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_jobs_kind ON system_jobs(kind, created_at);

        CREATE TABLE IF NOT EXISTS snapshots (
          snapshot_id      TEXT PRIMARY KEY,
          kind             TEXT NOT NULL CHECK (kind IN ('full','incremental')),
          path             TEXT NOT NULL,
          source_path      TEXT NOT NULL,
          event_count      INTEGER NOT NULL DEFAULT 0,
          event_high_water TEXT,
          size_bytes       INTEGER NOT NULL DEFAULT 0,
          verified         INTEGER NOT NULL DEFAULT 0,
          note             TEXT,
          created_at       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_snapshots ON snapshots(created_at);

        CREATE TABLE IF NOT EXISTS backups (
          backup_id      TEXT PRIMARY KEY,
          kind           TEXT NOT NULL DEFAULT 'full',
          path           TEXT NOT NULL,
          source_path    TEXT NOT NULL,
          schema_version INTEGER,
          checksum       TEXT,
          size_bytes     INTEGER NOT NULL DEFAULT 0,
          verified       INTEGER NOT NULL DEFAULT 0,
          note           TEXT,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_backups ON backups(created_at);

        CREATE TABLE IF NOT EXISTS generalized_meta (
          pattern_id        TEXT PRIMARY KEY,
          generalized_from  TEXT NOT NULL DEFAULT '[]',
          supported_by      TEXT NOT NULL DEFAULT '[]',
          validated_by      TEXT NOT NULL DEFAULT '[]',
          evidence_count    INTEGER NOT NULL DEFAULT 0,
          avg_confidence    REAL NOT NULL DEFAULT 0,
          status            TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN
            ('candidate','validated','promoted')),
          created_at        TEXT NOT NULL,
          promoted_at       TEXT
        );

        CREATE TABLE IF NOT EXISTS replay_runs (
          run_id            TEXT PRIMARY KEY,
          mode              TEXT NOT NULL CHECK (mode IN ('dry-run','rebuild')),
          events_processed  INTEGER NOT NULL DEFAULT 0,
          failures          INTEGER NOT NULL DEFAULT 0,
          status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN
            ('running','succeeded','failed')),
          report_json       TEXT NOT NULL DEFAULT '{}',
          started_at        TEXT NOT NULL,
          finished_at       TEXT
        );
        CREATE INDEX IF NOT EXISTS ts_replay_runs ON replay_runs(started_at);
      `);
    },
  },
  {
    version: 7,
    name: "r6-reliability-validation",
    up(db) {
      const hasCol = (table: string, col: string): boolean =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
          (c) => c.name === col,
        );
      // 快照/备份清单补齐一致性元数据（既有行回填 NULL，校验层按当前库重算）。
      if (!hasCol("snapshots", "schema_version")) {
        db.exec("ALTER TABLE snapshots ADD COLUMN schema_version INTEGER");
      }
      if (!hasCol("snapshots", "checksum")) {
        db.exec("ALTER TABLE snapshots ADD COLUMN checksum TEXT");
      }
      if (!hasCol("snapshots", "memory_count")) {
        db.exec("ALTER TABLE snapshots ADD COLUMN memory_count INTEGER");
      }
      if (!hasCol("backups", "event_count")) {
        db.exec("ALTER TABLE backups ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasCol("backups", "event_high_water")) {
        db.exec("ALTER TABLE backups ADD COLUMN event_high_water TEXT");
      }
      db.exec(`
        -- 遥测：预算决策/检索档位/生命周期/worker 状态等结构化记录（Q057/Q095）。
        CREATE TABLE IF NOT EXISTS telemetry (
          id         TEXT PRIMARY KEY,
          ts         TEXT NOT NULL,
          kind       TEXT NOT NULL,
          key        TEXT NOT NULL,
          value_json TEXT NOT NULL DEFAULT '{}',
          actor      TEXT NOT NULL DEFAULT 'system'
        );
        CREATE INDEX IF NOT EXISTS ts_telemetry_kind ON telemetry(kind, ts);
        -- 连续校验运行台账（Q050/Q081/Q092）。
        CREATE TABLE IF NOT EXISTS validation_runs (
          run_id      TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,
          actor       TEXT NOT NULL,
          scanned     INTEGER NOT NULL DEFAULT 0,
          changed     INTEGER NOT NULL DEFAULT 0,
          events      INTEGER NOT NULL DEFAULT 0,
          skipped     INTEGER NOT NULL DEFAULT 0,
          dry_run     INTEGER NOT NULL DEFAULT 0,
          status      TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN
            ('succeeded','failed')),
          report_json TEXT NOT NULL DEFAULT '{}',
          started_at  TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS ts_validation_runs ON validation_runs(started_at);
      `);
    },
  },
  {
    version: 8,
    name: "benchmark_runs",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS benchmark_runs (
          run_id       TEXT PRIMARY KEY,
          kind         TEXT NOT NULL DEFAULT 'benchmark',
          config_json  TEXT NOT NULL,
          results_json TEXT NOT NULL,
          summary_json TEXT NOT NULL DEFAULT '{}',
          started_at   TEXT NOT NULL,
          finished_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ts_benchmark_runs ON benchmark_runs(started_at DESC);
      `);
    },
  },
];

/**
 * 应用所有未应用迁移。幂等且可重入：
 *  - schema_migrations 记录已应用版本；
 *  - 迁移体 DDL 全部 IF NOT EXISTS，可在残留对象上补齐而非报错；
 *  - 整批迁移在单事务内，中途失败回滚，不会留下半应用版本记录。
 */
export function migrate(db: SqlDatabase): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRow = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number | null };
  const current = appliedRow.v ?? 0;
  if (MIGRATIONS.every((m) => m.version <= current)) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      m.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.version, m.name, iso());
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
