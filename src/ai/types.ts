import type { CrashAnalysis } from '../analysis/types.js';
import type { AiMessageRole, AiProviderModel, CrashGroup, CrashReport, SourceFile } from '../model.js';

export interface AiChatMessage {
  role: AiMessageRole | 'system';
  content: string;
}

export interface AiProviderRequest {
  model?: AiProviderModel;
  messages: AiChatMessage[];
}

export interface AiProviderResponse {
  content: string;
  reasoning: string | null;
}

export type AiStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'done' };

export interface ScopedCrashContext {
  group: CrashGroup;
  report: CrashReport;
  analysis: CrashAnalysis | null;
  sourceAvailable: boolean;
  sourceSnapshotId: number | null;
  sourceFiles: Array<{ relative_path: string; language: string; content: string }>;
}

export interface SourceFileReader {
  (file: SourceFile): string;
}
