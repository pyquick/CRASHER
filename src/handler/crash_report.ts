import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { readFileSync, unlinkSync } from 'fs';
import { config } from '../config.js';
import { ingestCrash } from '../service.js';
import * as store from '../store.js';
import { parseDump } from '../dump/parser.js';
import type { CrashReportInput } from '../model.js';
import { normalizeOptionalProjectName } from '../source.js';

const router = Router();

// ── Multer setup ──

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

// ── POST /crash-report (public — no auth required) ──

router.post('/crash-report', upload.array('attachments', 10), handleCrashReport);

async function handleCrashReport(req: Request, res: Response): Promise<void> {
  try {
    let input: CrashReportInput;

    if (req.body?.report) {
      input = typeof req.body.report === 'string' ? JSON.parse(req.body.report) : req.body.report;
    } else if (req.is('multipart/form-data')) {
      input = extractFormReport(req.body ?? {});
    } else {
      input = (req.body ?? {}) as CrashReportInput;
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

    // Normalize and validate error_severity
    const allowedSeverities = ['warning', 'error', 'fatal', 'crash'];
    if (input.error_severity) {
      const sev = input.error_severity.toLowerCase();
      if (!allowedSeverities.includes(sev)) {
        cleanupUploads(req);
        res.status(400).json({ error: 'Bad Request', message: `error_severity must be one of: ${allowedSeverities.join(', ')}` });
        return;
      }
      input.error_severity = sev;
    } else {
      input.error_severity = 'error';
    }

    if (input.stack_trace && input.stack_trace.length > config.maxLogSize) {
      input.stack_trace = input.stack_trace.substring(0, config.maxLogSize) + '\n...[truncated]';
    }
    if (input.log_text && input.log_text.length > config.maxLogSize) {
      input.log_text = input.log_text.substring(0, config.maxLogSize) + '\n...[truncated]';
    }

	    const clientIp = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
	    const now = new Date().toISOString();
	    const containerId = req.authUser?.container_id ?? null;

	    // Parse dump files from attachments
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
	          console.warn(`[dump] Parse error for ${file.originalname}:`, parseErr.message);
	        }
	      }
	      if (parsedDumps.length > 0) dumpInfo = JSON.stringify(parsedDumps);
	    }

	    const result = await ingestCrash(input, clientIp, now, dumpInfo, containerId);

    if (allFiles.length > 0) {
      for (const file of allFiles) {
        store.createAttachment(result.report.id, file.originalname, file.mimetype, file.size, file.path);
      }
    }

    res.status(201).json({ id: result.report.id, group_id: result.groupId, is_new_group: result.isNewGroup });
  } catch (err: any) {
    cleanupUploads(req);
    console.error('Error ingesting crash report:', err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Could not ingest crash report' });
  }
}

function cleanupUploads(req: Request): void {
  const files = ((req as any).files ?? []) as Express.Multer.File[];
  for (const file of files) {
    try { unlinkSync(file.path); } catch {}
  }
}

function extractFormReport(body: Record<string, unknown>): CrashReportInput {
  const s = (k: string) => String(body[k] ?? '');
  const input: CrashReportInput = {
    exception_type: s('exception_type'), project_name: s('project_name'), exception_message: s('exception_message'),
    stack_trace: s('stack_trace'), log_text: s('log_text'),
    runtime: s('runtime'), runtime_version: s('runtime_version'),
    framework: s('framework'), environment: s('environment'),
    server_name: s('server_name'), release: s('release'),
    error_severity: s('error_severity'),
    unity_version: s('unity_version'), platform: s('platform'),
    device_model: s('device_model'), os_version: s('os_version'),
    gpu_name: s('gpu_name'), cpu_name: s('cpu_name'),
    app_version: s('app_version'), bundle_id: s('bundle_id'),
    scene_name: s('scene_name'), client_timestamp: s('client_timestamp'),
    build_guid: s('build_guid'),
  };
  if (body.memory_mb) input.memory_mb = parseInt(String(body.memory_mb), 10) || 0;
  if (body.custom_data) {
    try { input.custom_data = typeof body.custom_data === 'string' ? JSON.parse(body.custom_data) : body.custom_data; }
    catch { input.custom_data = String(body.custom_data); }
  }
  return input;
}

export default router;
