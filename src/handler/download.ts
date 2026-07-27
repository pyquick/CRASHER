import { Router } from 'express';
import { createReadStream, existsSync } from 'fs';
import * as store from '../store.js';

const router = Router();

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

export default router;
