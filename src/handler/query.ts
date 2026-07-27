import { Router, type Request, type Response } from 'express';
import { getDb } from '../database.js';
import * as store from '../store.js';

/**
 * Protected data-viewing routes (auth required).
 * All routes mounted under /api/v1 with requireApiAuth middleware.
 */
const router = Router();

// ── Crash group query routes ──

router.get('/crash-groups', (req, res) => {
  const q = req.query;
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

// ── Crash report query routes ──

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

// ── Stats and analytics ──

router.get('/stats/dashboard', (_req, res) => { res.json(store.getDashboardStats()); });

router.get('/platforms', (_req, res) => {
  res.json((getDb().prepare("SELECT DISTINCT platform FROM crash_reports WHERE platform != '' ORDER BY platform").all() as any[]).map(r => r.platform));
});

router.get('/versions', (_req, res) => {
  res.json((getDb().prepare("SELECT DISTINCT app_version FROM crash_reports WHERE app_version != '' ORDER BY app_version DESC LIMIT 50").all() as any[]).map(r => r.app_version));
});

import { createReadStream, existsSync, unlinkSync } from 'fs';

// ── Player feedback management routes ──

router.get('/player-feedback', (req, res) => {
  const q = req.query;
  res.json(store.listFeedback({
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 20, 100),
    status: q.status as string | undefined,
    category: q.category as string | undefined,
    search: q.search as string | undefined,
  }));
});

router.get('/player-feedback/:id', (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const feedback = store.getFeedbackById(id);
  if (!feedback) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...feedback, attachments: store.getFeedbackAttachments(id) });
});

router.put('/player-feedback/:id/status', (req, res) => {
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

router.get('/download/player-feedback/attachment/:id', (req, res) => {
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

router.get('/download/attachment/:id', (req, res) => {
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

router.get('/download/report/:id', (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const report = store.getReportById(id);
  if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
  const json = JSON.stringify({ ...report, attachments: store.getAttachmentsForReport(id) }, null, 2);
  res.setHeader('Content-Disposition', `attachment; filename="crash-report-${id}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(json);
});

router.get('/download/group/:id', (req, res) => {
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

router.get('/download/dump/:reportId', (req, res) => {
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

router.post('/clear-crashes', (_req, res) => {
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
