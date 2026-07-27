import { getDb } from './database.js';
import type {
  CrashGroup,
  CrashReport,
  CrashReportInput,
  CrashAttachment,
  PaginatedResult,
  CrashGroupQuery,
  DashboardStats,
  Symbol,
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
      `SELECT * FROM crash_groups ${where} ORDER BY ${col} ${order} LIMIT ? OFFSET ?`
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
      unity_version, platform, device_model, os_version, gpu_name, cpu_name,
      memory_mb, app_version, bundle_id, scene_name, custom_data,
      client_ip, client_timestamp, created_at, dump_info
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    groupId,
    input.exception_type,
    input.exception_message ?? '',
    input.stack_trace ?? '',
    input.log_text ?? '',
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
    dumpInfo
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

// ----- Symbols -----

export function createSymbol(
  platform: string,
  buildGuid: string,
  filename: string,
  fileSize: number,
  filePath: string
): Symbol {
  const stmt = getDb().prepare(`
    INSERT INTO symbols (platform, build_guid, filename, file_size, file_path)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(platform, buildGuid, filename, fileSize, filePath);
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
    daily_trend: dailyTrend,
  };
}
