// ── Python Root-Cause Attribution ──
// Entry point: matches the crash frame to the snapshot code model, collects
// exception-type-driven evidence, and ranks root-cause candidates.

import type { RootCauseCandidate, StackFrame } from '../../../types.js';
import { pathsMatch } from '../../../../source.js';
import type { PyFileModel, PySnapshotModel } from '../code-model/types.js';
import { collectEvidence, findCrashFunc, type CrashContext, type Evidence } from './evidence.js';
import { scoreEvidence } from './scoring.js';

export { collectEvidence, findCrashFunc, crashLineText } from './evidence.js';
export type { CrashContext, Evidence } from './evidence.js';
export { scoreEvidence } from './scoring.js';

export function matchCrashFile(model: PySnapshotModel, frame: StackFrame): PyFileModel | null {
  if (!frame.file_path) return null;
  const exact = model.by_path.get(frame.file_path);
  if (exact) return exact;
  for (const file of model.files) {
    if (pathsMatch(frame.file_path, file.file_path)) return file;
  }
  return null;
}

export function analyzePythonRootCause(
  model: PySnapshotModel,
  frames: StackFrame[],
  exception: { type: string; message: string }
): RootCauseCandidate[] {
  const crashFrame = frames.find(frame => frame.file_path && frame.line_number) ?? frames[0];
  if (!crashFrame?.file_path) return [];

  const crashFile = matchCrashFile(model, crashFrame);
  if (!crashFile) return [];

  const crashLine = crashFrame.line_number ?? 1;
  const { func: crashFunc } = findCrashFunc(crashFile, crashFrame);

  const ctx: CrashContext = {
    model,
    crashFile,
    crashFunc,
    crashLine,
    exception,
    frames,
  };

  const evidence: Evidence[] = collectEvidence(ctx);
  return scoreEvidence(evidence, crashFunc, model, frames);
}
