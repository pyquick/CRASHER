// ── Code-analysis learning module (public API) ──
// Review-only AI judgment of deterministic crash analyses, the learnable
// knowledge base, and the agent-based self-improvement background job.

export { applyReviewToAnalysis, extractJsonObjects, normalizeReviewPayload, ROOT_CAUSE_KINDS } from './review-validate.js';
export type { ReviewCorrections, ReviewPayload } from './review-validate.js';
export { RETRY_FEEDBACK, REVIEW_SYSTEM_PROMPT, ReviewError, runReview } from './review.js';
export type { ProviderKey, ReviewOptions, ReviewOutcome } from './review.js';
export { applyKnowledgeToAnalysis, KNOWLEDGE_KINDS, normalizeKnowledge } from './knowledge.js';
export type { KnowledgeEntry, KnowledgeKind } from './knowledge.js';
export { runSelfImproveCrash, runSelfImproveJob, SELF_IMPROVE_SYSTEM_PROMPT, SelfImproveError } from './self-improve.js';
export type { SelfImproveCrashOptions, SelfImproveCrashOutcome, SelfImproveJobOptions } from './self-improve.js';
