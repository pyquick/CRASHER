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
  const firstFrame = extractFirstFrame(input.stack_trace ?? '', input.runtime);
  const projectPart = input.project_name ? `|${input.project_name.trim().toLocaleLowerCase()}` : '';
  const content = `${input.exception_type}|${firstFrame}|${input.runtime ?? 'generic'}${projectPart}`;
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function extractFirstFrame(stackTrace: string, runtime?: string): string {
  if (!stackTrace.trim()) return 'no-stack';

  const lines = stackTrace.split('\n');

  if (runtime) {
    const patterns: Record<string, RegExp> = {
      node: /\s+at\s+(\S+)\s+\(/,
      browser: /\s+at\s+(\S+)\s+\(/,
      python: /File\s+"(.+?)",\s+line\s+\d+,\s+in\s+(\w+)/,
      go: /([\w.\/-]+)\.(\w+)\(/,
    };
    const pattern = patterns[runtime];
    if (pattern) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(pattern);
        if (m) {
          return runtime === 'python' ? (m[2] || m[1]) : (m[1] || m[0]);
        }
      }
    }
  }

  // Universal fallback
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const atMatch = trimmed.match(/at\s+([\w.<>]+)\s*\(/);
    if (atMatch) return atMatch[1];

    const nodeMatch = trimmed.match(/\s+at\s+(\S+)\s+\(/);
    if (nodeMatch) return nodeMatch[1];

    const nativeMatch = trimmed.match(/\(([\w:]+)(\+\d+)?\)/);
    if (nativeMatch) return nativeMatch[1];

    const pyMatch = trimmed.match(/File\s+"(.+?)",\s+line\s+\d+,\s+in\s+(\w+)/);
    if (pyMatch) return pyMatch[2];

    const goMatch = trimmed.match(/^(\S+)\.(\S+)\(/);
    if (goMatch) return `${goMatch[1]}.${goMatch[2]}`;
  }

  return lines.find(l => l.trim())?.trim().substring(0, 120) ?? 'no-stack';
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
  const groupingInput = symbolication.method
    ? { ...input, stack_trace: symbolication.method }
    : input;

  const hash = computeCrashHash(groupingInput);
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
