import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 插件根目录（源码 src/ 与产物 lib/ 均为同一深度，import.meta.url 上溯一层即可）。
 * 数据默认放插件根/data，与旧 JS 插件保持一致（memory.db 同文件升级）。
 */
export function pluginRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export interface StoreFileOptions {
  /** 数据目录：绝对路径或相对插件根的路径；缺省取 DSH_MEMORY_DATA_DIR 或 <插件根>/data */
  dataDir?: string;
  /** DB 文件名；缺省 memory.db（沿用旧插件文件名，同文件升级） */
  dbFile?: string;
}

/** 解析存储文件路径（CLI 与 Cordis 入口共用同一默认值，避免双库）。 */
export function resolveStoreFile(opts: StoreFileOptions = {}): string {
  const root = pluginRoot();
  const envDir = process.env.DSH_MEMORY_DATA_DIR;
  const base = opts.dataDir
    ? isAbsolute(opts.dataDir)
      ? opts.dataDir
      : join(root, opts.dataDir)
    : envDir
      ? isAbsolute(envDir)
        ? envDir
        : join(root, envDir)
      : join(root, "data");
  return join(base, opts.dbFile ?? "memory.db");
}
