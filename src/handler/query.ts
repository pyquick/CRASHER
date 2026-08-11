import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import * as store from '../store.js';
import { analyzeCrash } from '../analysis/analyzer.js';
import { createTarGz, extractTarGzFile, cleanupArchive } from '../archive.js';
import { createReadStream, existsSync, unlinkSync, readFileSync } from 'fs';
import { config } from '../config.js';
import { requireRole } from '../middleware.js';
import { importCrashPackage, extractImportBuffer } from '../service/import.js';
import { getContainerScope } from '../shared/container.js';
import type { CrashReport, CrashAttachment } from '../model.js';

/**
 * Protected data-viewing routes (auth required).
 * All routes mounted under /api/v1 with requireApiAuth middleware.
 */
const router = Router();
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024, files: 1 },
});

// ── Crash group query routes ──

router.get('/crash-groups', (req, res) => {
  const q = req.query;
  res.json(store.listGroups({
    container_id: getContainerScope(req),
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    project_id: q.project_id !== undefined ? parseInt(String(q.project_id), 10) : undefined,
    status: q.status as string | undefined,
    platform: q.platform as string | undefined,
    app_version: q.app_version as string | undefined,
    runtime: q.runtime as string | undefined,
    environment: q.environment as string | undefined,
    search: q.search as string | undefined,
    start_date: q.start_date as string | undefined,
    end_date: q.end_date as string | undefined,
    sort_by: q.sort_by as string | undefined,
    sort_order: (q.sort_order as 'asc' | 'desc') || 'desc',
    error_severity: q.error_severity as string | undefined,
  }));
});

router.get('/crash-groups/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const group = store.getGroupById(id);
  if (!group) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...group, recent_reports: store.listReports({ group_id: id, page: 1, page_size: 20 }).items });
});

router.put('/crash-groups/:id/status', requireRole('admin', 'operator'), (req, res) => {
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

// ── Crash report query routes ──

router.get('/crash-reports', requireRole('admin', 'operator'), (req, res) => {
  const q = req.query;
  res.json(store.listReports({
    container_id: getContainerScope(req),
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    group_id: q.group_id ? parseInt(String(q.group_id), 10) : undefined,
    project_id: q.project_id !== undefined ? parseInt(String(q.project_id), 10) : undefined,
    platform: q.platform as string | undefined,
    app_version: q.app_version as string | undefined,
    start_date: q.start_date as string | undefined,
    end_date: q.end_date as string | undefined,
  }));
});

router.get('/crash-reports/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const report = store.getReportById(id);
  if (!report) { res.status(404).json({ error: 'Not found' }); return; }
  const atts = store.getAttachmentsForReport(id);
  res.json({ ...report, attachments: atts });
});

// ── Symbolication ──

/**
 * GET /api/v1/crash-reports/:id/symbolication
 * Returns the C# symbolicated stack info for a single crash report.
 */
router.get('/crash-reports/:id/symbolication', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const report = store.getReportById(id);
  if (!report) { res.status(404).json({ error: 'Not found' }); return; }

  let symbolicationInfo: any = {};
  try {
    if (report.symbolication_info) {
      symbolicationInfo = JSON.parse(report.symbolication_info);
    }
  } catch {
    symbolicationInfo = { raw: report.symbolication_info };
  }

  res.json({
    report_id: report.id,
    runtime: report.runtime,
    build_guid: report.build_guid,
    symbolication_status: report.symbolication_status,
    symbolicated_stack: report.symbolicated_stack || null,
    symbolication_info: symbolicationInfo,
    symbol_id: report.symbol_id,
  });
});

// ── Crash Analysis ──

router.get('/crash-reports/:id/analysis', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const report = store.getReportById(id);
  if (!report) { res.status(404).json({ error: 'Not found' }); return; }

  const sourceSnapshot = report.project_id
    ? store.findSourceSnapshot(report.project_id, report.release)
    : undefined;
  const sourceFiles = sourceSnapshot
    ? store.getSourceFilesForSnapshot(sourceSnapshot.id)
      .flatMap(file => {
        try {
          return [{ relative_path: file.relative_path, language: file.language, content: readFileSync(file.storage_path, 'utf-8') }];
        } catch {
          return [];
        }
      })
    : [];

  const analysis = analyzeCrash({
    id: report.id,
    exception_type: report.exception_type,
    exception_message: report.exception_message,
    stack_trace: report.stack_trace,
    log_text: report.log_text,
    runtime: report.runtime,
    runtime_version: report.runtime_version,
    symbolicated_stack: report.symbolicated_stack || undefined,
  }, sourceSnapshot ? {
    project_name: report.project_name || 'Unassigned',
    requested_release: report.release,
    snapshot_release: sourceSnapshot.release,
    snapshot_id: sourceSnapshot.id,
    match_type: sourceSnapshot.match_type,
    files: sourceFiles,
  } : undefined);

  if (!analysis) {
    res.status(500).json({ error: 'Analysis failed' });
    return;
  }

  res.json(analysis);
});

// ── Export / Import ──

/**
 * GET /api/v1/export/group/:id
 * Export a crash group as a .crashpkg (tar.gz) containing the group manifest,
 * all reports with their full data, and all attachment binaries.
 */
router.get('/export/group/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  const group = store.getGroupById(id);
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const { items: reports } = store.listReports({ group_id: id, page: 1, page_size: 10000 });

  // Build manifest
  const manifest = {
    version: 1,
    exported_at: new Date().toISOString(),
    group,
    report_ids: reports.map(r => r.id),
    report_count: reports.length,
  };

  const entries: Array<{ name: string; data?: Buffer | string; filePath?: string }> = [];

  // manifest.json
  entries.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });

  // Each report as JSON + its attachment files
  for (const report of reports) {
    const attachments = store.getAttachmentsForReport(report.id);

    // Report JSON (strip disk paths — they're local to the server)
    const exportReport = {
      ...report,
      // Keep dump_info as-is (it's JSON text)
    };
    entries.push({
      name: `reports/${report.id}.json`,
      data: JSON.stringify(exportReport, null, 2),
    });

    // Attachment metadata index
    if (attachments.length > 0) {
      const attMeta = attachments.map(a => ({
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        file_size: a.file_size,
        entry_name: `reports/${report.id}/${a.filename}`,
      }));
      entries.push({
        name: `reports/${report.id}/attachments.json`,
        data: JSON.stringify(attMeta, null, 2),
      });

      // Attachment binary files
      for (const att of attachments) {
        const safeName = att.filename.replace(/[^\w.\-]/g, '_');
        if (existsSync(att.file_path)) {
          entries.push({
            name: `reports/${report.id}/${safeName}`,
            filePath: att.file_path,
          });
        } else {
          // File missing on disk — still note it
          console.warn(`[export] Attachment file missing on disk: ${att.file_path} (id=${att.id})`);
        }
      }
    }
  }

  try {
    const tmpPath = createTarGz(entries);
    const safeFilename = `crash-group-${id}.crashpkg`;

    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', 'application/gzip');

    const readStream = createReadStream(tmpPath);
    readStream.on('end', () => cleanupArchive(tmpPath));
    readStream.on('error', () => cleanupArchive(tmpPath));
    readStream.pipe(res);
  } catch (err: any) {
    console.error('[export] Failed to create archive:', err);
    res.status(500).json({ error: 'Export failed', message: err.message });
  }
});

/**
 * POST /api/v1/import
 * Import a .crashpkg (tar.gz) file.
 * Query params: ?confirm=true — actually write to DB (otherwise dry-run)
 */
router.post('/import', requireRole('admin', 'operator'), importUpload.single('package'), (req, res) => {
  try {
    const pkgBuffer = extractImportBuffer(req);
    if (!pkgBuffer || pkgBuffer.length === 0) {
      res.status(400).json({ error: 'Bad Request', message: 'No package data received. Send a .crashpkg file as multipart/form-data with field name "package".' });
      return;
    }
    const result = importCrashPackage(pkgBuffer, req.query.confirm === 'true', getContainerScope(req) ?? null);
    res.status(req.query.confirm === 'true' ? 201 : 200).json(result);
  } catch (err: any) {
    console.error('[import] Error:', err);
    res.status(err.message.startsWith('Failed') || err.message.startsWith('manifest') || err.message.startsWith('Invalid') ? 400 : 500)
      .json({ error: err.message.includes('manifest') || err.message.includes('Invalid') ? 'Bad Package' : 'Import failed', message: err.message });
  }
});

// ── Stats and analytics ──

router.get('/stats/dashboard', (req, res) => { res.json(store.getDashboardStats(getContainerScope(req) ?? null)); });

router.get('/projects', (req, res) => {
  res.json(store.listProjects(getContainerScope(req)));
});

router.get('/platforms', (req, res) => {
  res.json(store.listDistinctPlatforms(getContainerScope(req)));
});

router.get('/versions', (req, res) => {
  res.json(store.listDistinctVersions(getContainerScope(req)));
});

// ── Player feedback management routes ──

router.get('/player-feedback', requireRole('admin', 'operator'), (req, res) => {
  const q = req.query;
  res.json(store.listFeedback({
    container_id: getContainerScope(req),
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    status: q.status as string | undefined,
    category: q.category as string | undefined,
    search: q.search as string | undefined,
  }));
});

router.get('/player-feedback/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const feedback = store.getFeedbackById(id);
  if (!feedback) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...feedback, attachments: store.getFeedbackAttachments(id) });
});

router.put('/player-feedback/:id/status', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  const { status } = req.body ?? {};
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  if (!['new', 'in_progress', 'resolved', 'closed'].includes(status)) {
    res.status(400).json({ error: 'Invalid status', message: 'Status must be: new, in_progress, resolved, closed' });
    return;
  }
  if (!store.updateFeedbackStatus(id, status)) { res.status(404).json({ error: 'Feedback not found' }); return; }
  res.json({ success: true });
});

router.delete('/player-feedback/:id', requireRole('admin'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  if (!store.deleteFeedback(id)) { res.status(404).json({ error: 'Feedback not found' }); return; }
  res.json({ success: true });
});

router.get('/download/player-feedback/attachment/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const attachment = store.getFeedbackAttachmentById(id);
  if (!attachment) { res.status(404).json({ error: 'Attachment not found' }); return; }
  if (!existsSync(attachment.file_path)) { res.status(404).json({ error: 'File not on disk' }); return; }
  const safeFilename = attachment.filename.replace(/[^\w.\-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Content-Type', attachment.content_type || 'application/octet-stream');
  res.setHeader('Content-Length', attachment.file_size);
  createReadStream(attachment.file_path).pipe(res);
});

// ── Download routes (protected — require login to download data) ──

router.get('/download/attachment/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const att = store.getAttachmentById(id);
  if (!att) { res.status(404).json({ error: 'Attachment not found' }); return; }
  if (!existsSync(att.file_path)) { res.status(404).json({ error: 'File not on disk' }); return; }
  const safeFilename = att.filename.replace(/[^\w.\-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Content-Type', att.content_type || 'application/octet-stream');
  res.setHeader('Content-Length', att.file_size);
  createReadStream(att.file_path).pipe(res);
});

router.get('/download/report/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const report = store.getReportById(id);
  if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
  const json = JSON.stringify({ ...report, attachments: store.getAttachmentsForReport(id) }, null, 2);
  res.setHeader('Content-Disposition', `attachment; filename="crash-report-${id}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(json);
});

router.get('/download/group/:id', requireRole('admin', 'operator'), (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const group = store.getGroupById(id);
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  const { items: reports } = store.listReports({ group_id: id, page: 1, page_size: 10000 });
  const json = JSON.stringify({ group, total_reports: reports.length, reports }, null, 2);
  res.setHeader('Content-Disposition', `attachment; filename="crash-group-${id}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(json);
});

router.get('/download/dump/:reportId', requireRole('admin', 'operator'), (req, res) => {
  const reportId = parseInt(String(req.params.reportId), 10);
  if (isNaN(reportId)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const report = store.getReportById(reportId);
  if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
  let dumpInfo: any = report.dump_info;
  try { dumpInfo = JSON.parse(report.dump_info || '{}'); } catch { dumpInfo = { raw: report.dump_info }; }
  const json = JSON.stringify({
    report: { id: report.id, exception_type: report.exception_type, created_at: report.created_at },
    dump_info: dumpInfo,
    dump_attachments: store.getAttachmentsForReport(reportId).map(a => ({
      id: a.id, filename: a.filename, content_type: a.content_type, file_size: a.file_size,
      download_url: `/api/v1/download/attachment/${a.id}`,
    })),
  }, null, 2);
  res.setHeader('Content-Disposition', `attachment; filename="dump-info-${reportId}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(json);
});


// ── Admin: Clear all crashes ──

router.post('/clear-crashes', requireRole('admin'), (req, res) => {
  const paths = store.clearAllCrashes(getContainerScope(req));
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
  }
  res.json({ success: true, message: 'All crash data cleared' });
});


export default router;
