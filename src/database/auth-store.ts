import { getDb } from './connection.js';
import type { ApiKeyRecord, ApiKeyTier, Container, User, UserEmail, UserPhone, UserRole } from '../model.js';

// ── Users ──

export function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
}

export function insertUser(username: string, passwordHash: string, role: UserRole, containerId: number | null, totpMandatory: number): { lastInsertRowid: number | bigint } {
  return getDb().prepare(
    'INSERT INTO users (username, password_hash, role, container_id, totp_mandatory) VALUES (?, ?, ?, ?, ?)'
  ).run(username, passwordHash, role, containerId, totpMandatory);
}

export function findUserByUsername(username: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as User | undefined;
}

export function findUserByUsernameInContainer(username: string, containerId: number): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND container_id = ?').get(username, containerId) as User | undefined;
}

export function findUltraAdminByUsername(username: string): { username: string } | undefined {
  return getDb().prepare("SELECT username FROM users WHERE role = 'ultraadmin' AND username = ? COLLATE NOCASE").get(username) as { username: string } | undefined;
}

export function findUserById(id: number): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function listUsers(containerId?: number | null): Array<Omit<User, 'password_hash' | 'session_version'>> {
  if (containerId !== undefined && containerId !== null) {
    return getDb().prepare(
      "SELECT id, username, role, is_active, container_id, created_at, updated_at, last_login_at FROM users WHERE container_id = ? AND role != 'ultraadmin' ORDER BY username COLLATE NOCASE"
    ).all(containerId) as any[];
  }
  return getDb().prepare(
    'SELECT id, username, role, is_active, container_id, created_at, updated_at, last_login_at FROM users ORDER BY username COLLATE NOCASE'
  ).all() as any[];
}

export function updateUserRole(userId: number, role: UserRole, isActive: number): void {
  getDb().prepare(
    "UPDATE users SET role = ?, is_active = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?"
  ).run(role, isActive, userId);
}

export function invalidateUserSessions(userId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function updateUserPassword(userId: number, passwordHash: string): void {
  getDb().prepare(
    "UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?"
  ).run(passwordHash, userId);
}

export function updateUserLastLogin(userId: number): void {
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
}

export function countActiveAdminsInContainer(containerId?: number | null): number {
  if (containerId !== undefined && containerId !== null) {
    return (getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND container_id = ?").get(containerId) as { count: number }).count;
  }
  return (getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get() as { count: number }).count;
}

export function getUserContainerId(userId: number): number | null {
  const row = getDb().prepare('SELECT container_id FROM users WHERE id = ?').get(userId) as { container_id: number | null } | undefined;
  return row?.container_id ?? null;
}

export function findUserTotpSecret(userId: number): { totp_secret: string } | undefined {
  return getDb().prepare('SELECT totp_secret FROM users WHERE id = ? AND totp_enabled = 1').get(userId) as { totp_secret: string } | undefined;
}

export function enableUserTotp(userId: number, secret: string): void {
  getDb().prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, userId);
}

export function disableUserTotp(userId: number): void {
  getDb().prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(userId);
}

export function updateUserTwoFactorMethod(userId: number, method: string): void {
  getDb().prepare("UPDATE users SET two_factor_method = ?, updated_at = datetime('now') WHERE id = ?").run(method, userId);
}

// ── Sessions ──

export function insertSession(idHash: string, userId: number, sessionVersion: number, expiresAtSql: string): void {
  getDb().prepare(
    'INSERT INTO sessions (id_hash, user_id, session_version, expires_at) VALUES (?, ?, ?, ?)'
  ).run(idHash, userId, sessionVersion, expiresAtSql);
}

export function findValidSession(idHash: string, nowSql: string) {
  return getDb().prepare(
    `SELECT u.id, u.username, u.role, u.container_id, u.totp_enabled, u.is_active, u.session_version, s.session_version AS stored_version
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ?`
  ).get(idHash, nowSql) as any | undefined;
}

export function touchSession(idHash: string): void {
  getDb().prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id_hash = ?").run(idHash);
}

export function deleteSessionByHash(idHash: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

export function deleteExpiredSessions(nowSql: string): void {
  getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowSql);
}

export function deleteSessionsForUser(userId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function deleteSessionsForContainer(containerId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE container_id = ?)').run(containerId);
}

// ── API Keys ──

export function insertApiKey(userId: number, name: string, prefix: string, keyHash: string, tier: string, minuteLimit: number, dailyLimit: number, expiresAtSql: string | null): { lastInsertRowid: number | bigint } {
  return getDb().prepare(
    'INSERT INTO api_keys (user_id, name, key_prefix, key_hash, tier, minute_limit, daily_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, name, prefix, keyHash, tier, minuteLimit, dailyLimit, expiresAtSql);
}

export function listApiKeysForUser(userId: number | null, role: UserRole): Array<Omit<ApiKeyRecord, 'key_hash'>> {
  if (role === 'admin') {
    return getDb().prepare(
      'SELECT id, user_id, name, key_prefix, tier, minute_limit, daily_limit, expires_at, revoked_at, last_used_at, created_at FROM api_keys ORDER BY created_at DESC'
    ).all() as any[];
  }
  return getDb().prepare(
    'SELECT id, user_id, name, key_prefix, tier, minute_limit, daily_limit, expires_at, revoked_at, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as any[];
}

export function findApiKey(keyHash: string, nowSql: string) {
  return getDb().prepare(
    `SELECT k.id, k.tier, k.minute_limit, k.daily_limit, u.id AS user_id, u.username, u.role, u.container_id
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND u.is_active = 1
       AND (k.expires_at IS NULL OR k.expires_at > ?)`
  ).get(keyHash, nowSql) as any | undefined;
}

export function touchApiKey(id: number): void {
  getDb().prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

export function revokeApiKeyById(id: number, userId?: number): number {
  const where = userId ? 'id = ? AND user_id = ?' : 'id = ?';
  const params = userId ? [id, userId] : [id];
  return getDb().prepare(`UPDATE api_keys SET revoked_at = datetime('now') WHERE ${where} AND revoked_at IS NULL`).run(...params).changes;
}

export function updateApiKeyTier(id: number, tier: string): number {
  return getDb().prepare('UPDATE api_keys SET tier = ? WHERE id = ? AND revoked_at IS NULL').run(tier, id).changes;
}

export function updateApiKeyLimits(id: number, minuteLimit: number, dailyLimit: number): number {
  return getDb().prepare('UPDATE api_keys SET minute_limit = ?, daily_limit = ? WHERE id = ? AND revoked_at IS NULL').run(minuteLimit, dailyLimit, id).changes;
}

// ── API Key Quota ──

export function findApiKeyQuota(apiKeyId: number, periodStart: number, windowSeconds: number): number {
  const row = getDb().prepare(
    'SELECT request_count FROM api_key_usage WHERE api_key_id = ? AND period_start = ? AND period_seconds = ?'
  ).get(apiKeyId, periodStart, windowSeconds) as { request_count: number } | undefined;
  return row?.request_count ?? 0;
}

export function updateApiKeyQuota(apiKeyId: number, periodStart: number, windowSeconds: number, count: number): void {
  getDb().prepare(
    'UPDATE api_key_usage SET request_count = ? WHERE api_key_id = ? AND period_start = ? AND period_seconds = ?'
  ).run(count, apiKeyId, periodStart, windowSeconds);
}

export function insertApiKeyQuota(apiKeyId: number, periodStart: number, windowSeconds: number, count: number): void {
  getDb().prepare(
    'INSERT INTO api_key_usage (api_key_id, period_start, period_seconds, request_count) VALUES (?, ?, ?, ?)'
  ).run(apiKeyId, periodStart, windowSeconds, count);
}

// ── Containers ──

export function insertContainer(name: string, tier: number, createdBy: number): { lastInsertRowid: number | bigint } {
  return getDb().prepare('INSERT INTO containers (name, tier, created_by) VALUES (?, ?, ?)').run(name, tier, createdBy);
}

export function findContainerByName(name: string): Container | undefined {
  return getDb().prepare('SELECT * FROM containers WHERE name = ? COLLATE NOCASE').get(name) as Container | undefined;
}

export function findContainerById(id: number): Container | undefined {
  return getDb().prepare('SELECT * FROM containers WHERE id = ?').get(id) as Container | undefined;
}

export function listAllContainers(): Container[] {
  return getDb().prepare('SELECT * FROM containers ORDER BY name COLLATE NOCASE').all() as Container[];
}

export function listActiveContainers(): Container[] {
  return getDb().prepare('SELECT * FROM containers WHERE is_banned = 0 ORDER BY name COLLATE NOCASE').all() as Container[];
}

export function banContainer(id: number): void {
  getDb().prepare("UPDATE containers SET is_banned = 1, banned_at = datetime('now'), banned_notification_sent = 0 WHERE id = ?").run(id);
}

export function unbanContainer(id: number): void {
  getDb().prepare("UPDATE containers SET is_banned = 0, banned_at = NULL, banned_notification_sent = 0 WHERE id = ?").run(id);
}

export function markBanNotificationSent(containerId: number): void {
  getDb().prepare('UPDATE containers SET banned_notification_sent = 1 WHERE id = ?').run(containerId);
}

export function isContainerBanned(containerId: number): boolean {
  const c = getDb().prepare('SELECT is_banned FROM containers WHERE id = ?').get(containerId) as { is_banned: number } | undefined;
  return c?.is_banned === 1;
}

export function findContainerAdmins(containerId: number): { userId: number; email: string; username: string }[] {
  return getDb().prepare(
    `SELECT u.id AS userId, ue.email, u.username FROM users u
     JOIN user_emails ue ON ue.user_id = u.id AND ue.email_verified = 1 AND ue.is_primary = 1
     WHERE u.container_id = ? AND u.role = 'admin' AND u.is_active = 1`
  ).all(containerId) as any[];
}

export function sumCrashReportDataSize(containerId: number): number {
  return (getDb().prepare(
    "SELECT COALESCE(SUM(LENGTH(COALESCE(exception_type,'')) + LENGTH(COALESCE(exception_message,'')) + LENGTH(COALESCE(stack_trace,'')) + LENGTH(COALESCE(log_text,'')) + LENGTH(COALESCE(custom_data,'')) + LENGTH(COALESCE(dump_info,'')) + LENGTH(COALESCE(symbolicated_stack,'')) + LENGTH(COALESCE(symbolication_info,''))), 0) AS c FROM crash_reports WHERE container_id = ?"
  ).get(containerId) as { c: number }).c;
}

export function sumCrashAttachmentSize(containerId: number): number {
  return (getDb().prepare(
    'SELECT COALESCE(SUM(ca.file_size), 0) AS c FROM crash_attachments ca JOIN crash_reports cr ON cr.id = ca.crash_report_id WHERE cr.container_id = ?'
  ).get(containerId) as { c: number }).c;
}

export function sumFeedbackAttachmentSize(containerId: number): number {
  return (getDb().prepare(
    'SELECT COALESCE(SUM(fa.file_size), 0) AS c FROM feedback_attachments fa JOIN player_feedback pf ON pf.id = fa.feedback_id WHERE pf.container_id = ?'
  ).get(containerId) as { c: number }).c;
}

export function sumSymbolSize(containerId: number): number {
  return (getDb().prepare('SELECT COALESCE(SUM(file_size), 0) AS c FROM symbols WHERE container_id = ?').get(containerId) as { c: number }).c;
}

export function countUsersInContainer(containerId: number): number {
  return (getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE container_id = ? AND role != 'ultraadmin'").get(containerId) as { c: number }).c;
}

export function countCrashReportsInContainer(containerId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM crash_reports WHERE container_id = ?').get(containerId) as { c: number }).c;
}

export function countFeedbackInContainer(containerId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM player_feedback WHERE container_id = ?').get(containerId) as { c: number }).c;
}

export function countSymbolsInContainer(containerId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM symbols WHERE container_id = ?').get(containerId) as { c: number }).c;
}

export function getContainerTier(containerId: number): number | undefined {
  return (getDb().prepare('SELECT tier FROM containers WHERE id = ?').get(containerId) as { tier: number } | undefined)?.tier;
}

// Container delete helpers
export function getCrashAttachmentPaths(containerId: number): { file_path: string }[] {
  return getDb().prepare(
    'SELECT ca.file_path FROM crash_attachments ca JOIN crash_reports cr ON cr.id = ca.crash_report_id WHERE cr.container_id = ?'
  ).all(containerId) as { file_path: string }[];
}

export function getFeedbackAttachmentPaths(containerId: number): { file_path: string }[] {
  return getDb().prepare(
    'SELECT fa.file_path FROM feedback_attachments fa JOIN player_feedback pf ON pf.id = fa.feedback_id WHERE pf.container_id = ?'
  ).all(containerId) as { file_path: string }[];
}

export function getSourceFilePaths(containerId: number): { storage_path: string }[] {
  return getDb().prepare(
    'SELECT sf.storage_path FROM source_files sf JOIN source_snapshots ss ON ss.id = sf.snapshot_id WHERE ss.container_id = ?'
  ).all(containerId) as { storage_path: string }[];
}

export function getSymbolFilePaths(containerId: number): { file_path: string }[] {
  return getDb().prepare('SELECT file_path FROM symbols WHERE container_id = ?').all(containerId) as { file_path: string }[];
}

export function deleteContainerCascade(containerId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM crash_attachments WHERE crash_report_id IN (SELECT id FROM crash_reports WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM crash_reports WHERE container_id = ?').run(containerId);
  db.prepare('DELETE FROM crash_groups WHERE container_id = ?').run(containerId);
  db.prepare('DELETE FROM feedback_attachments WHERE feedback_id IN (SELECT id FROM player_feedback WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM player_feedback WHERE container_id = ?').run(containerId);
  db.prepare('DELETE FROM source_files WHERE snapshot_id IN (SELECT id FROM source_snapshots WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM source_snapshots WHERE container_id = ?').run(containerId);
  db.prepare('DELETE FROM symbols WHERE container_id = ?').run(containerId);
  db.prepare('DELETE FROM projects WHERE container_id = ?').run(containerId);
  db.prepare('DELETE FROM api_key_usage WHERE api_key_id IN (SELECT id FROM api_keys WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM api_keys WHERE container_id = ?').run(containerId);
  db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM user_emails WHERE user_id IN (SELECT id FROM users WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM user_phones WHERE user_id IN (SELECT id FROM users WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM password_reset_requests WHERE user_id IN (SELECT id FROM users WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE container_id = ?)').run(containerId);
  db.prepare('DELETE FROM users WHERE container_id = ?').run(containerId);
  db.prepare('DELETE FROM containers WHERE id = ?').run(containerId);
}

