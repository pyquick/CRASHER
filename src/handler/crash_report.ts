import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { config } from '../config.js';
import { ingestCrash } from '../service.js';
import { getDb } from '../database.js';
import * as store from '../store.js';
import type { CrashReportInput } from '../model.js';

const router = Router();

// Multer setup for attachment uploads
const attachmentStorage = multer.diskStorage({
  destination: config.attachmentsDir,
  filename: (_req, file, cb) => {
    const unique = randomBytes(12).toString('hex');
    const ext = file.originalname.split('.').pop() ?? 'bin';
    cb(null, `${unique}.${ext}`);
  },
});

const upload = multer({
  storage: attachmentStorage,
  limits: { fileSize: config.maxAttachmentSize, files: 10 },
});

/**
 * POST /api/v1/crash-report
 * Accepts a crash report. Can be JSON-only or multipart (with attachments).
 *
 * JSON format:
 * {
 *   "exception_type": "...",     // required
 *   "exception_message": "...",
 *   "stack_trace": "...",
 *   "log_text": "...",
 *   "unity_version": "...",
 *   "platform": "...",
 *   ...
 * }
 *
 * Multipart format: "report" field with JSON + "attachments" files.
 */
router.post(
  '/crash-report',
  upload.array('attachments', 10),
  (req: Request, res: Response): void => {
    void (async () => {
      try {
        let input: CrashReportInput;

        // Check if this is a multipart upload with JSON in "report" field
        if (req.body?.report) {
          input = typeof req.body.report === 'string'
            ? JSON.parse(req.body.report)
            : req.body.report;
        } else if (req.is('multipart/form-data')) {
          // Form fields directly
          input = extractFormReport(req.body);
        } else {
          // Pure JSON body
          input = req.body as CrashReportInput;
        }

        // Validate required fields
        if (!input.exception_type || typeof input.exception_type !== 'string') {
          res.status(400).json({
            error: 'Bad Request',
            message: 'exception_type is required and must be a string',
          });
          return;
        }

        // Truncate large fields
        if (input.stack_trace && input.stack_trace.length > config.maxLogSize) {
          input.stack_trace = input.stack_trace.substring(0, config.maxLogSize) + '\n... [truncated]';
        }
        if (input.log_text && input.log_text.length > config.maxLogSize) {
          input.log_text = input.log_text.substring(0, config.maxLogSize) + '\n... [truncated]';
        }

        const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        const now = new Date().toISOString();

        const result = ingestCrash(input, clientIp, now);

        // Save attachments if present
        const files = req.files as Express.Multer.File[] | undefined;
        if (files && files.length > 0) {
          for (const file of files) {
            store.createAttachment(
              result.report.id,
              file.originalname,
              file.mimetype,
              file.size,
              file.path
            );
          }
        }

        res.status(201).json({
          id: result.report.id,
          group_id: result.groupId,
          is_new_group: result.isNewGroup,
        });
      } catch (err: any) {
        if (err instanceof SyntaxError) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid JSON in request body',
          });
          return;
        }
        console.error('Error ingesting crash report:', err);
        res.status(500).json({
          error: 'Internal Server Error',
          message: err.message,
        });
      }
    })();
  }
);

function extractFormReport(body: Record<string, unknown>): CrashReportInput {
  const input: CrashReportInput = {
    exception_type: String(body.exception_type ?? ''),
    exception_message: String(body.exception_message ?? ''),
    stack_trace: String(body.stack_trace ?? ''),
    log_text: String(body.log_text ?? ''),
    unity_version: String(body.unity_version ?? ''),
    platform: String(body.platform ?? ''),
    device_model: String(body.device_model ?? ''),
    os_version: String(body.os_version ?? ''),
    gpu_name: String(body.gpu_name ?? ''),
    cpu_name: String(body.cpu_name ?? ''),
    app_version: String(body.app_version ?? ''),
    bundle_id: String(body.bundle_id ?? ''),
    scene_name: String(body.scene_name ?? ''),
    client_timestamp: String(body.client_timestamp ?? ''),
  };

  if (body.memory_mb) {
    input.memory_mb = parseInt(String(body.memory_mb), 10) || 0;
  }
  if (body.custom_data) {
    try {
      input.custom_data = typeof body.custom_data === 'string'
        ? JSON.parse(body.custom_data)
        : body.custom_data;
    } catch {
      input.custom_data = String(body.custom_data);
    }
  }

  return input;
}

/**
 * GET /api/v1/crash-groups
 * List crash groups with pagination and filtering.
 */
router.get('/crash-groups', (_req: Request, res: Response): void => {
  const q = _req.query;
  const result = store.listGroups({
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    status: q.status as string | undefined,
    search: q.search as string | undefined,
    start_date: q.start_date as string | undefined,
    end_date: q.end_date as string | undefined,
    sort_by: q.sort_by as string | undefined,
    sort_order: (q.sort_order as 'asc' | 'desc') || 'desc',
  });
  res.json(result);
});

/**
 * GET /api/v1/crash-groups/:id
 * Get a single crash group with its recent reports.
 */
router.get('/crash-groups/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID' });
    return;
  }

  const group = store.getGroupById(id);
  if (!group) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const reports = store.listReports({ group_id: id, page: 1, page_size: 20 });
  res.json({ ...group, recent_reports: reports.items });
});

/**
 * PUT /api/v1/crash-groups/:id/status
 * Update crash group status (open | resolved | ignored).
 */
router.put('/crash-groups/:id/status', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID' });
    return;
  }

  const { status, resolved_version } = req.body ?? {};
  if (!['open', 'resolved', 'ignored'].includes(status)) {
    res.status(400).json({
      error: 'Invalid status',
      message: 'Status must be one of: open, resolved, ignored',
    });
    return;
  }

  const ok = store.updateGroupStatus(id, status, resolved_version);
  if (!ok) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  res.json({ success: true });
});

/**
 * GET /api/v1/crash-reports
 * List individual crash reports.
 */
router.get('/crash-reports', (req: Request, res: Response): void => {
  const q = req.query;
  const result = store.listReports({
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    group_id: q.group_id ? parseInt(String(q.group_id), 10) : undefined,
    platform: q.platform as string | undefined,
    app_version: q.app_version as string | undefined,
    start_date: q.start_date as string | undefined,
    end_date: q.end_date as string | undefined,
  });
  res.json(result);
});

/**
 * GET /api/v1/crash-reports/:id
 * Get a single crash report with its attachments.
 */
router.get('/crash-reports/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID' });
    return;
  }

  const report = store.getReportById(id);
  if (!report) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const attachments = store.getAttachmentsForReport(id);
  res.json({ ...report, attachments });
});

/**
 * GET /api/v1/stats/dashboard
 * Dashboard statistics.
 */
router.get('/stats/dashboard', (_req: Request, res: Response): void => {
  const stats = store.getDashboardStats();
  res.json(stats);
});

/**
 * GET /api/v1/platforms
 * Get distinct platforms seen.
 */
router.get('/platforms', (_req: Request, res: Response): void => {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT platform FROM crash_reports WHERE platform != '' ORDER BY platform"
    )
    .all() as { platform: string }[];
  res.json(rows.map((r) => r.platform));
});

/**
 * GET /api/v1/versions
 * Get distinct app versions seen.
 */
router.get('/versions', (_req: Request, res: Response): void => {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT app_version FROM crash_reports WHERE app_version != '' ORDER BY app_version DESC LIMIT 50"
    )
    .all() as { app_version: string }[];
  res.json(rows.map((r) => r.app_version));
});

export default router;
