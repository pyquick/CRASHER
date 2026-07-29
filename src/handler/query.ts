import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { getDb } from '../database.js';
import * as store from '../store.js';
import { analyzeCrash } from '../analysis/analyzer.js';
import { createTarGz, extractTarGzFile, cleanupArchive } from '../archive.js';
import { createReadStream, existsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { requireRole } from '../middleware.js';
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
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
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
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    group_id: q.group_id ? parseInt(String(q.group_id), 10) : undefined,
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

  const analysis = analyzeCrash({
    id: report.id,
    exception_type: report.exception_type,
    exception_message: report.exception_message,
    stack_trace: report.stack_trace,
    log_text: report.log_text,
    runtime: report.runtime,
    runtime_version: report.runtime_version,
    symbolicated_stack: report.symbolicated_stack || undefined,
  });

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
 * Import a .crashpkg (tar.gz) file. Accepts multipart/form-data with a single
 * "package" file field.
 *
 * Query params:
 *   ?confirm=true  — actually write to DB (otherwise dry-run)
 */
router.post('/import', requireRole('admin', 'operator'), importUpload.single('package'), async (req, res) => {
  try {
    // This endpoint needs raw body/multer. We handle it inline since we already
    // have a body parser set up. Check if we got a file via multer-like interface
    // or use a simple approach: accept base64-encoded package in JSON body, OR
    // use a dedicated multer upload here.

    // For simplicity, accept the .crashpkg as raw body (Content-Type: application/gzip
    // or application/octet-stream), or as multipart with field "package".

    // Express 5 body parsers handle this — but the simplest approach for the UI
    // is to accept multipart. Since this route is under queryHandler which doesn't
    // have multer, we'll handle both cases.

    const confirm = req.query.confirm === 'true';
    let pkgBuffer: Buffer | null = null;

    // Check for multipart file upload (if multer was applied)
    const files = (req as any).files as any[] | undefined;
    const file = (req as any).file;
    if (files?.[0]?.buffer) {
      pkgBuffer = files[0].buffer;
    } else if (file?.buffer) {
      pkgBuffer = file.buffer;
    } else if (Buffer.isBuffer((req as any).body)) {
      // Raw binary body
      pkgBuffer = (req as any).body;
    } else if (typeof (req as any).body === 'string' && (req as any).body.startsWith('data:')) {
      // Data URL (from file input via JS)
      const b64 = (req as any).body.split(',')[1];
      pkgBuffer = Buffer.from(b64, 'base64');
    } else if ((req as any).body?.data) {
      // JSON wrapper with base64 data
      pkgBuffer = Buffer.from((req as any).body.data, 'base64');
    }

    if (!pkgBuffer || pkgBuffer.length === 0) {
      res.status(400).json({ error: 'Bad Request', message: 'No package data received. Send a .crashpkg file as multipart/form-data with field name "package".' });
      return;
    }

    // Save to temp file for extraction
    const tmpDir = join(config.dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, `import-${Date.now()}.crashpkg`);
    writeFileSync(tmpFile, pkgBuffer);

    let entries;
    try {
      entries = extractTarGzFile(tmpFile);
    } catch (extractErr: any) {
      unlinkSync(tmpFile);
      res.status(400).json({ error: 'Bad Package', message: 'Failed to extract .crashpkg: ' + extractErr.message });
      return;
    }
    unlinkSync(tmpFile);

    // Parse manifest
    const manifestEntry = entries.find(e => e.name === 'manifest.json');
    if (!manifestEntry) {
      res.status(400).json({ error: 'Bad Package', message: 'manifest.json not found in package' });
      return;
    }

    let manifest: any;
    try {
      manifest = JSON.parse(manifestEntry.data.toString('utf-8'));
    } catch {
      res.status(400).json({ error: 'Bad Package', message: 'manifest.json is not valid JSON' });
      return;
    }

    if (!manifest.group || !Array.isArray(manifest.report_ids)) {
      res.status(400).json({ error: 'Bad Package', message: 'Invalid manifest format' });
      return;
    }

    // Check for conflicts
    const conflicts: Array<{ type: string; detail: string }> = [];
    const existingGroup = store.findGroupByHash(manifest.group.crash_hash);
    if (existingGroup) {
      conflicts.push({
        type: 'group_hash_conflict',
        detail: `Group hash ${manifest.group.crash_hash} already exists (id=${existingGroup.id}, type=${existingGroup.exception_type})`,
      });
    }

    const result: any = {
      dry_run: !confirm,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      new_groups: conflicts.length > 0 ? 0 : 1,
      new_reports: manifest.report_count,
      new_attachments: 0,
    };

    if (!confirm) {
      // Dry-run only
      // Count expected attachments
      let attCount = 0;
      for (const entry of entries) {
        const name = entry.name;
        if (name.match(/^reports\/\d+\/(?!attachments\.json)[^/]+$/)) {
          attCount++;
        }
      }
      result.new_attachments = attCount;
      res.json(result);
      return;
    }

    // ── Confirmed: write to DB ──
    const now = new Date().toISOString();

    // Map old report IDs to new report IDs for attachment linking
    const oldToNewId = new Map<number, number>();

    // Create group (skip if hash exists)
    let groupId: number;
    if (existingGroup) {
      groupId = existingGroup.id;
      result.new_groups = 0;
    } else {
      const newGroup = store.createGroup(
        manifest.group.crash_hash,
        manifest.group.exception_type,
        manifest.group.exception_message || '',
        now
      );
      groupId = newGroup.id;
    }

    let importedReports = 0;
    let importedAtts = 0;

    // Re-create each report
    for (const oldId of manifest.report_ids) {
      const reportEntry = entries.find(e => e.name === `reports/${oldId}.json`);
      if (!reportEntry) {
        console.warn(`[import] Report ${oldId}.json not found in package, skipping`);
        continue;
      }

      let reportData: any;
      try {
        reportData = JSON.parse(reportEntry.data.toString('utf-8'));
      } catch {
        console.warn(`[import] Report ${oldId}.json parse error, skipping`);
        continue;
      }

      // Create the report with the new group ID
      const newReport = store.createReport(
        {
          exception_type: reportData.exception_type,
          exception_message: reportData.exception_message,
          stack_trace: reportData.stack_trace,
          log_text: reportData.log_text,
          runtime: reportData.runtime,
          runtime_version: reportData.runtime_version,
          framework: reportData.framework,
          environment: reportData.environment,
          server_name: reportData.server_name,
          release: reportData.release,
          error_severity: reportData.error_severity || 'error',
          unity_version: reportData.unity_version,
          platform: reportData.platform,
          device_model: reportData.device_model,
          os_version: reportData.os_version,
          gpu_name: reportData.gpu_name,
          cpu_name: reportData.cpu_name,
          memory_mb: reportData.memory_mb,
          app_version: reportData.app_version,
          bundle_id: reportData.bundle_id,
          scene_name: reportData.scene_name,
          custom_data: reportData.custom_data,
          client_timestamp: reportData.client_timestamp,
          build_guid: reportData.build_guid,
        },
        groupId,
        reportData.client_ip || 'imported',
        reportData.created_at || now,
        reportData.dump_info || ''
      );

      oldToNewId.set(oldId, newReport.id);
      importedReports++;

      // Also update symbolication fields if present
      if (reportData.symbolicated_stack || reportData.symbolication_status) {
        store.updateReportSymbolication(newReport.id, {
          stack: reportData.symbolicated_stack || '',
          status: reportData.symbolication_status || 'not_applicable',
          symbol_id: undefined,
          frames: [],
          warnings: [],
        });
      }

      // Restore attachments for this report
      const attMetaEntry = entries.find(e => e.name === `reports/${oldId}/attachments.json`);
      let attMetas: any[] = [];
      if (attMetaEntry) {
        try { attMetas = JSON.parse(attMetaEntry.data.toString('utf-8')); } catch {}
      }

      for (const attMeta of attMetas) {
        const attEntry = entries.find(e =>
          e.name === attMeta.entry_name ||
          e.name === `reports/${oldId}/${attMeta.filename}`
        );
        if (!attEntry) {
          console.warn(`[import] Attachment data for ${attMeta.filename} not found`);
          continue;
        }

        const safeFilename = attMeta.filename.replace(/[^\w.\-]/g, '_');
        const attPath = join(config.attachmentsDir, `imported-${newReport.id}-${safeFilename}`);
        writeFileSync(attPath, attEntry.data);

        store.createAttachment(
          newReport.id,
          attMeta.filename,
          attMeta.content_type || 'application/octet-stream',
          attEntry.data.length,
          attPath
        );
        importedAtts++;
      }
    }

    result.new_groups = existingGroup ? 0 : 1;
    result.new_reports = importedReports;
    result.new_attachments = importedAtts;
    result.group_id = groupId;

    res.status(201).json(result);
  } catch (err: any) {
    console.error('[import] Error:', err);
    res.status(500).json({ error: 'Import failed', message: err.message });
  }
});

// ── Stats and analytics ──

router.get('/stats/dashboard', (_req, res) => { res.json(store.getDashboardStats()); });

router.get('/platforms', (_req, res) => {
  res.json((getDb().prepare("SELECT DISTINCT platform FROM crash_reports WHERE platform != '' ORDER BY platform").all() as any[]).map(r => r.platform));
});

router.get('/versions', (_req, res) => {
  res.json((getDb().prepare("SELECT DISTINCT app_version FROM crash_reports WHERE app_version != '' ORDER BY app_version DESC LIMIT 50").all() as any[]).map(r => r.app_version));
});

// ── Player feedback management routes ──

router.get('/player-feedback', requireRole('admin', 'operator'), (req, res) => {
  const q = req.query;
  res.json(store.listFeedback({
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

router.post('/clear-crashes', requireRole('admin'), (_req, res) => {
  const db = getDb();
  // Delete attachments files from disk
  const attachments = db.prepare('SELECT file_path FROM crash_attachments').all();
  for (const a of attachments as { file_path: string }[]) {
    try { if (existsSync(a.file_path)) unlinkSync(a.file_path); } catch {}
  }
  db.exec('DELETE FROM crash_attachments');
  db.exec('DELETE FROM crash_reports');
  db.exec('DELETE FROM crash_groups');
  res.json({ success: true, message: 'All crash data cleared' });
});


export default router;
