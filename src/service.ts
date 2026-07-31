import { createHash } from 'crypto';
import type { CrashReport, CrashReportInput } from './model.js';
import * as store from './store.js';
import { config } from './config.js';
import { symbolicateUnityCrash } from './symbolication/service.js';
import { notifyAlert } from './notification/service.js';

/**
 * Compute a crash hash from exception type, first stack frame, and runtime.
 * This groups similar crashes together for deduplication.
 * Including runtime ensures that Unity crashes don't merge with Node.js crashes
 * even if they have the same exception type.
 */
export function computeCrashHash(input: CrashReportInput): string {
  const firstFrame = extractFirstFrame(input.stack_trace ?? '', input.runtime);
  const projectPart = input.project_name ? `|${input.project_name.trim().toLocaleLowerCase()}` : '';
  const content = `${input.exception_type}|${firstFrame}|${input.runtime ?? 'generic'}${projectPart}`;
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Extract the first meaningful stack frame for crash grouping.
 * Uses runtime-specific patterns when available, with universal fallbacks.
 */
function extractFirstFrame(stackTrace: string, runtime?: string): string {
  if (!stackTrace.trim()) return 'no-stack';

  const lines = stackTrace.split('\n');

  // Try runtime-specific patterns first
  if (runtime) {
    const patterns: Record<string, RegExp> = {
      node: /\s+at\s+(\S+)\s+\(/,             // Node.js: "    at Server.fn (file:10:5)"
      browser: /\s+at\s+(\S+)\s+\(/,           // Browser JS: same format
      python: /File\s+"(.+?)",\s+line\s+\d+,\s+in\s+(\w+)/, // Python traceback
      go: /([\w.\/-]+)\.(\w+)\(/,              // Go: "pkg/subpkg.Func(args)"
    };
    const pattern = patterns[runtime];
    if (pattern) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(pattern);
        if (m) {
          // Return the most specific part
          return runtime === 'python' ? (m[2] || m[1]) : (m[1] || m[0]);
        }
      }
    }
  }

  // Universal fallback: try common patterns
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // "at Class.Method ()" — Unity / C#
    const atMatch = trimmed.match(/at\s+([\w.<>]+)\s*\(/);
    if (atMatch) return atMatch[1];

    // "  at functionName (file:line)" — Node.js / Browser
    const nodeMatch = trimmed.match(/\s+at\s+(\S+)\s+\(/);
    if (nodeMatch) return nodeMatch[1];

    // "Class::Method" — Android native / C++
    const nativeMatch = trimmed.match(/\(([\w:]+)(\+\d+)?\)/);
    if (nativeMatch) return nativeMatch[1];

    // "File path/to/file.py", line N, in func — Python
    const pyMatch = trimmed.match(/File\s+"(.+?)",\s+line\s+\d+,\s+in\s+(\w+)/);
    if (pyMatch) return pyMatch[2];

    // "pkg.Func(...)" — Go
    const goMatch = trimmed.match(/^(\S+)\.(\S+)\(/);
    if (goMatch) return `${goMatch[1]}.${goMatch[2]}`;
  }

  // Final fallback: first non-empty line, truncated
  return lines.find(l => l.trim())?.trim().substring(0, 120) ?? 'no-stack';
}

/**
 * Ingest a crash report: find or create a group, create the report, return both.
 * If input.runtime is not set, automatically attempts to detect from the runtime_version
 * or platform context.
 */
export async function ingestCrash(
  input: CrashReportInput,
  clientIp: string,
  now: string,
  dumpInfo: string = ''
): Promise<{ report: CrashReport; groupId: number; isNewGroup: boolean }> {
  // Auto-detect runtime if not specified
  if (!input.runtime) {
    if (input.unity_version) {
      input.runtime = 'unity';
    } else if (input.runtime_version?.includes('node') || input.runtime_version?.match(/^v\d+/)) {
      input.runtime = 'node';
    }
  }

  // Use client timestamp if provided, otherwise server time
  const effectiveTime = input.client_timestamp ?? now;
  const projectName = input.project_name?.trim() || '';
  const project = projectName ? store.getOrCreateProject(projectName, now) : undefined;
  if (project) input.project_name = project.name;

  const symbolication = await symbolicateUnityCrash(input);
  const groupingInput = symbolication.method
    ? { ...input, stack_trace: symbolication.method }
    : input;

  const hash = computeCrashHash(groupingInput);

  let group = store.findGroupByHash(hash);
  let isNewGroup = false;

  if (group) {
    store.updateGroupOnNewReport(group.id, effectiveTime);
    group = store.getGroupById(group.id)!;
  } else {
    group = store.createGroup(
      hash,
      input.exception_type,
      input.exception_message ?? '',
      effectiveTime,
      project?.id ?? null
    );
    isNewGroup = true;
  }

  const report = store.createReport(input, group.id, clientIp, now, dumpInfo, project?.id ?? null);
  if (input.runtime === 'unity') {
    store.updateReportSymbolication(report.id, symbolication);
  }

  const savedReport = store.getReportById(report.id)!;
  if (isNewGroup && config.alertOnNewGroup) {
    void notifyAlert({ type: 'new_group', group, report: savedReport, symbolicatedMethod: symbolication.method });
  } else if (
    config.alertThresholdCount > 0 &&
    group.total_count === config.alertThresholdCount
  ) {
    void notifyAlert({ type: 'threshold_reached', group, report: savedReport, symbolicatedMethod: symbolication.method });
  }

  return { report: savedReport, groupId: group.id, isNewGroup };
}
