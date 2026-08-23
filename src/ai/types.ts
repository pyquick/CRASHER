import type { CrashAnalysis } from '../analysis/types.js';
import type { AiMessageRole, AiProviderModel, CrashGroup, CrashReport, SourceFile } from '../model.js';

export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiChatMessage {
  role: AiMessageRole | 'system' | 'tool';
  content: string;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
}

export interface AiProviderRequest {
  model?: AiProviderModel;
  messages: AiChatMessage[];
  tools?: unknown[];
  tool_choice?: 'auto' | 'none' | string;
}

export interface AiProviderResponse {
  content: string;
  reasoning: string | null;
  toolCalls: AiToolCall[] | null;
}

export type AiStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'done'; toolCalls?: AiToolCall[] };

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
