import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { ingestCrash } from '../service.js';
import * as store from '../store.js';
import type { CrashReportInput } from '../model.js';
import { normalizeOptionalProjectName } from '../source.js';
import { createAttachmentUpload, cleanupUploads, getUploadedFiles, parseAttachedDumps, getClientIp, extractCrashFormFields } from '../shared/upload.js';

const router = Router();
const upload = createAttachmentUpload(10);

/**
 * POST /api/v1/unity/crash-report
 * Unity-specific crash report endpoint.
 * Automatically sets runtime='unity' and maps unity_version → runtime_version.
 */
router.post('/unity/crash-report', upload.array('attachments', 10), async (req: Request, res: Response) => {
  const ua = (req.headers['user-agent'] ?? '').toLowerCase();
  const clientTag = (req.headers['x-client-type'] as string ?? '').toLowerCase();
  if (!ua.includes('unity') && clientTag !== 'unity') {
    cleanupUploads(req);
    res.status(403).json({
      error: 'Forbidden',
      message: 'This endpoint is for Unity clients only. Use /api/v1/crash-report with runtime="unity" instead.',
    });
    return;
  }

  try {
    let input: CrashReportInput;

    if (req.body?.report) {
      input = typeof req.body.report === 'string' ? JSON.parse(req.body.report) : req.body.report;
    } else if (req.is('multipart/form-data')) {
      input = extractCrashFormFields(req.body ?? {}) as unknown as CrashReportInput;
    } else {
      input = req.body as CrashReportInput;
    }

    input.runtime = 'unity';
    if (!input.runtime_version && input.unity_version) {
      input.runtime_version = input.unity_version;
    }

    if (!input.exception_type || typeof input.exception_type !== 'string') {
      cleanupUploads(req);
      res.status(400).json({ error: 'Bad Request', message: 'exception_type is required' });
      return;
    }
    try {
      input.project_name = normalizeOptionalProjectName(input.project_name);
    } catch (err: any) {
      cleanupUploads(req);
      res.status(400).json({ error: 'Bad Request', message: err.message });
      return;
    }

    if (input.stack_trace && input.stack_trace.length > config.maxLogSize) {
      input.stack_trace = input.stack_trace.substring(0, config.maxLogSize) + '\n...[truncated]';
    }
    if (input.log_text && input.log_text.length > config.maxLogSize) {
      input.log_text = input.log_text.substring(0, config.maxLogSize) + '\n...[truncated]';
    }

    const clientIp = getClientIp(req);
    const now = new Date().toISOString();
    const dumpInfo = parseAttachedDumps(req);

    const result = await ingestCrash(input, clientIp, now, dumpInfo);

    const allFiles = getUploadedFiles(req);
    if (allFiles.length > 0) {
      for (const file of allFiles) {
        store.createAttachment(result.report.id, file.originalname, file.mimetype, file.size, file.path);
      }
    }

    res.status(201).json({
      id: result.report.id,
      group_id: result.groupId,
      is_new_group: result.isNewGroup,
      runtime: 'unity',
    });
  } catch (err: any) {
    cleanupUploads(req);
    console.error('Error ingesting Unity crash report:', err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Could not ingest Unity crash report' });
  }
});

export default router;
