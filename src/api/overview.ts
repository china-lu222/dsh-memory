/**
 * Memory Center 总览 API（R7）：仪表盘聚合。只读。
 */

import { attempt, type Result } from "./common.js";
import type { ApiContext } from "./context.js";
import {
  countByDimension,
  countRows,
  listAuditRows,
  type AuditRowView,
  type DimensionCount,
} from "./reads.js";

export interface ConflictStatusCounts {
  open: number;
  resolved: number;
  discarded: number;
}

export interface DashboardOverview {
  memory: {
    total: number;
    active: number;
    quarantinedPending: number;
    archived: number;
    byScope: DimensionCount[];
    byType: DimensionCount[];
    bySource: DimensionCount[];
    byTemporal: DimensionCount[];
  };
  experience: {
    active: number;
    byPhase: DimensionCount[];
  };
  review: {
    conflicts: ConflictStatusCounts;
    quarantinePending: number;
  };
  activity: AuditRowView[];
}

const ACTIVE_WHERE = "hidden = 0 AND temporal_state != 'historical'";

export function dashboardOverview(ctx: ApiContext): Result<DashboardOverview> {
  return attempt(() => {
    const { db } = ctx;
    const active = countRows(db, "memory_items", ACTIVE_WHERE);
    const quarantinedPending = countRows(
      db,
      "memory_items",
      "hidden = 1 AND temporal_state != 'historical'",
    );
    const archived = countRows(db, "memory_items", "temporal_state = 'historical'");
    const total = countRows(db, "memory_items");
    const conflicts = conflictStatusCounts(db);
    const experienceActive = countRows(
      db,
      "memory_items",
      `type = 'experience' AND ${ACTIVE_WHERE}`,
    );
    return {
      memory: {
        total,
        active,
        quarantinedPending,
        archived,
        byScope: countByDimension(db, "memory_items", "scope", ACTIVE_WHERE),
        byType: countByDimension(db, "memory_items", "type", ACTIVE_WHERE),
        bySource: countByDimension(db, "memory_items", "source_kind", ACTIVE_WHERE),
        byTemporal: countByDimension(db, "memory_items", "temporal_state", ACTIVE_WHERE),
      },
      experience: {
        active: experienceActive,
        byPhase: countByDimension(
          db,
          "memory_items",
          "experience_phase",
          `type = 'experience' AND ${ACTIVE_WHERE}`,
        ),
      },
      review: {
        conflicts,
        quarantinePending: quarantinedPending,
      },
      activity: listAuditRows(db, { limit: 12 }),
    };
  });
}

export function conflictStatusCounts(db: Parameters<typeof countRows>[0]): ConflictStatusCounts {
  const rows = db
    .prepare("SELECT status AS s, COUNT(*) AS c FROM conflict_reviews GROUP BY status")
    .all() as unknown as Array<{ s: string; c: number }>;
  const counts: ConflictStatusCounts = { open: 0, resolved: 0, discarded: 0 };
  for (const row of rows) {
    if (row.s === "open") counts.open = Number(row.c);
    else if (row.s === "resolved") counts.resolved = Number(row.c);
    else if (row.s === "discarded") counts.discarded = Number(row.c);
  }
  return counts;
}
