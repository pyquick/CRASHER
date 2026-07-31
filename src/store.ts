import { getDb } from './database.js';
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
} from './model.js';

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
  now: string
): CrashGroup {
  const stmt = getDb().prepare(`
    INSERT INTO crash_groups (crash_hash, exception_type, exception_message, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(hash, exceptionType, exceptionMessage, now, now);
  return {
    id: Number(result.lastInsertRowid),
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
  return getDb().prepare('SELECT * FROM crash_groups WHERE id = ?').get(id) as
    | CrashGroup
    | undefined;
}

export function listGroups(query: CrashGroupQuery): PaginatedResult<CrashGroup> {
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status) {
    conditions.push('status = ?');
    params.push(query.status);
  }
  if (query.search) {
    conditions.push('(exception_type LIKE ? OR exception_message LIKE ?)');
    const s = `%${query.search}%`;
    params.push(s, s);
  }
  if (query.start_date) {
    conditions.push('last_seen >= ?');
    params.push(query.start_date);
  }
  if (query.end_date) {
    conditions.push('last_seen <= ?');
    params.push(query.end_date);
  }
  if (query.error_severity) {
    conditions.push("id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.error_severity = ?)");
    params.push(query.error_severity);
  }
  if (query.platform) {
    conditions.push("id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.platform = ?)");
    params.push(query.platform);
  }
  if (query.app_version) {
    conditions.push("id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.app_version = ?)");
    params.push(query.app_version);
  }
  if (query.runtime) {
    conditions.push("id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.runtime = ?)");
    params.push(query.runtime);
  }
  if (query.environment) {
    conditions.push("id IN (SELECT DISTINCT cr.group_id FROM crash_reports cr WHERE cr.environment = ?)");
    params.push(query.environment);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortBy = query.sort_by ?? 'last_seen';
  const sortOrder = query.sort_order ?? 'desc';
  const allowedSorts = ['last_seen', 'first_seen', 'total_count', 'created_at', 'id'];
  const col = allowedSorts.includes(sortBy) ? sortBy : 'last_seen';
  const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

  const countRow = getDb()
    .prepare(`SELECT COUNT(*) as total FROM crash_groups ${where}`)
    .get(...params) as { total: number };
  const total = countRow.total;

  const items = getDb()
    .prepare(
      `SELECT cg.*,
              (SELECT cr.runtime FROM crash_reports cr WHERE cr.group_id = cg.id ORDER BY cr.created_at DESC LIMIT 1) as runtime,
              (SELECT cr.error_severity FROM crash_reports cr WHERE cr.group_id = cg.id ORDER BY cr.created_at DESC LIMIT 1) as error_severity
       FROM crash_groups cg ${where} ORDER BY ${col} ${order} LIMIT ? OFFSET ?`
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
  dumpInfo: string = ''
): CrashReport {
  const customData =
    typeof input.custom_data === 'object'
      ? JSON.stringify(input.custom_data)
      : (input.custom_data ?? '');

  const stmt = getDb().prepare(`
    INSERT INTO crash_reports (
      group_id, exception_type, exception_message, stack_trace, log_text,
      runtime, runtime_version, framework, environment, server_name, release, error_severity,
      unity_version, platform, device_model, os_version, gpu_name, cpu_name,
      memory_mb, app_version, bundle_id, scene_name, custom_data,
      client_ip, client_timestamp, created_at, dump_info, build_guid,
      symbolicated_stack, symbolication_info, symbolication_status, symbol_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    groupId,
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
  return getDb().prepare('SELECT * FROM crash_reports WHERE id = ?').get(id) as
    | CrashReport
    | undefined;
}

export function listReports(params: {
  group_id?: number;
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

  if (params.group_id) {
    conditions.push('group_id = ?');
    values.push(params.group_id);
  }
  if (params.platform) {
    conditions.push('platform = ?');
    values.push(params.platform);
  }
  if (params.app_version) {
    conditions.push('app_version = ?');
    values.push(params.app_version);
  }
  if (params.start_date) {
    conditions.push('created_at >= ?');
    values.push(params.start_date);
  }
  if (params.end_date) {
    conditions.push('created_at <= ?');
    values.push(params.end_date);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = getDb()
    .prepare(`SELECT COUNT(*) as total FROM crash_reports ${where}`)
    .get(...values) as { total: number };

  const items = getDb()
    .prepare(
      `SELECT * FROM crash_reports ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
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
  now: string
): PlayerFeedback {
  const customData = typeof input.custom_data === 'object'
    ? JSON.stringify(input.custom_data)
    : (input.custom_data ?? '');
  const result = getDb().prepare(`
    INSERT INTO player_feedback (
      title, description, category, severity, player_id, player_name, contact,
      app_version, platform, device_model, scene_name, custom_data,
      client_ip, client_timestamp, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
}): PaginatedResult<PlayerFeedback> {
  const page = params.page ?? 1;
  const pageSize = params.page_size ?? 20;
  const conditions: string[] = [];
  const values: unknown[] = [];
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
  architecture: string = ''
): Symbol {
  const stmt = getDb().prepare(`
    INSERT INTO symbols (platform, build_guid, filename, file_size, file_path, symbol_type, module_name, architecture)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(platform, buildGuid, filename, fileSize, filePath, symbolType, moduleName, architecture);
  return getDb()
    .prepare('SELECT * FROM symbols WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as Symbol;
}

export function listSymbols(params: {
  platform?: string;
  build_guid?: string;
  page?: number;
  page_size?: number;
}): PaginatedResult<Symbol> {
  const page = params.page ?? 1;
  const pageSize = params.page_size ?? 50;
  const conditions: string[] = [];
  const values: unknown[] = [];

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

export function getDashboardStats(): DashboardStats {
  const db = getDb();

  const totalCrashes = (
    db.prepare('SELECT COUNT(*) as c FROM crash_reports').get() as { c: number }
  ).c;
  const totalGroups = (
    db.prepare('SELECT COUNT(*) as c FROM crash_groups').get() as { c: number }
  ).c;
  const openGroups = (
    db
      .prepare("SELECT COUNT(*) as c FROM crash_groups WHERE status = 'open'")
      .get() as { c: number }
  ).c;
  const resolvedGroups = (
    db
      .prepare("SELECT COUNT(*) as c FROM crash_groups WHERE status = 'resolved'")
      .get() as { c: number }
  ).c;
  const crashesToday = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM crash_reports WHERE created_at >= date('now')"
      )
      .get() as { c: number }
  ).c;
  const crashesWeek = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM crash_reports WHERE created_at >= date('now', '-7 days')"
      )
      .get() as { c: number }
  ).c;

  const topCrashes = db
    .prepare(
      `SELECT g.id as group_id, g.exception_type, g.exception_message,
              g.total_count as count, g.last_seen
       FROM crash_groups g
       WHERE g.status = 'open'
       ORDER BY g.total_count DESC
       LIMIT 10`
    )
    .all() as DashboardStats['top_crashes'];

  const platformDistribution = db
    .prepare(
      `SELECT platform, COUNT(*) as count
       FROM crash_reports
       WHERE platform != ''
       GROUP BY platform
       ORDER BY count DESC`
    )
    .all() as DashboardStats['platform_distribution'];

  const versionDistribution = db
    .prepare(
      `SELECT app_version, COUNT(*) as count
       FROM crash_reports
       WHERE app_version != ''
       GROUP BY app_version
       ORDER BY count DESC
       LIMIT 20`
    )
    .all() as DashboardStats['version_distribution'];

  const dailyTrend = db
    .prepare(
      `SELECT date(created_at) as date, COUNT(*) as count
       FROM crash_reports
       WHERE created_at >= date('now', '-30 days')
       GROUP BY date(created_at)
       ORDER BY date ASC`
    )
    .all() as DashboardStats['daily_trend'];

  const runtimeDistribution = db
    .prepare(
      `SELECT runtime, COUNT(*) as count
       FROM crash_reports
       WHERE runtime != ''
       GROUP BY runtime
       ORDER BY count DESC`
    )
    .all() as DashboardStats['runtime_distribution'];

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
  };
}
