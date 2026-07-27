import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { config } from '../config.js';
import { ingestCrash } from '../service.js';
import { getDb } from '../database.js';
import * as store from '../store.js';
import { parseDump } from '../dump/parser.js';
import type { CrashReportInput } from '../model.js';

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

// ── POST /crash-report ──

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

    const result = ingestCrash(input, clientIp, now, dumpInfo);

    if (allFiles.length > 0) {
      for (const file of allFiles) {
        store.createAttachment(result.report.id, file.originalname, file.mimetype, file.size, file.path);
      }
    }

    res.status(201).json({ id: result.report.id, group_id: result.groupId, is_new_group: result.isNewGroup });
  } catch (err: any) {
    console.error('Error ingesting crash report:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
}

function extractFormReport(body: Record<string, unknown>): CrashReportInput {
  const s = (k: string) => String(body[k] ?? '');
  const input: CrashReportInput = {
    exception_type: s('exception_type'), exception_message: s('exception_message'),
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
  };
  if (body.memory_mb) input.memory_mb = parseInt(String(body.memory_mb), 10) || 0;
  if (body.custom_data) {
    try { input.custom_data = typeof body.custom_data === 'string' ? JSON.parse(body.custom_data) : body.custom_data; }
    catch { input.custom_data = String(body.custom_data); }
  }
  return input;
}

// ── Query routes ──

router.get('/crash-groups', (_req, res) => {
  const q = _req.query;
  res.json(store.listGroups({
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    status: q.status as string | undefined,
    search: q.search as string | undefined,
    start_date: q.start_date as string | undefined,
    end_date: q.end_date as string | undefined,
    sort_by: q.sort_by as string | undefined,
    sort_order: (q.sort_order as 'asc' | 'desc') || 'desc',
  }));
});

router.get('/crash-groups/:id', (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const group = store.getGroupById(id);
  if (!group) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...group, recent_reports: store.listReports({ group_id: id, page: 1, page_size: 20 }).items });
});

router.put('/crash-groups/:id/status', (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const { status, resolved_version } = req.body ?? {};
  if (!['open', 'resolved', 'ignored'].includes(status)) {
    res.status(400).json({ error: 'Invalid status', message: 'Status must be: open, resolved, ignored' });
    return;
  }
  if (!store.updateGroupStatus(id, status, resolved_version)) { res.status(404).json({ error: 'Group not found' }); return; }
  res.json({ success: true });
});

router.get('/crash-reports', (req, res) => {
  const q = req.query;
  res.json(store.listReports({
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    group_id: q.group_id ? parseInt(String(q.group_id), 10) : undefined,
    platform: q.platform as string | undefined,
    app_version: q.app_version as string | undefined,
    start_date: q.start_date as string | undefined,
    end_date: q.end_date as string | undefined,
  }));
});

router.get('/crash-reports/:id', (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const report = store.getReportById(id);
  if (!report) { res.status(404).json({ error: 'Not found' }); return; }
  const atts = store.getAttachmentsForReport(id);
  res.json({ ...report, attachments: atts });
});

router.get('/stats/dashboard', (_req, res) => { res.json(store.getDashboardStats()); });

// ── Analytics routes ──

router.get('/platforms', (_req, res) => {
  res.json((getDb().prepare("SELECT DISTINCT platform FROM crash_reports WHERE platform != '' ORDER BY platform").all() as any[]).map(r => r.platform));
});

router.get('/versions', (_req, res) => {
  res.json((getDb().prepare("SELECT DISTINCT app_version FROM crash_reports WHERE app_version != '' ORDER BY app_version DESC LIMIT 50").all() as any[]).map(r => r.app_version));
});

export default router;
