// ── Crash Analysis Module (Public API) ──

export { analyzeCrash } from './analyzer.js';
export { parseStackFrames, detectLanguage } from './parser.js';
export type {
  AnalysisSourceFile,
  AnalysisSourceSnapshot,
  CrashAnalysis,
  CrashPathStep,
  FileTreeNode,
  FixSuggestion,
  LanguageProfile,
  LearnedKnowledgeItem,
  RelatedFunction,
  RelatedSourceFile,
  RootCauseCandidate,
  RootCauseKind,
  SourceAnalysis,
  SourceLocation,
  SourceRelationship,
  StackFrame,
} from './types.js';
