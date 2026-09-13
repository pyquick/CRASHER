// ── Code-analysis learning endpoints ──
// POST /analysis-review           — review-only AI judgment (no tools, no self-improvement)
// POST /analysis-self-improve     — start the background self-improvement job (no 2FA)
// GET  /analysis-self-improve     — job progress
// POST /analysis-self-improve/cancel — cancel the running job

import { Router, type Request, type Response } from 'express';
import * as store from '../store.js';
import { config } from '../config.js';
import { nowSqlDateTime } from '../shared/date.js';
import { parsePositiveId } from '../shared/string.js';
import { rateLimit, requireRole } from '../middleware.js';
import { resolveContainerScopeForUser } from '../shared/container.js';
import { loadScopedCrashContext } from '../ai/context.js';
import { AiProviderError } from '../ai/deepseek.js';
import { sendError, sendSuccess } from '../shared/response.js';
import { readConfiguredProviderKeys } from './ai-provider.js';
import { applyReviewToAnalysis, ReviewError, runReview, runSelfImproveJob } from '../learning/index.js';

const router = Router();
const PROVIDER = 'deepseek' as const;

const reviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.aiRateLimit,
  key: req => `ai-review:${req.authUser?.id ?? req.ip}`,
});

// In-process singleton marker for the background self-improvement job.
let activeSelfImproveJob: { id: number; abort: () => void } | null = null;

function requireSessionRole(req: Request, res: Response, roles: string[]): boolean {
  if (req.authType !== 'session') {
    sendError(res, 403, 'AI requires session authentication', 'FORBIDDEN');
    return false;
  }
  if (!req.authUser || !roles.includes(req.authUser.role)) {
    sendError(res, 403, 'AI is available to administrators and operators only', 'FORBIDDEN');
    return false;
  }
  return true;
}

function bodyModel(req: Request): string | undefined {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim().slice(0, 200) : '';
  return model || undefined;
}

// ── POST /analysis-review ──
router.post('/analysis-review', reviewLimiter, requireRole('admin', 'operator'), async (req: Request, res: Response): Promise<void> => {
  if (!requireSessionRole(req, res, ['admin', 'operator'])) return;
  const reportId = parsePositiveId(req.body?.report_id);
  if (!reportId) { sendError(res, 400, 'report_id must be a positive integer', 'BAD_REQUEST'); return; }
  const now = nowSqlDateTime();
  const scope = resolveContainerScopeForUser(req.authUser!);
  const report = store.getReportByIdScoped(reportId, scope);
  if (!report || report.group_id === null) { sendError(res, 404, 'Report not found', 'NOT_FOUND'); return; }
  const context = loadScopedCrashContext(req.authUser!, report.group_id, reportId);
  if (!context || !context.analysis) { sendError(res, 500, 'Deterministic analysis is unavailable for this report', 'ANALYSIS_UNAVAILABLE'); return; }
  const keys = readConfiguredProviderKeys(req.authUser!.id, now);
  if (!keys.length) { sendError(res, 409, 'Configure an available DeepSeek API key first', 'AI_PROVIDER_NOT_CONFIGURED'); return; }
  const model = bodyModel(req) ?? store.getUserDefaultAiModel(req.authUser!.id) ?? undefined;

  try {
    const { review, model: modelUsed } = await runReview(context, model, keys, now, {
      onUse: (keyId, at) => store.recordAiProviderUse(keyId, req.authUser!.id, PROVIDER, at),
      onFailure: (keyId, code, retryAfterAt, at) => store.recordAiProviderFailure(keyId, req.authUser!.id, PROVIDER, code, retryAfterAt, at),
    });
    const row = store.insertAnalysisReview(
      reportId,
      req.authUser!.id,
      modelUsed,
      review.correct,
      review.notes,
      JSON.stringify(review.corrections),
      JSON.stringify(review.suggestions),
      report.exception_type,
      now,
    );
    if (!review.correct) {
      store.updateReportException(reportId, {
        exceptionType: review.corrections.exception_type,
        exceptionMessage: review.corrections.exception_message,
        now,
      });
    }
    const analysis = applyReviewToAnalysis(context.analysis, review);
    const aiReview = {
      correct: review.correct,
      notes: review.notes,
      model: row.model,
      created_at: row.created_at,
    };
    sendSuccess(res, { analysis: { ...analysis, ai_review: aiReview }, ai_review: aiReview });
  } catch (error) {
    if (error instanceof ReviewError) { sendError(res, error.status, error.message, error.code); return; }
    if (error instanceof AiProviderError) { sendError(res, 502, error.message, error.code); return; }
    throw error;
  }
});

// ── POST /analysis-self-improve (admin/operator, no 2FA — AI Settings trigger) ──
router.post('/analysis-self-improve', reviewLimiter, requireRole('admin', 'operator'), async (req: Request, res: Response): Promise<void> => {
  if (!requireSessionRole(req, res, ['admin', 'operator'])) return;
  const now = nowSqlDateTime();
  const scope = resolveContainerScopeForUser(req.authUser!);
  if (activeSelfImproveJob || store.getRunningAnalysisLearningJob()) {
    sendError(res, 409, 'A self-improvement job is already running', 'SELF_IMPROVE_RUNNING');
    return;
  }
  const total = store.countUnlearnedReports(scope);
  if (total === 0) {
    sendError(res, 400, 'All crashes in scope are already marked learned', 'SELF_IMPROVE_NOTHING_TO_LEARN');
    return;
  }
  const keys = readConfiguredProviderKeys(req.authUser!.id, now);
  if (!keys.length) { sendError(res, 409, 'Configure an available DeepSeek API key first', 'AI_PROVIDER_NOT_CONFIGURED'); return; }
  const model = bodyModel(req) ?? store.getUserDefaultAiModel(req.authUser!.id);
  if (!model) { sendError(res, 400, 'Select a model from the provider model list', 'AI_MODEL_NOT_SELECTED'); return; }
  const job = store.createAnalysisLearningJob(req.authUser!.id, req.authUser!.container_id ?? null, model, total, now);
  const controller = new AbortController();
  activeSelfImproveJob = { id: job.id, abort: () => controller.abort() };
  const user = req.authUser!;
  void runSelfImproveJob(job, user, scope, {
    model: model || undefined,
    keys,
    loadSourceFiles: async (projectId) => (projectId === null || projectId === undefined
      ? []
      : store.getCurrentSourceFilesForProject(projectId, scope)),
    onUse: (keyId, at) => store.recordAiProviderUse(keyId, user.id, PROVIDER, at),
    onFailure: (keyId, code, retryAfterAt, at) => store.recordAiProviderFailure(keyId, user.id, PROVIDER, code, retryAfterAt, at),
    onProgress: (message) => store.insertAnalysisLearningJobLog(job.id, null, null, message, nowSqlDateTime()),
    isCancelled: () => store.getAnalysisLearningJob(job.id)?.status === 'cancelled',
    signal: controller.signal,
  }).finally(() => {
    activeSelfImproveJob = null;
  });
  sendSuccess(res, { job: { id: job.id, status: job.status, total_count: job.total_count, processed_count: job.processed_count, knowledge_count: job.knowledge_count } }, 202);
});

// ── GET /analysis-self-improve ──
router.get('/analysis-self-improve', requireRole('admin', 'operator'), (req: Request, res: Response): void => {
  if (!requireSessionRole(req, res, ['admin', 'operator'])) return;
  const job = activeSelfImproveJob?.id
    ? store.getAnalysisLearningJob(activeSelfImproveJob.id) ?? null
    : store.getRunningAnalysisLearningJob() ?? store.getLatestAnalysisLearningJob() ?? null;
  // Only report the job as active while the row is actually running — a
  // cancelled job stays in memory until the in-flight crash processing stops.
  sendSuccess(res, { job, active: activeSelfImproveJob !== null && job?.status === 'running', logs: job ? store.listAnalysisLearningJobLogs(job.id, 200) : [] });
});

// ── POST /analysis-self-improve/cancel ──
router.post('/analysis-self-improve/cancel', requireRole('admin', 'operator'), (req: Request, res: Response): void => {
  if (!requireSessionRole(req, res, ['admin', 'operator'])) return;
  const now = nowSqlDateTime();
  const job = store.getRunningAnalysisLearningJob();
  if (!job) { sendError(res, 404, 'No self-improvement job is running', 'NOT_FOUND'); return; }
  store.updateAnalysisLearningJob(job.id, { status: 'cancelled', now });
  store.insertAnalysisLearningJobLog(job.id, null, null, 'job cancelled by user', now);
  activeSelfImproveJob?.abort();
  sendSuccess(res, { job: store.getAnalysisLearningJob(job.id) });
});

export default router;
