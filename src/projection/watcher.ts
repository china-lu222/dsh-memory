/**
 * Markdown 目录文件监听：用户直接编辑投影文件时，经防抖触发回写。
 * fs.watch recursive（Windows/macOS 支持）。文件删除/抖动由 handler 容错。
 */

import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/**
 * 监听 markdown 根目录下的 .md 变化（防抖 100ms），变化后读取文件内容回调。
 * @returns 停止监听函数
 */
export function watchMemoryDir(
  root: string,
  onMdChange: (rel: string, text: string) => void,
): () => void {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    const rels = [...pending];
    pending.clear();
    for (const rel of rels) {
      let text: string;
      try {
        text = readFileSync(join(root, rel), "utf8");
      } catch {
        continue;
      }
      onMdChange(rel, text);
    }
  };

  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, filename) => {
    if (filename === null || !filename.endsWith(".md")) return;
    pending.add(filename.replace(/\\/g, "/"));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, 100);
  });

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    watcher.close();
  };
}
