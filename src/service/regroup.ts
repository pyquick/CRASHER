import * as store from '../store.js';
import { computeCrashHash } from './ingest.js';
import type { ReportGroupingRow } from '../model.js';

export interface RegroupStats {
  reports_grouped: number;
  groups_created: number;
  groups_deleted: number;
}

interface HashEntry {
  hash: string;
  reports: ReportGroupingRow[];
}

// Recomputes group membership for every crash report using the current
// grouping rule (full stack trace content must be identical): previously
// merged groups whose reports have different stacks are split apart, and
// reports with identical stacks are merged. Idempotent — safe to run on
// every startup.
export function regroupCrashReports(): RegroupStats {
  const rows = store.listReportGroupingRows();
  const stats: RegroupStats = { reports_grouped: rows.length, groups_created: 0, groups_deleted: 0 };
  if (rows.length === 0) return stats;

  const entries = new Map<string, HashEntry>();
  for (const row of rows) {
    const hash = computeCrashHash({
      exception_type: row.exception_type,
      stack_trace: row.stack_trace,
      runtime: row.runtime || undefined,
      project_name: row.project_name ?? undefined,
    });
    let entry = entries.get(hash);
    if (!entry) {
      entry = { hash, reports: [] };
      entries.set(hash, entry);
    }
    entry.reports.push(row);
  }

  for (const entry of entries.values()) {
    try {
      regroupEntry(entry, stats);
    } catch (err) {
      console.error(`[regroup] skipping ${entry.hash}:`, err);
    }
  }

  stats.groups_deleted = store.deleteEmptyGroups();
  return stats;
}

function regroupEntry(entry: HashEntry, stats: RegroupStats): void {
  const reports = entry.reports;
  // Seed new groups from the newest report; client timestamps are ISO strings
  // (fall back to id so ordering stays stable on ties).
  const newest = reports.reduce((a, b) =>
    a.client_timestamp > b.client_timestamp ||
    (a.client_timestamp === b.client_timestamp && a.id > b.id) ? a : b
  );

  let group = store.findGroupByHash(entry.hash);
  if (!group) {
    group = store.createGroup(
      entry.hash,
      newest.exception_type,
      newest.exception_message,
      new Date().toISOString(),
      newest.project_id,
      newest.container_id
    );
    stats.groups_created++;
  }

  const times = reports.map(r => r.client_timestamp).sort();
  store.updateGroupStats(group.id, times[0], times[times.length - 1], reports.length);
  for (const report of reports) {
    store.updateReportGroup(report.id, group.id);
  }
}
