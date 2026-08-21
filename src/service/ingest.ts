import { createHash } from 'crypto';
import type { CrashGroup, CrashReport, CrashReportInput } from '../model.js';
import type { SymbolicationResult } from '../symbolication/types.js';
import * as store from '../store.js';
import { config } from '../config.js';
import { symbolicateUnityCrash } from '../symbolication/service.js';
import { notifyAlert } from '../notification/service.js';

// ── Pipeline Stage 1: Runtime Detection ──

export function detectRuntime(input: CrashReportInput): void {
  if (input.runtime) return;
  if (input.unity_version) {
    input.runtime = 'unity';
  } else if (input.runtime_version?.includes('node') || input.runtime_version?.match(/^v\d+/)) {
    input.runtime = 'node';
  }
}

// ── Pipeline Stage 2: Project Resolution ──

export function resolveProject(
  projectName: string | undefined,
  now: string,
  containerId?: number | null
): { projectName: string; project?: { id: number; name: string } } {
  const name = projectName?.trim() || '';
  if (!name) return { projectName: '' };
  const project = store.getOrCreateProject(name, now, containerId ?? null);
  return { projectName: project.name, project };
}

// ── Pipeline Stage 3: Symbolication ──

export async function applySymbolication(
  input: CrashReportInput
): Promise<SymbolicationResult> {
  return symbolicateUnityCrash(input);
}

// ── Pipeline Stage 4: Hash Computation ──

export function computeCrashHash(input: CrashReportInput): string {
  // Only reports whose full stack trace content is identical (after trimming
  // surrounding whitespace) belong to the same group; a shared exception type
  // or first frame alone is not enough.
  const stackTrace = (input.stack_trace ?? '').trim() || 'no-stack';
  const projectPart = input.project_name ? `|${input.project_name.trim().toLocaleLowerCase()}` : '';
  const content = `${input.exception_type}|${stackTrace}|${input.runtime ?? 'generic'}${projectPart}`;
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

// ── Pipeline Stage 5: Group Upsert ──

export function upsertCrashGroup(
  hash: string,
  exceptionType: string,
  exceptionMessage: string,
  effectiveTime: string,
  projectId: number | null,
  containerId: number | null
): { group: CrashGroup; isNewGroup: boolean } {
  let group: CrashGroup | undefined = store.findGroupByHash(hash);
  let isNewGroup = false;

  if (group) {
    store.updateGroupOnNewReport(group.id, effectiveTime);
    group = store.getGroupById(group.id);
  } else {
    group = store.createGroup(hash, exceptionType, exceptionMessage, effectiveTime, projectId, containerId);
    isNewGroup = true;
  }

  return { group: group!, isNewGroup };
}

// ── Pipeline Stage 6: Report Creation ──

export function createCrashReport(
  input: CrashReportInput,
  groupId: number,
  clientIp: string,
  now: string,
  dumpInfo: string,
  projectId: number | null,
  containerId: number | null,
  symbolication: { stack?: string; status?: string; symbol_id?: number; frames?: unknown[]; warnings?: string[] }
): CrashReport {
  const report = store.createReport(input, groupId, clientIp, now, dumpInfo, projectId, containerId);
  if (input.runtime === 'unity') {
    store.updateReportSymbolication(report.id, {
      stack: symbolication.stack ?? '',
      status: symbolication.status ?? 'not_applicable',
      frames: (symbolication.frames ?? []) as unknown[],
      warnings: (symbolication.warnings ?? []) as string[],
    });
  }
  return store.getReportById(report.id)!;
}

// ── Pipeline Stage 7: Alert Notification ──

export function maybeAlert(
  isNewGroup: boolean,
  group: CrashGroup,
  savedReport: CrashReport,
  symbolicatedMethod?: string
): void {
  if (isNewGroup && config.alertOnNewGroup) {
    void notifyAlert({ type: 'new_group', group, report: savedReport, symbolicatedMethod });
  } else if (
    config.alertThresholdCount > 0 &&
    group.total_count === config.alertThresholdCount
  ) {
    void notifyAlert({ type: 'threshold_reached', group, report: savedReport, symbolicatedMethod });
  }
}

// ── Orchestrator ──

export async function ingestCrash(
  input: CrashReportInput,
  clientIp: string,
  now: string,
  dumpInfo: string = '',
  containerId?: number | null
): Promise<{ report: CrashReport; groupId: number; isNewGroup: boolean }> {
  detectRuntime(input);

  const effectiveTime = input.client_timestamp ?? now;
  const { projectName, project } = resolveProject(input.project_name, now, containerId);
  if (project) input.project_name = projectName;

  const symbolication = await applySymbolication(input);
  // Group by the full stack trace content as submitted; symbolication only
  // affects the displayed stack, never the grouping key.
  const hash = computeCrashHash(input);
  const { group, isNewGroup } = upsertCrashGroup(
    hash,
    input.exception_type,
    input.exception_message ?? '',
    effectiveTime,
    project?.id ?? null,
    containerId ?? null
  );

  const savedReport = createCrashReport(input, group.id, clientIp, now, dumpInfo, project?.id ?? null, containerId ?? null, symbolication);
  maybeAlert(isNewGroup, group, savedReport, symbolication.method);

  return { report: savedReport, groupId: group.id, isNewGroup };
}
