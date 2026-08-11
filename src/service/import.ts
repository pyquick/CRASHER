import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import * as store from '../store.js';
import { extractTarGzFile } from '../archive.js';

interface ImportResult {
  dry_run: boolean;
  conflicts?: Array<{ type: string; detail: string }>;
  new_groups: number;
  new_reports: number;
  new_attachments: number;
  group_id?: number;
}

export function extractImportBuffer(req: Record<string, any>): Buffer | null {
  const files = req.files as Array<{ buffer?: Buffer }> | undefined;
  const file = req.file as { buffer?: Buffer } | undefined;
  if (files?.[0]?.buffer) return files[0].buffer;
  if (file?.buffer) return file.buffer;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && req.body.startsWith('data:')) {
    const b64 = req.body.split(',')[1];
    return Buffer.from(b64, 'base64');
  }
  if (req.body?.data) {
    return Buffer.from(req.body.data, 'base64');
  }
  return null;
}

export function importCrashPackage(
  pkgBuffer: Buffer,
  confirm: boolean,
  containerId: number | null
): ImportResult {
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
    throw new Error('Failed to extract .crashpkg: ' + extractErr.message);
  }
  unlinkSync(tmpFile);

  // Parse manifest
  const manifestEntry = entries.find(e => e.name === 'manifest.json');
  if (!manifestEntry) {
    throw new Error('manifest.json not found in package');
  }

  let manifest: any;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf-8'));
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }

  if (!manifest.group || !Array.isArray(manifest.report_ids)) {
    throw new Error('Invalid manifest format');
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

  const result: ImportResult = {
    dry_run: !confirm,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    new_groups: conflicts.length > 0 ? 0 : 1,
    new_reports: manifest.report_count,
    new_attachments: 0,
  };

  if (!confirm) {
    // Dry-run: count attachments only
    let attCount = 0;
    for (const entry of entries) {
      if (entry.name.match(/^reports\/\d+\/(?!attachments\.json)[^/]+$/)) {
        attCount++;
      }
    }
    result.new_attachments = attCount;
    return result;
  }

  // ── Confirmed: write to DB ──
  const now = new Date().toISOString();

  const manifestProjectName = typeof manifest.group.project_name === 'string' ? manifest.group.project_name.trim() : '';
  const manifestProject = manifestProjectName ? store.getOrCreateProject(manifestProjectName, now, containerId) : undefined;

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
      now,
      manifestProject?.id ?? null,
      containerId,
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

    const importProjectName = typeof reportData.project_name === 'string' ? reportData.project_name.trim() : '';
    const importProject = importProjectName ? store.getOrCreateProject(importProjectName, now, containerId) : undefined;

    const newReport = store.createReport(
      {
        exception_type: reportData.exception_type,
        project_name: importProjectName,
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
      reportData.dump_info || '',
      importProject?.id ?? null,
      containerId,
    );

    oldToNewId.set(oldId, newReport.id);
    importedReports++;

    // Update symbolication fields if present
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

  return result;
}
