import { createHash } from 'crypto';
import type { CrashReport, CrashReportInput } from './model.js';
import * as store from './store.js';
import { config } from './config.js';

/**
 * Compute a crash hash from exception type and first stack frame.
 * This groups similar crashes together for deduplication.
 */
export function computeCrashHash(input: CrashReportInput): string {
  const firstFrame = extractFirstFrame(input.stack_trace ?? '');
  const content = `${input.exception_type}|${firstFrame}|${input.platform ?? ''}`;
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function extractFirstFrame(stackTrace: string): string {
  if (!stackTrace.trim()) return 'no-stack';

  // Unity stack format: "at Class.Method () [0x00000] in <path>:0"
  // Android: "#00  pc 0x...  libunity.so (Class::Method)"
  const lines = stackTrace.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match "at Class.Method" pattern
    const atMatch = trimmed.match(/at\s+([\w.<>]+)\s*\(/);
    if (atMatch) return atMatch[1];

    // Match "Class::Method" or "ClassName.MethodName" in native traces
    const nativeMatch = trimmed.match(/\(([\w:]+)(\+\d+)?\)/);
    if (nativeMatch) return nativeMatch[1];
  }

  // Fallback: return first non-empty line
  return lines[0].trim().substring(0, 120);
}

/**
 * Ingest a crash report: find or create a group, create the report, return both.
 */
export function ingestCrash(
  input: CrashReportInput,
  clientIp: string,
  now: string,
  dumpInfo: string = ''
): { report: CrashReport; groupId: number; isNewGroup: boolean } {
  const hash = computeCrashHash(input);

  let group = store.findGroupByHash(hash);
  let isNewGroup = false;

  if (group) {
    store.updateGroupOnNewReport(group.id, now);
  } else {
    group = store.createGroup(
      hash,
      input.exception_type,
      input.exception_message ?? '',
      now
    );
    isNewGroup = true;
  }

  const report = store.createReport(input, group.id, clientIp, now, dumpInfo);

  return { report, groupId: group.id, isNewGroup };
}
