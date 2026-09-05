/**
 * MarkdownProjectionService：DB ↔ MD 双向同步（R2）。
 *
 * - DB → MD：resyncAll() 全量重建 + 订阅 store 事件增量投影。
 * - MD → DB：adoptFile()/scanAndAdopt() 读取用户编辑的 MD 回写 store。
 * - 归档/恢复：文件在 live 路径与 archive/ 路径之间迁移。
 * - 孤儿清理：resyncAll 删除不再对应的 .md 文件（重启后投影一致）。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { subscribeMemoryEvents, type MemoryEvent } from "../store/events.js";
import {
  getMemoryItemById,
  listAllMemoryItems,
  type MemoryItemRow,
} from "../store/repository.js";
import type { SqlDatabase } from "../store/sqlite.js";
import { adoptMemoryFile, type AdoptResult } from "./adopt.js";
import {
  archivedPathFor,
  livePathFor,
  pathFor,
} from "./markdown.js";
import { renderMemoryFile } from "./render.js";

export class MarkdownProjectionService {
  readonly root: string;
  private readonly db: SqlDatabase;
  private unsubscribe: (() => void) | undefined;

  constructor(db: SqlDatabase, root: string) {
    this.db = db;
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  private abs(rel: string): string {
    return join(this.root, rel);
  }

  /** 写一个投影文件（自动建目录）。 */
  writeFile(rel: string, content: string): void {
    const abs = this.abs(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  private removeFile(rel: string): void {
    const abs = this.abs(rel);
    if (existsSync(abs)) rmSync(abs, { force: true });
  }

  /** 写单个记忆的投影文件（当前应处路径）。 */
  project(row: MemoryItemRow): void {
    this.writeFile(livePathFor(row), renderMemoryFile(row));
  }

  /** 列出 markdown 根下所有 .md 相对路径（正斜杠）。 */
  listMdFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) walk(abs);
        else if (ent.isFile() && ent.name.endsWith(".md")) {
          out.push(relative(this.root, abs).split("\\").join("/"));
        }
      }
    };
    walk(this.root);
    return out;
  }

  /** DB → MD 全量重建，并清理不再对应的孤儿文件。 */
  resyncAll(): void {
    const rows = listAllMemoryItems(this.db);
    const expected = new Set<string>();
    for (const row of rows) {
      const rel = livePathFor(row);
      expected.add(rel);
      this.writeFile(rel, renderMemoryFile(row));
    }
    for (const rel of this.listMdFiles()) {
      if (!expected.has(rel)) this.removeFile(rel);
    }
  }

  /** store 事件 → 增量投影；归档/恢复时迁移文件位置。 */
  private onEvent(e: MemoryEvent): void {
    const row = getMemoryItemById(this.db, e.memoryId);
    if (row === null) return;
    const current = livePathFor(row);
    const other = current === pathFor(row) ? archivedPathFor(row) : pathFor(row);
    this.removeFile(other);
    this.project(row);
  }

  /** 单文件采纳（MD → DB）。 */
  adoptFile(rel: string, text: string): AdoptResult {
    return adoptMemoryFile(this.db, rel, text);
  }

  /** MD → DB 全量对比采纳：扫描所有 md 文件，与投影不一致者回写。 */
  scanAndAdopt(): AdoptResult[] {
    const results: AdoptResult[] = [];
    for (const rel of this.listMdFiles()) {
      const text = readFileSync(this.abs(rel), "utf8");
      results.push(adoptMemoryFile(this.db, rel, text));
    }
    return results;
  }

  /** 启动：先采纳 MD 侧未同步的用户编辑，再全量投影，最后订阅事件。 */
  start(): void {
    // 顺序关键：先 MD → DB（保留用户离线编辑），再 DB → MD（补齐/清理）。
    this.scanAndAdopt();
    this.resyncAll();
    this.unsubscribe = subscribeMemoryEvents((e) => this.onEvent(e));
  }

  /** 停止：取消订阅。 */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
