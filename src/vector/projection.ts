/**
 * VectorProjectionService（R4）：store 事件 → 向量索引的增量/全量投影。
 * 镜像 R2 MarkdownProjectionService 的宿主接线：启动时 resyncAll + 订阅事件；
 * 版本号去重（store.versionOf 与 memory_items.version 比对）保证重启后
 * 对未变更条目零重算（对远程 embedding 省成本）。
 *
 * 失败语义：单条 embedding 失败只计数并跳过，不阻断其余条目、不回滚
 * 已成功索引（投影的最终一致性在下次 resyncAll/事件时自愈）。
 */

import type { EmbeddingProvider } from "../embedding/provider.js";
import { subscribeMemoryEvents, type MemoryEvent } from "../store/events.js";
import {
  getMemoryItemById,
  listAllMemoryItems,
  type MemoryItemRow,
} from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import type { VectorStore } from "./types.js";

export interface VectorSyncReport {
  /** 应索引记忆总数（活跃条目；已归档不计） */
  total: number;
  /** 本次实际写入/更新的条数 */
  synced: number;
  /** 版本一致、已索引而跳过的条数 */
  skipped: number;
  /** 清理的失效索引条数 */
  removed: number;
  /** 失败（embedding 异常）条数 */
  failures: number;
  /** 索引当前规模 */
  storeCount: number;
  reasons: string[];
}

export class VectorProjectionService {
  private unsubscribe: (() => void) | undefined;
  private readonly inflight = new Map<string, Promise<void>>();
  private initialSync: Promise<VectorSyncReport> | undefined;
  private lastReport: VectorSyncReport | undefined;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: VectorStore,
    private readonly embedder: EmbeddingProvider,
  ) {}

  /** 最近一次全量对账报告（start/ensureReady 之后有值）。 */
  get lastSyncReport(): VectorSyncReport | undefined {
    return this.lastReport;
  }

  private async upsertRow(row: MemoryItemRow): Promise<void> {
    const key = row.id;
    const prior = this.inflight.get(key);
    if (prior !== undefined) {
      await prior;
      return;
    }
    const run = (async () => {
      const fresh = getMemoryItemById(this.db, row.id);
      if (fresh === null || fresh.temporalState === "historical") {
        this.store.remove(row.id);
        return;
      }
      const vec = await this.embedder.embedText(fresh.content);
      this.store.upsert(row.id, vec, fresh.version);
    })();
    this.inflight.set(key, run);
    try {
      await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  private onEvent(e: MemoryEvent): void {
    const row = getMemoryItemById(this.db, e.memoryId);
    if (row === null) {
      this.store.remove(e.memoryId);
      return;
    }
    if (row.temporalState === "historical") {
      this.store.remove(row.id);
      return;
    }
    void this.upsertRow(row).catch(() => {
      // 单条投影失败由后续事件/重启自愈，此处静默。
    });
  }

  /**
   * 全量重建（版本增量 + 失效清理）。
   * @param force 忽略版本号强制重算（模型迁移后由 store.clear() 配合使用）
   */
  async resyncAll(force = false): Promise<VectorSyncReport> {
    const report: VectorSyncReport = {
      total: 0,
      synced: 0,
      skipped: 0,
      removed: 0,
      failures: 0,
      storeCount: 0,
      reasons: [],
    };
    const health = this.store.health();
    if (!health.available) {
      report.reasons.push(health.reason ?? "vector store unavailable");
      return report;
    }
    const rows = listAllMemoryItems(this.db);
    // 已归档（historical）条目不索引：事件路径即时移除，此处由失效清理兜底，
    // 避免重启后的 resyncAll 把归档记忆重新写回向量索引。
    const active = rows.filter((r) => r.temporalState !== "historical");
    report.total = active.length;
    const want = new Set<string>();
    const existing = new Set(this.store.ids());
    for (const row of active) {
      want.add(row.id);
      const indexedVersion = this.store.versionOf(row.id);
      if (!force && existing.has(row.id) && indexedVersion === row.version) {
        report.skipped += 1;
        continue;
      }
      try {
        const vec = await this.embedder.embedText(row.content);
        this.store.upsert(row.id, vec, row.version);
        report.synced += 1;
      } catch (err) {
        report.failures += 1;
        report.reasons.push(`${row.id}: ${(err as Error).message}`);
      }
    }
    for (const id of existing) {
      if (!want.has(id)) {
        this.store.remove(id);
        report.removed += 1;
      }
    }
    report.storeCount = this.store.count();
    return report;
  }

  /** 启动：先订阅（同进程写入即时投影），再全量对账（补齐重启前缺失）。 */
  start(): void {
    this.unsubscribe = subscribeMemoryEvents((e) => this.onEvent(e));
    this.initialSync = this.resyncAll().then((report) => {
      this.lastReport = report;
      return report;
    });
    void this.initialSync.catch(() => {
      // 启动期索引失败不阻断宿主；reason 可由 health/config/ensureReady 观测。
    });
  }

  /**
   * 等待索引就绪（首次检索前的对账；含进行中的启动同步）。失败不抛出，
   * 由调用方读取 store health 决定是否走向量路径。
   */
  async ensureReady(): Promise<VectorSyncReport> {
    if (this.initialSync === undefined) {
      this.initialSync = this.resyncAll().then((report) => {
        this.lastReport = report;
        return report;
      });
    }
    return this.initialSync;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
