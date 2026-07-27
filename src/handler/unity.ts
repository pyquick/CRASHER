import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { config } from '../config.js';
import { ingestCrash } from '../service.js';
import * as store from '../store.js';
import { parseDump } from '../dump/parser.js';
import type { CrashReportInput } from '../model.js';

const router = Router();

// Multer setup (same as crash_report.ts)
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
 * POST /api/v1/unity/crash-report
 * Unity-specific crash report endpoint.
 * Automatically sets runtime='unity' and maps unity_version → runtime_version.
 * Otherwise identical to the generic /crash-report endpoint.
 */
router.post('/unity/crash-report', upload.array('attachments', 10), async (req: Request, res: Response) => {
  try {
    let input: CrashReportInput;

    if (req.body?.report) {
      input = typeof req.body.report === 'string' ? JSON.parse(req.body.report) : req.body.report;
    } else if (req.is('multipart/form-data')) {
      input = extractUnityFormReport(req.body);
    } else {
      input = req.body as CrashReportInput;
    }

    // Auto-fill Unity-specific defaults
    input.runtime = 'unity';
    if (!input.runtime_version && input.unity_version) {
      input.runtime_version = input.unity_version;
    }

    if (!input.exception_type || typeof input.exception_type !== 'string') {
      res.status(400).json({ error: 'Bad Request', message: 'exception_type is required' });
      return;
    }

    if (input.stack_trace && input.stack_trace.length > config.maxLogSize) {
      input.stack_trace = input.stack_trace.substring(0, config.maxLogSize) + '\n...[truncated]';
    }
    if (input.log_text && input.log_text.length > config.maxLogSize) {
      input.log_text = input.log_text.substring(0, config.maxLogSize) + '\n...[truncated]';
    }

    const clientIp = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = new Date().toISOString();

    let dumpInfo = '';
    const files = (req as any).files as Express.Multer.File[] | undefined;
    const singleFile = (req as any).file as Express.Multer.File | undefined;
    const allFiles = files || (singleFile ? [singleFile] : []);

    if (allFiles.length > 0) {
      const parsedDumps: any[] = [];
      for (const file of allFiles) {
        try {
          const buffer = readFileSync(file.path);
          const dump = parseDump(buffer, file.originalname, file.mimetype);
          if (dump) parsedDumps.push({ source_file: file.originalname, ...dump });
        } catch (parseErr: any) {
          console.warn(`[unity/dump] Parse error for ${file.originalname}:`, parseErr.message);
        }
      }
      if (parsedDumps.length > 0) dumpInfo = JSON.stringify(parsedDumps);
    }

    const result = ingestCrash(input, clientIp, now, dumpInfo);

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
    console.error('Error ingesting Unity crash report:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

function extractUnityFormReport(body: Record<string, unknown>): CrashReportInput {
  const s = (k: string) => String(body[k] ?? '');
  return {
    exception_type: s('exception_type'),
    exception_message: s('exception_message'),
    stack_trace: s('stack_trace'),
    log_text: s('log_text'),
    runtime: 'unity',
    runtime_version: s('unity_version'),
    framework: 'unity',
    unity_version: s('unity_version'),
    platform: s('platform'),
    device_model: s('device_model'),
    os_version: s('os_version'),
    gpu_name: s('gpu_name'),
    cpu_name: s('cpu_name'),
    memory_mb: body.memory_mb ? parseInt(String(body.memory_mb), 10) || 0 : undefined,
    app_version: s('app_version'),
    bundle_id: s('bundle_id'),
    scene_name: s('scene_name'),
    custom_data: body.custom_data as any,
    client_timestamp: s('client_timestamp'),
  };
}

export default router;
