import { getDb } from './connection.js';
import { existsSync, unlinkSync } from 'fs';
import type {
  CrashGroup,
  CrashReport,
  CrashReportInput,
  CrashAttachment,
  PaginatedResult,
  CrashGroupQuery,
  DashboardStats,
  Symbol,
  PlayerFeedback,
  PlayerFeedbackInput,
  FeedbackAttachment,
  Project,
  SourceSnapshot,
  SourceFile,
} from '../model.js';

// ----- Projects and source snapshots -----

export function findProjectByName(name: string): Project | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE').get(name) as Project | undefined;
}

export function getOrCreateProject(name: string, now: string, containerId?: number | null): Project {
  // Look up by name within the container
  const existing = getDb().prepare(
    'SELECT * FROM projects WHERE name = ? COLLATE NOCASE AND (container_id = ? OR (container_id IS NULL AND ? IS NULL))'
  ).get(name, containerId ?? null, containerId ?? null) as Project | undefined;
  if (existing) {
    // Update timestamp
    getDb().prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, existing.id);
    existing.updated_at = now;
    return existing;
  }
  const result = getDb().prepare(`
    INSERT INTO projects (name, container_id, created_at, updated_at) VALUES (?, ?, ?, ?)
  `).run(name, containerId ?? null, now, now);
  return {
    id: Number(result.lastInsertRowid),
    name,
    created_at: now,
    updated_at: now,
  };
}

export function listProjects(containerId?: number | null): Array<Project & { crash_count: number }> {
  if (containerId !== undefined && containerId !== null) {
    return getDb().prepare(`
      SELECT p.*, COUNT(cr.id) AS crash_count
      FROM projects p
      LEFT JOIN crash_reports cr ON cr.project_id = p.id
      WHERE p.container_id = ?
      GROUP BY p.id
      ORDER BY p.name COLLATE NOCASE
    `).all(containerId) as Array<Project & { crash_count: number }>;
  }
  return getDb().prepare(`
    SELECT p.*, COUNT(cr.id) AS crash_count
    FROM projects p
    LEFT JOIN crash_reports cr ON cr.project_id = p.id
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE
  `).all() as Array<Project & { crash_count: number }>;
}

export function createSourceSnapshot(projectId: number, release: string, now: string): SourceSnapshot {
  const result = getDb().prepare(
    'INSERT INTO source_snapshots (project_id, release, created_at) VALUES (?, ?, ?)'
  ).run(projectId, release, now);
  return getDb().prepare('SELECT * FROM source_snapshots WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as SourceSnapshot;
}

export function deleteSourceSnapshot(id: number): void {
  getDb().prepare('DELETE FROM source_snapshots WHERE id = ?').run(id);
}

export function createSourceFile(
  snapshotId: number,
  relativePath: string,
  storagePath: string,
  fileSize: number,
  language: string
): SourceFile {
  const result = getDb().prepare(`
    INSERT INTO source_files (snapshot_id, relative_path, storage_path, file_size, language)
    VALUES (?, ?, ?, ?, ?)
  `).run(snapshotId, relativePath, storagePath, fileSize, language);
  return getDb().prepare('SELECT * FROM source_files WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as SourceFile;
}

export function findSourceSnapshot(projectId: number, release: string): (SourceSnapshot & { match_type: 'exact' | 'latest' }) | undefined {
  if (release) {
    const exact = getDb().prepare(`
      SELECT * FROM source_snapshots
      WHERE project_id = ? AND release = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(projectId, release) as SourceSnapshot | undefined;
    if (exact) return { ...exact, match_type: 'exact' };
  }
  const latest = getDb().prepare(`
    SELECT * FROM source_snapshots
    WHERE project_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(projectId) as SourceSnapshot | undefined;
  return latest ? { ...latest, match_type: 'latest' } : undefined;
}

export function getSourceFilesForSnapshot(snapshotId: number): SourceFile[] {
  return getDb().prepare(
    'SELECT * FROM source_files WHERE snapshot_id = ? ORDER BY relative_path'
  ).all(snapshotId) as SourceFile[];
}

// ----- Crash Groups -----

export function findGroupByHash(hash: string): CrashGroup | undefined {
  return getDb().prepare('SELECT * FROM crash_groups WHERE crash_hash = ?').get(hash) as
    | CrashGroup
    | undefined;
}

export function createGroup(
  hash: string,
  exceptionType: string,
  exceptionMessage: string,
  now: string,
  projectId: number | null = null,
  containerId: number | null = null,
): CrashGroup {
  const stmt = getDb().prepare(`
    INSERT INTO crash_groups (project_id, container_id, crash_hash, exception_type, exception_message, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(projectId, containerId, hash, exceptionType, exceptionMessage, now, now);
  return {
    id: Number(result.lastInsertRowid),
    project_id: projectId,
    crash_hash: hash,
    exception_type: exceptionType,
    exception_message: exceptionMessage,
    first_seen: now,
    last_seen: now,
    total_count: 1,
    status: 'open',
    resolved_version: '',
    created_at: now,
  };
}

export function updateGroupOnNewReport(groupId: number, now: string): void {
  getDb()
    .prepare(
      `UPDATE crash_groups SET last_seen = ?, total_count = total_count + 1 WHERE id = ?`
    )
    .run(now, groupId);
}

export function getGroupById(id: number): CrashGroup | undefined {
  return getDb().prepare(`
    SELECT cg.*, p.name AS project_name
    FROM crash_groups cg
    LEFT JOIN projects p ON p.id = cg.project_id
    WHERE cg.id = ?
  `).get(id) as CrashGroup | undefined;
}

export function listGroups(query: CrashGroupQuery & { container_id?: number | null }): PaginatedResult<CrashGroup> {
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.container_id !== undefined && query.container_id !== null) {
    conditions.push('cg.container_id = ?');
    params.push(query.container_id);
  }
  if (query.project_id !== undefined) {
    if (query.project_id === 0) {
      conditions.push('cg.project_id IS NULL');
    } else {
      conditions.push('cg.project_id = ?');
      params.push(query.project_id);
    }
  }
  if (query.status) {
    conditions.push('cg.status = ?');
    params.push(query.status);
  }
  if (query.search) {
    conditions.push('(cg.exception_type LIKE ? OR cg.exception_message LIKE ?)');
    const s = `%${query.search}%`;
    params.push(s, s);
  }
  if (query.start_date) {
    conditions.push('cg.last_seen >= ?');
    params.push(query.start_date);
  }
  if (query.end_date) {
    conditions.push('cg.last_seen <= ?');
    params.push(query.end_date);
  }
  if (query.error_severity) {
    conditions.push("cg.id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.error_severity = ?)");
    params.push(query.error_severity);
  }
  if (query.platform) {
    conditions.push("cg.id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.platform = ?)");
    params.push(query.platform);
  }
  if (query.app_version) {
    conditions.push("cg.id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.app_version = ?)");
    params.push(query.app_version);
  }
  if (query.runtime) {
    conditions.push("cg.id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.runtime = ?)");
    params.push(query.runtime);
  }
  if (query.environment) {
    conditions.push("cg.id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.environment = ?)");
    params.push(query.environment);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortBy = query.sort_by ?? 'last_seen';
  const sortOrder = query.sort_order ?? 'desc';
  const allowedSorts = ['last_seen', 'first_seen', 'total_count', 'created_at', 'id'];
  const col = allowedSorts.includes(sortBy) ? sortBy : 'last_seen';
  const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

  const countRow = getDb()
    .prepare(`SELECT COUNT(*) as total FROM crash_groups cg ${where}`)
    .get(...params) as { total: number };
  const total = countRow.total;

  const items = getDb()
    .prepare(
      `SELECT cg.*, p.name AS project_name,
              (SELECT cr.runtime FROM crash_reports cr WHERE cr.group_id = cg.id ORDER BY cr.created_at DESC LIMIT 1) as runtime,
              (SELECT cr.error_severity FROM crash_reports cr WHERE cr.group_id = cg.id ORDER BY cr.created_at DESC LIMIT 1) as error_severity
       FROM crash_groups cg
       LEFT JOIN projects p ON p.id = cg.project_id
       ${where} ORDER BY cg.${col} ${order} LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize) as CrashGroup[];

  return {
    items,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / pageSize),
  };
}

export function updateGroupStatus(
  id: number,
  status: string,
  resolvedVersion?: string
): boolean {
  const stmt = resolvedVersion
    ? getDb().prepare(
        'UPDATE crash_groups SET status = ?, resolved_version = ? WHERE id = ?'
      )
    : getDb().prepare('UPDATE crash_groups SET status = ? WHERE id = ?');

  const params = resolvedVersion ? [status, resolvedVersion, id] : [status, id];
  const result = stmt.run(...params);
  return result.changes > 0;
}

// ----- Crash Reports -----

export function createReport(
  input: CrashReportInput,
  groupId: number | null,
  clientIp: string,
  now: string,
  dumpInfo: string = '',
  projectId: number | null = null,
  containerId: number | null = null,
): CrashReport {
  const customData =
    typeof input.custom_data === 'object'
      ? JSON.stringify(input.custom_data)
      : (input.custom_data ?? '');

  const stmt = getDb().prepare(`
    INSERT INTO crash_reports (
      group_id, project_id, container_id, exception_type, exception_message, stack_trace, log_text,
      runtime, runtime_version, framework, environment, server_name, release, error_severity,
      unity_version, platform, device_model, os_version, gpu_name, cpu_name,
      memory_mb, app_version, bundle_id, scene_name, custom_data,
      client_ip, client_timestamp, created_at, dump_info, build_guid,
      symbolicated_stack, symbolication_info, symbolication_status, symbol_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    groupId,
    projectId,
    containerId,
    input.exception_type,
    input.exception_message ?? '',
    input.stack_trace ?? '',
    input.log_text ?? '',
    input.runtime ?? '',
    input.runtime_version ?? '',
    input.framework ?? '',
    input.environment ?? '',
    input.server_name ?? '',
    input.release ?? '',
    input.error_severity ?? 'error',
    input.unity_version ?? '',
    input.platform ?? '',
    input.device_model ?? '',
    input.os_version ?? '',
    input.gpu_name ?? '',
    input.cpu_name ?? '',
    input.memory_mb ?? 0,
    input.app_version ?? '',
    input.bundle_id ?? '',
    input.scene_name ?? '',
    customData,
    clientIp,
    input.client_timestamp ?? now,
    now,
    dumpInfo,
    input.build_guid ?? '',
    '',
    '',
    input.runtime === 'unity' ? 'unavailable' : 'not_applicable',
    null
  );

  return getReportById(Number(result.lastInsertRowid))!;
}

export function getReportById(id: number): CrashReport | undefined {
  return getDb().prepare(`
    SELECT cr.*, p.name AS project_name
    FROM crash_reports cr
    LEFT JOIN projects p ON p.id = cr.project_id
    WHERE cr.id = ?
  `).get(id) as CrashReport | undefined;
}

export function listReports(params: {
  group_id?: number;
  project_id?: number;
  container_id?: number | null;
  page?: number;
  page_size?: number;
  platform?: string;
  app_version?: string;
  start_date?: string;
  end_date?: string;
}): PaginatedResult<CrashReport> {
  const page = params.page ?? 1;
  const pageSize = params.page_size ?? 20;
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.container_id !== undefined && params.container_id !== null) {
    conditions.push('cr.container_id = ?');
    values.push(params.container_id);
  }
  if (params.project_id !== undefined) {
    if (params.project_id === 0) {
      conditions.push('cr.project_id IS NULL');
    } else {
      conditions.push('cr.project_id = ?');
      values.push(params.project_id);
    }
  }
  if (params.group_id) {
    conditions.push('cr.group_id = ?');
    values.push(params.group_id);
  }
  if (params.platform) {
    conditions.push('cr.platform = ?');
    values.push(params.platform);
  }
  if (params.app_version) {
    conditions.push('cr.app_version = ?');
    values.push(params.app_version);
  }
  if (params.start_date) {
    conditions.push('cr.created_at >= ?');
    values.push(params.start_date);
  }
  if (params.end_date) {
    conditions.push('cr.created_at <= ?');
    values.push(params.end_date);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = getDb()
    .prepare(`SELECT COUNT(*) as total FROM crash_reports cr ${where}`)
    .get(...values) as { total: number };

  const items = getDb()
    .prepare(
      `SELECT cr.*, p.name AS project_name
       FROM crash_reports cr
       LEFT JOIN projects p ON p.id = cr.project_id
       ${where} ORDER BY cr.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...values, pageSize, (page - 1) * pageSize) as CrashReport[];

  return {
    items,
    total: countRow.total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(countRow.total / pageSize),
  };
}

// ----- Symbolication -----

export function updateReportSymbolication(
  reportId: number,
  result: { stack: string; status: string; symbol_id?: number; frames: unknown[]; warnings: string[] }
): void {
  getDb().prepare(
    'UPDATE crash_reports SET symbolicated_stack = ?, symbolication_info = ?, symbolication_status = ?, symbol_id = ? WHERE id = ?'
  ).run(
    result.stack,
    JSON.stringify({ frames: result.frames, warnings: result.warnings }),
    result.status,
    result.symbol_id ?? null,
    reportId
  );
}

export function listReportsForSymbolication(buildGuid: string, platform?: string): CrashReport[] {
  const conditions = ["runtime = 'unity'", 'build_guid = ?'];
  const params: unknown[] = [buildGuid];
  if (platform) {
    conditions.push('platform = ?');
    params.push(platform);
  }
  return getDb().prepare(
    `SELECT * FROM crash_reports WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
  ).all(...params) as CrashReport[];
}

// ----- Attachments -----

export function createAttachment(
  crashReportId: number,
  filename: string,
  contentType: string,
  fileSize: number,
  filePath: string
): CrashAttachment {
  const stmt = getDb().prepare(`
    INSERT INTO crash_attachments (crash_report_id, filename, content_type, file_size, file_path)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(crashReportId, filename, contentType, fileSize, filePath);
  return getDb()
    .prepare('SELECT * FROM crash_attachments WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as CrashAttachment;
}

export function getAttachmentsForReport(reportId: number): CrashAttachment[] {
  return getDb()
    .prepare('SELECT * FROM crash_attachments WHERE crash_report_id = ? ORDER BY created_at')
    .all(reportId) as CrashAttachment[];
}

export function getAttachmentById(id: number): CrashAttachment | undefined {
  return getDb()
    .prepare('SELECT * FROM crash_attachments WHERE id = ?')
    .get(id) as CrashAttachment | undefined;
}

// ----- Player Feedback -----

export function createFeedback(
  input: PlayerFeedbackInput,
  clientIp: string,
  now: string,
  containerId: number | null = null,
): PlayerFeedback {
  const customData = typeof input.custom_data === 'object'
    ? JSON.stringify(input.custom_data)
    : (input.custom_data ?? '');
  const result = getDb().prepare(`
    INSERT INTO player_feedback (
      container_id, title, description, category, severity, player_id, player_name, contact,
      app_version, platform, device_model, scene_name, custom_data,
      client_ip, client_timestamp, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    containerId,
    input.title,
    input.description,
    input.category ?? 'bug',
    input.severity ?? 'normal',
    input.player_id ?? '',
    input.player_name ?? '',
    input.contact ?? '',
    input.app_version ?? '',
    input.platform ?? '',
    input.device_model ?? '',
    input.scene_name ?? '',
    customData,
    clientIp,
    input.client_timestamp ?? now,
    now,
    now
  );
  return getFeedbackById(Number(result.lastInsertRowid))!;
}

export function getFeedbackById(id: number): PlayerFeedback | undefined {
  return getDb().prepare('SELECT * FROM player_feedback WHERE id = ?').get(id) as PlayerFeedback | undefined;
}

export function listFeedback(params: {
  page?: number;
  page_size?: number;
  status?: string;
  category?: string;
  search?: string;
  container_id?: number | null;
}): PaginatedResult<PlayerFeedback> {
  const page = params.page ?? 1;
  const pageSize = params.page_size ?? 20;
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.container_id !== undefined && params.container_id !== null) { conditions.push('container_id = ?'); values.push(params.container_id); }
  if (params.status) { conditions.push('status = ?'); values.push(params.status); }
  if (params.category) { conditions.push('category = ?'); values.push(params.category); }
  if (params.search) {
    conditions.push('(title LIKE ? OR description LIKE ? OR player_name LIKE ?)');
    const search = `%${params.search}%`;
    values.push(search, search, search);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (getDb().prepare(`SELECT COUNT(*) AS total FROM player_feedback ${where}`).get(...values) as { total: number }).total;
  const items = getDb().prepare(
    `SELECT * FROM player_feedback ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...values, pageSize, (page - 1) * pageSize) as PlayerFeedback[];
  return { items, total, page, page_size: pageSize, total_pages: Math.ceil(total / pageSize) };
}

export function updateFeedbackStatus(id: number, status: string): boolean {
  const result = getDb().prepare(
    "UPDATE player_feedback SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, id);
  return result.changes > 0;
}

export function deleteFeedback(id: number): boolean {
  const db = getDb();
  const attachments = getFeedbackAttachments(id);
  for (const a of attachments) {
    try { if (existsSync(a.file_path)) unlinkSync(a.file_path); } catch {}
  }
  db.prepare('DELETE FROM feedback_attachments WHERE feedback_id = ?').run(id);
  return db.prepare('DELETE FROM player_feedback WHERE id = ?').run(id).changes > 0;
}

export function createFeedbackAttachment(
  feedbackId: number,
  filename: string,
  contentType: string,
  fileSize: number,
  filePath: string
): FeedbackAttachment {
  const result = getDb().prepare(`
    INSERT INTO feedback_attachments (feedback_id, filename, content_type, file_size, file_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(feedbackId, filename, contentType, fileSize, filePath);
  return getDb().prepare('SELECT * FROM feedback_attachments WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as FeedbackAttachment;
}

export function getFeedbackAttachments(feedbackId: number): FeedbackAttachment[] {
  return getDb().prepare('SELECT * FROM feedback_attachments WHERE feedback_id = ? ORDER BY created_at')
    .all(feedbackId) as FeedbackAttachment[];
}

export function getFeedbackAttachmentById(id: number): FeedbackAttachment | undefined {
  return getDb().prepare('SELECT * FROM feedback_attachments WHERE id = ?').get(id) as FeedbackAttachment | undefined;
}


export function createSymbol(
  platform: string,
  buildGuid: string,
  filename: string,
  fileSize: number,
  filePath: string,
  symbolType: string = 'unknown',
  moduleName: string = '',
  architecture: string = '',
  containerId: number | null = null,
): Symbol {
  const stmt = getDb().prepare(`
    INSERT INTO symbols (platform, build_guid, filename, file_size, file_path, symbol_type, module_name, architecture, container_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(platform, buildGuid, filename, fileSize, filePath, symbolType, moduleName, architecture, containerId);
  return getDb()
    .prepare('SELECT * FROM symbols WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as Symbol;
}

export function listSymbols(params: {
  platform?: string;
  build_guid?: string;
  container_id?: number | null;
  page?: number;
  page_size?: number;
}): PaginatedResult<Symbol> {
  const page = params.page ?? 1;
  const pageSize = params.page_size ?? 50;
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.container_id !== undefined && params.container_id !== null) {
    conditions.push('container_id = ?');
    values.push(params.container_id);
  }
  if (params.platform) {
    conditions.push('platform = ?');
    values.push(params.platform);
  }
  if (params.build_guid) {
    conditions.push('build_guid = ?');
    values.push(params.build_guid);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = getDb()
    .prepare(`SELECT COUNT(*) as total FROM symbols ${where}`)
    .get(...values) as { total: number };

  const items = getDb()
    .prepare(
      `SELECT * FROM symbols ${where} ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`
    )
    .all(...values, pageSize, (page - 1) * pageSize) as Symbol[];

  return {
    items,
    total: countRow.total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(countRow.total / pageSize),
  };
}

export function getSymbolById(id: number): Symbol | undefined {
  return getDb().prepare('SELECT * FROM symbols WHERE id = ?').get(id) as Symbol | undefined;
}

export function deleteSymbol(id: number): boolean {
  const symbol = getSymbolById(id);
  if (!symbol) return false;
  // File deletion is handled by the caller
  getDb().prepare('DELETE FROM symbols WHERE id = ?').run(id);
  return true;
}

// ----- Dashboard Stats -----

export function getDashboardStats(containerId?: number | null): DashboardStats {
  const db = getDb();
  const whereClause = containerId != null ? 'WHERE container_id = ?' : '';
  const whereParam = containerId != null ? [containerId] : [];
  const groupWhere = containerId != null ? "WHERE container_id = ? AND status = 'open'" : "WHERE status = 'open'";
  const groupResolvedWhere = containerId != null ? "WHERE container_id = ? AND status = 'resolved'" : "WHERE status = 'resolved'";
  const gp = containerId != null ? [containerId] : [];

  const totalCrashes = (
    db.prepare(`SELECT COUNT(*) as c FROM crash_reports ${whereClause}`).get(...whereParam) as { c: number }
  ).c;
  const totalGroups = (
    db.prepare(`SELECT COUNT(*) as c FROM crash_groups ${whereClause}`).get(...whereParam) as { c: number }
  ).c;
  const openGroups = (
    db.prepare(`SELECT COUNT(*) as c FROM crash_groups ${groupWhere}`).get(...gp) as { c: number }
  ).c;
  const resolvedGroups = (
    db.prepare(`SELECT COUNT(*) as c FROM crash_groups ${groupResolvedWhere}`).get(...gp) as { c: number }
  ).c;
  const todayFilter = containerId != null ? "container_id = ? AND created_at >= date('now')" : "created_at >= date('now')";
  const weekFilter = containerId != null ? "container_id = ? AND created_at >= date('now', '-7 days')" : "created_at >= date('now', '-7 days')";
  const crashesToday = (
    db.prepare(`SELECT COUNT(*) as c FROM crash_reports WHERE ${todayFilter}`).get(...whereParam) as { c: number }
  ).c;
  const crashesWeek = (
    db.prepare(`SELECT COUNT(*) as c FROM crash_reports WHERE ${weekFilter}`).get(...whereParam) as { c: number }
  ).c;

  const topCrashes = db
    .prepare(
      `SELECT g.id as group_id, g.exception_type, g.exception_message,
              g.total_count as count, g.last_seen
       FROM crash_groups g
       ${containerId != null ? "WHERE g.container_id = ? AND g.status = 'open'" : "WHERE g.status = 'open'"}
       ORDER BY g.total_count DESC
       LIMIT 10`
    )
    .all(...(containerId != null ? [containerId] : [])) as DashboardStats['top_crashes'];

  const platformDistribution = db
    .prepare(
      `SELECT platform, COUNT(*) as count
       FROM crash_reports
       WHERE platform != '' ${containerId != null ? 'AND container_id = ?' : ''}
       GROUP BY platform
       ORDER BY count DESC`
    )
    .all(...(containerId != null ? [containerId] : [])) as DashboardStats['platform_distribution'];

  const versionDistribution = db
    .prepare(
      `SELECT app_version, COUNT(*) as count
       FROM crash_reports
       WHERE app_version != '' ${containerId != null ? 'AND container_id = ?' : ''}
       GROUP BY app_version
       ORDER BY count DESC
       LIMIT 20`
    )
    .all(...(containerId != null ? [containerId] : [])) as DashboardStats['version_distribution'];

  const dailyTrend = db
    .prepare(
      `SELECT date(created_at) as date, COUNT(*) as count
       FROM crash_reports
       WHERE created_at >= date('now', '-30 days') ${containerId != null ? 'AND container_id = ?' : ''}
       GROUP BY date(created_at)
       ORDER BY date ASC`
    )
    .all(...(containerId != null ? [containerId] : [])) as DashboardStats['daily_trend'];

  const runtimeDistribution = db
    .prepare(
      `SELECT runtime, COUNT(*) as count
       FROM crash_reports
       WHERE runtime != '' ${containerId != null ? 'AND container_id = ?' : ''}
       GROUP BY runtime
       ORDER BY count DESC`
    )
    .all(...(containerId != null ? [containerId] : [])) as DashboardStats['runtime_distribution'];

  const environmentDistribution = db
    .prepare(
      `SELECT COALESCE(NULLIF(environment, ''), 'production') as environment, COUNT(*) as count
       FROM crash_reports
       ${whereClause}
       GROUP BY environment
       ORDER BY count DESC`
    )
    .all(...whereParam) as DashboardStats['environment_distribution'];

  return {
    total_crashes: totalCrashes,
    total_groups: totalGroups,
    open_groups: openGroups,
    resolved_groups: resolvedGroups,
    crashes_today: crashesToday,
    crashes_week: crashesWeek,
    top_crashes: topCrashes,
    platform_distribution: platformDistribution,
    version_distribution: versionDistribution,
    runtime_distribution: runtimeDistribution,
    daily_trend: dailyTrend,
    environment_distribution: environmentDistribution,
  };
}

// ── Dashboard filter helpers ──

export function listDistinctPlatforms(containerId?: number | null): string[] {
  if (containerId) {
    return (getDb().prepare("SELECT DISTINCT platform FROM crash_reports WHERE platform != '' AND container_id = ? ORDER BY platform").all(containerId) as any[]).map((r: any) => r.platform);
  }
  return (getDb().prepare("SELECT DISTINCT platform FROM crash_reports WHERE platform != '' ORDER BY platform").all() as any[]).map((r: any) => r.platform);
}

export function listDistinctVersions(containerId?: number | null): string[] {
  if (containerId) {
    return (getDb().prepare("SELECT DISTINCT app_version FROM crash_reports WHERE app_version != '' AND container_id = ? ORDER BY app_version DESC LIMIT 50").all(containerId) as any[]).map((r: any) => r.app_version);
  }
  return (getDb().prepare("SELECT DISTINCT app_version FROM crash_reports WHERE app_version != '' ORDER BY app_version DESC LIMIT 50").all() as any[]).map((r: any) => r.app_version);
}

// ── Clear crashes ──

export function clearAllCrashes(containerId?: number | null): string[] {
  const db = getDb();
  const attachmentPaths = (containerId
    ? db.prepare('SELECT ca.file_path FROM crash_attachments ca JOIN crash_reports cr ON cr.id = ca.crash_report_id WHERE cr.container_id = ?').all(containerId)
    : db.prepare('SELECT file_path FROM crash_attachments').all()
  ) as { file_path: string }[];

  if (containerId) {
    db.prepare('DELETE FROM crash_attachments WHERE crash_report_id IN (SELECT id FROM crash_reports WHERE container_id = ?)').run(containerId);
    db.prepare('DELETE FROM crash_reports WHERE container_id = ?').run(containerId);
    db.prepare('DELETE FROM crash_groups WHERE container_id = ?').run(containerId);
  } else {
    db.exec('DELETE FROM crash_attachments');
    db.exec('DELETE FROM crash_reports');
    db.exec('DELETE FROM crash_groups');
  }

  return attachmentPaths.map((a: { file_path: string }) => a.file_path);
}
