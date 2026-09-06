// Vector search switch persistence for the Memory Center page.
//
// The vector host is assembled once during startup from the host config, so the
// page toggle cannot rewire it while the process runs. The toggle instead
// records an intent into <storeDir>/vector-ui.json; the next startup merge
// prefers that file over the host config. Until the host restarts, the page
// advertises that the switch needs a restart to take effect.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** UI override file name, stored next to the memory database. */
export const VECTOR_UI_OVERRIDE_FILE = "vector-ui.json";

/** Persisted switch intent written by the Memory Center page. */
export interface VectorUiOverride {
  /** Desired vector-search enabled state for the next startup. */
  enabled: boolean;
}

function overrideFile(storeDir: string): string {
  return join(storeDir, VECTOR_UI_OVERRIDE_FILE);
}

/**
 * Reads the persisted UI override.
 *
 * @returns the override, or null when the file is absent or malformed; a
 *   malformed file is ignored instead of failing startup, falling back to the
 *   host config.
 */
export function readVectorUiOverride(storeDir: string): VectorUiOverride | null {
  let raw: string;
  try {
    raw = readFileSync(overrideFile(storeDir), "utf8");
  } catch {
    return null; // absent file: host config decides
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt content: ignore and fall back to host config
  }
  const enabled = (parsed as { enabled?: unknown } | null)?.enabled;
  return typeof enabled === "boolean" ? { enabled } : null;
}

/**
 * Persists a UI switch intent for the next startup.
 *
 * @returns the stored override.
 */
export function writeVectorUiOverride(storeDir: string, enabled: boolean): VectorUiOverride {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    join(storeDir, VECTOR_UI_OVERRIDE_FILE),
    `${JSON.stringify({ enabled }, null, 2)}\n`,
    "utf8",
  );
  return { enabled };
}

/**
 * Removes the persisted UI override so the host config decides again.
 */
export function clearVectorUiOverride(storeDir: string): void {
  rmSync(join(storeDir, VECTOR_UI_OVERRIDE_FILE), { force: true });
}
