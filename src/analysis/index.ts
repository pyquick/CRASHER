// ── Crash Analysis Module (Public API) ──

export { analyzeCrash } from './analyzer.js';
export { parseStackFrames, detectLanguage } from './parser.js';
export type {
  AnalysisSourceFile,
  AnalysisSourceSnapshot,
  CrashAnalysis,
  FileTreeNode,
  LanguageProfile,
  RelatedFunction,
  RelatedSourceFile,
  SourceAnalysis,
  SourceLocation,
  SourceRelationship,
  StackFrame,
} from './types.js';
