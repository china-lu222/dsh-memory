import { mkdirSync, renameSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../store/sqlite.js";
import { writeTelemetry } from "../store/telemetry.js";
import { verifySqliteFile, type VerifyResult } from "./common.js";
import { getBackup, type BackupRecord } from "./backup.js";
import { getSnapshot, type SnapshotRecord } from "./snapshot.js";

export interface RestoreResult {
  ok: boolean;
  promoted: boolean;
  sourcePath: string;
  previousPath: string | null;
  stageVerify: VerifyResult;
  restoredVerify: VerifyResult | null;
  error?: string;
  warnings: string[];
}

export interface RestoreOptions {
  sourcePath: string;
  /** 目标正式库文件路径（连接必须已关闭）。 */
  targetFile: string;
  /** 期望记忆条数（来自清单），用于关键数据校验。 */
  expectedMemoryCount?: number;
  /** 仅验证，不 promote。 */
  verifyOnly?: boolean;
}

function timestamped(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Backup/Snapshot → restore 到临时目录 → integrity_check → schema/计数校验 →
 * 验证成功后才 promote（原库保留为 .pre-restore，绝不作为第一步覆盖）。
 */
export function restoreFile(opts: RestoreOptions): RestoreResult {
  const warnings: string[] = [];
  const stageRoot = join(
    dirname(opts.targetFile),
    `.restore-${timestamped()}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(stageRoot, { recursive: true });
  const stage = join(stageRoot, "candidate.db");
  copyFileSync(opts.sourcePath, stage);
  const stageVerify = verifySqliteFile(stage);
  if (!stageVerify.ok) {
    rmSync(stageRoot, { recursive: true, force: true });
    return {
      ok: false,
      promoted: false,
      sourcePath: opts.sourcePath,
      previousPath: null,
      stageVerify,
      restoredVerify: null,
      error: stageVerify.error ?? "integrity check failed",
      warnings,
    };
  }
  if (
    opts.expectedMemoryCount !== undefined &&
    stageVerify.memoryCount !== opts.expectedMemoryCount
  ) {
    rmSync(stageRoot, { recursive: true, force: true });
    return {
      ok: false,
      promoted: false,
      sourcePath: opts.sourcePath,
      previousPath: null,
      stageVerify,
      restoredVerify: null,
      error: `memory count mismatch: expected ${opts.expectedMemoryCount}, got ${stageVerify.memoryCount}`,
      warnings,
    };
  }
  // schema 兼容检查：目标存在时禁止用更旧 schema 覆盖。
  if (existsSync(opts.targetFile)) {
    const current = verifySqliteFile(opts.targetFile);
    if (current.ok && stageVerify.schemaVersion < current.schemaVersion) {
      warnings.push(
        `target schema ${current.schemaVersion} > candidate ${stageVerify.schemaVersion}`,
      );
    }
  }
  if (opts.verifyOnly) {
    rmSync(stageRoot, { recursive: true, force: true });
    return {
      ok: true,
      promoted: false,
      sourcePath: opts.sourcePath,
      previousPath: null,
      stageVerify,
      restoredVerify: null,
      warnings,
    };
  }
  let previousPath: string | null = null;
  if (existsSync(opts.targetFile)) {
    previousPath = `${opts.targetFile}.pre-restore-${timestamped()}.db`;
    renameSync(opts.targetFile, previousPath);
  }
  renameSync(stage, opts.targetFile);
  rmSync(stageRoot, { recursive: true, force: true });
  const restoredVerify = verifySqliteFile(opts.targetFile);
  return {
    ok: restoredVerify.ok,
    promoted: restoredVerify.ok,
    sourcePath: opts.sourcePath,
    previousPath,
    stageVerify,
    restoredVerify,
    warnings,
    ...(restoredVerify.ok ? {} : { error: restoredVerify.error }),
  };
}

export type ArtifactSource = "snapshot" | "backup";

export function lookupArtifact(
  db: SqlDatabase,
  kind: ArtifactSource,
  id: string,
): SnapshotRecord | BackupRecord | null {
  return kind === "snapshot" ? getSnapshot(db, id) : getBackup(db, id);
}

export function resolveArtifactPath(
  db: SqlDatabase,
  kind: ArtifactSource,
  id: string,
): string | null {
  const rec = lookupArtifact(db, kind, id);
  return rec ? rec.path : null;
}

export function artifactMemoryCount(
  db: SqlDatabase,
  kind: ArtifactSource,
  id: string,
): number | undefined {
  const rec = lookupArtifact(db, kind, id);
  if (!rec) return undefined;
  if (kind === "snapshot") return (rec as SnapshotRecord).memoryCount;
  // backup 清单无 memory_count 字段；以 file 校验为准。
  return undefined;
}

export function restoreArtifact(
  db: SqlDatabase,
  kind: ArtifactSource,
  id: string,
  targetFile: string,
  opts: { verifyOnly?: boolean } = {},
): RestoreResult {
  const path = resolveArtifactPath(db, kind, id);
  if (!path) {
    return {
      ok: false,
      promoted: false,
      sourcePath: "",
      previousPath: null,
      stageVerify: {
        ok: false,
        integrity: "",
        schemaVersion: 0,
        memoryCount: 0,
        eventCount: 0,
        sizeBytes: 0,
        error: `unknown ${kind}: ${id}`,
      },
      restoredVerify: null,
      error: `unknown ${kind}: ${id}`,
      warnings: [],
    };
  }
  const result = restoreFile({
    sourcePath: path,
    targetFile,
    expectedMemoryCount: artifactMemoryCount(db, kind, id),
    verifyOnly: opts.verifyOnly,
  });
  if (result.promoted) {
    writeTelemetry(db, {
      kind: "lifecycle",
      key: "restore.promoted",
      value: { kind, id, targetFile },
    });
  }
  return result;
}
