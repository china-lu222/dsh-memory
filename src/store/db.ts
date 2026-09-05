import {
  runLegacyTakeover,
  validateTakeover,
  type LegacyTakeoverReport,
} from "./legacy.js";
import { migrate } from "./migrations.js";
import { openSqlite, type OpenedStore } from "./sqlite.js";

export interface DbConfig {
  /** SQLite 文件路径 */
  file: string;
}

export { type OpenedStore, type SqlDatabase } from "./sqlite.js";
export type { LegacyTakeoverReport } from "./legacy.js";

export interface OpenedStoreWithTakeover {
  store: OpenedStore;
  /** 旧 JS 插件存储的接管报告（detected=false 表示非旧库） */
  takeover: LegacyTakeoverReport;
}

/**
 * 打开（必要时初始化）Structured Memory Store，并返回旧库接管报告。
 *
 * 对旧 JS 插件（legacy-js/）的 memory.db 执行“同文件升级、安全迁移”（决策 B）：
 * 写 DDL 前先备份 + integrity_check + 记录 schema_version/旧表行数，迁移后校验旧表
 * 行数不变且新 schema 关键表齐全。旧表永不删除，保留为无损回滚底版。
 *
 * 驱动策略见 sqlite.ts（Q107）：better-sqlite3 主实现；node:sqlite 显式备用。
 */
export function openStoreWithTakeover(cfg: DbConfig): OpenedStoreWithTakeover {
  const opened = openSqlite(cfg.file);
  try {
    const takeover = runLegacyTakeover(opened.db, cfg.file);
    migrate(opened.db);
    validateTakeover(opened.db, takeover);
    return { store: opened, takeover };
  } catch (err) {
    opened.db.close();
    throw new Error(`存储迁移失败（${cfg.file}）：${(err as Error).message}`, {
      cause: err,
    });
  }
}

/** openStoreWithTakeover 的轻量封装（无需接管报告的调用方）。 */
export function openStore(cfg: DbConfig): OpenedStore {
  return openStoreWithTakeover(cfg).store;
}
