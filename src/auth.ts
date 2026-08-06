import { createHash, createHmac, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { config } from './config.js';
import { getDb } from './database.js';
import type { ApiKeyRecord, ApiKeyTier, AuthenticatedUser, User, UserEmail, UserRole } from './model.js';

const SCRYPT_KEY_LENGTH = 64;
// SHA-256 via PBKDF2: 128-bit salt, 310,000 iterations, 32-byte output (256-bit)
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 310_000;
// PBKDF2 minimum iterations (OWASP 2023 recommendation for SHA-256: 600,000)
// We use 310k for server performance; adjust higher if needed
const RESET_TOKEN_LENGTH = 32;
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;

function hashLookupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function validateUsername(username: string): string | null {
  if (!USERNAME_PATTERN.test(username)) {
    return 'Username must be 3-64 characters and contain only letters, numbers, dot, underscore, or hyphen';
  }
  return null;
}

export function validatePassword(password: string, username = ''): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 256) return 'Password must be at most 256 characters';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must include uppercase, lowercase, number, and special character';
  }
  if (username.length >= 4 && password.toLowerCase().includes(username.toLowerCase())) {
    return 'Password must not contain the username';
  }
  return null;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derivedKey = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha256');
  return `pbkdf2-sha256$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const parts = encoded.split('$');
    const algorithm = parts[0];
    if (algorithm === 'pbkdf2-sha256' && parts.length >= 3) {
      const saltEncoded = parts[1];
      const hashEncoded = parts[2];
      if (!saltEncoded || !hashEncoded) return false;
      const expected = Buffer.from(hashEncoded, 'base64url');
      const actual = pbkdf2Sync(password, Buffer.from(saltEncoded, 'base64url'), PBKDF2_ITERATIONS, expected.length, 'sha256');
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    }
    if (algorithm === 'scrypt' && parts.length >= 3) {
      const saltEncoded = parts[1];
      const hashEncoded = parts[2];
      if (!saltEncoded || !hashEncoded) return false;
      const expected = Buffer.from(hashEncoded, 'base64url');
      const actual = scryptSync(password, Buffer.from(saltEncoded, 'base64url'), expected.length);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check whether a stored password hash uses the current (SHA-256) algorithm.
 * Used to trigger automatic upgrade of legacy scrypt hashes on login.
 */
export function passwordIsCurrent(encoded: string): boolean {
  return encoded.startsWith('pbkdf2-sha256$');
}

function publicUser(user: { id: number; username: string; role: UserRole; totp_enabled?: number | null }): AuthenticatedUser {
  return { id: user.id, username: user.username, role: user.role, totp_enabled: user.totp_enabled ?? 0 };
}

export function hasUsers(): boolean {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count > 0;
}

export function generateInitialPassword(): string {
  return `V9!${randomBytes(24).toString('base64url')}`;
}

export function createUser(username: string, password: string, role: UserRole): AuthenticatedUser {
  const normalizedUsername = username.trim();
  const usernameError = validateUsername(normalizedUsername);
  if (usernameError) throw new Error(usernameError);
  const passwordError = validatePassword(password, normalizedUsername);
  if (passwordError) throw new Error(passwordError);
  if (!['admin', 'operator', 'viewer'].includes(role)) throw new Error('Invalid role');

  const result = getDb().prepare(`
    INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
  `).run(normalizedUsername, hashPassword(password), role);
  return { id: Number(result.lastInsertRowid), username: normalizedUsername, role };
}

export function authenticateUser(username: string, password: string): AuthenticatedUser | null {
  const user = getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username.trim()) as User | undefined;
  const fallback = 'pbkdf2-sha256$AAAAAAAAAAAAAAAAAAAAAA$' + Buffer.alloc(PBKDF2_KEY_LENGTH).toString('base64url');
  const valid = verifyPassword(password, user?.password_hash ?? fallback);
  if (!user || !valid || user.is_active !== 1) return null;
  // Auto-upgrade legacy scrypt hashes to SHA-256 on successful login
  if (!passwordIsCurrent(user.password_hash)) {
    getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
  }
  return publicUser(user);
}

export function listUsers(): Array<Omit<User, 'password_hash' | 'session_version'>> {
  return getDb().prepare(`
    SELECT id, username, role, is_active, created_at, updated_at, last_login_at
    FROM users ORDER BY username COLLATE NOCASE
  `).all() as Array<Omit<User, 'password_hash' | 'session_version'>>;
}

export function getUserById(id: number): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function lookupUserByUsername(username: string): User | null {
  return getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username.trim()) as User | undefined || null;
}

export function updateUser(id: number, changes: { role?: UserRole; is_active?: boolean }, actorId?: number): boolean {
  const user = getUserById(id);
  if (!user) return false;
  if (actorId === id && changes.is_active === false) throw new Error('You cannot disable your own account');
  const role = changes.role ?? user.role;
  const active = changes.is_active === undefined ? user.is_active : changes.is_active ? 1 : 0;
  if (!['admin', 'operator', 'viewer'].includes(role)) throw new Error('Invalid role');
  if (user.role === 'admin' && user.is_active === 1 && (role !== 'admin' || active === 0) && countActiveAdmins() <= 1) {
    throw new Error('At least one active admin account is required');
  }
  getDb().prepare(`
    UPDATE users SET role = ?, is_active = ?, session_version = session_version + 1,
      updated_at = datetime('now') WHERE id = ?
  `).run(role, active, id);
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return true;
}

function countActiveAdmins(): number {
  return (getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get() as { count: number }).count;
}

export function changePassword(actor: AuthenticatedUser, userId: number, currentPassword: string | undefined, newPassword: string): boolean {
  const user = getUserById(userId);
  if (!user) return false;
  if (actor.id !== userId && actor.role !== 'admin') throw new Error('Insufficient permissions');
  if (actor.id === userId && !currentPassword) throw new Error('Current password is required');
  if (actor.id === userId && !verifyPassword(currentPassword!, user.password_hash)) throw new Error('Current password is incorrect');
  const passwordError = validatePassword(newPassword, user.username);
  if (passwordError) throw new Error(passwordError);
  if (verifyPassword(newPassword, user.password_hash)) throw new Error('New password must be different from the current password');

  getDb().prepare(`
    UPDATE users SET password_hash = ?, session_version = session_version + 1,
      updated_at = datetime('now') WHERE id = ?
  `).run(hashPassword(newPassword), userId);
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return true;
}

function padNum(n: number): string {
  return String(n).padStart(2, '0');
}

function nowSqlDateTime(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${padNum(d.getUTCMonth() + 1)}-${padNum(d.getUTCDate())} ${padNum(d.getUTCHours())}:${padNum(d.getUTCMinutes())}:${padNum(d.getUTCSeconds())}`;
}

export function createSession(userId: number): string {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) throw new Error('User is not active');
  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionHours * 60 * 60 * 1000);
  const expiresAtSql = `${expiresAt.getUTCFullYear()}-${padNum(expiresAt.getUTCMonth() + 1)}-${padNum(expiresAt.getUTCDate())} ${padNum(expiresAt.getUTCHours())}:${padNum(expiresAt.getUTCMinutes())}:${padNum(expiresAt.getUTCSeconds())}`;
  getDb().prepare(`
    INSERT INTO sessions (id_hash, user_id, session_version, expires_at) VALUES (?, ?, ?, ?)
  `).run(hashLookupToken(rawToken), user.id, user.session_version, expiresAtSql);
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  return rawToken;
}

export function getValidSession(rawToken: string, now: string): { user: AuthenticatedUser } | null {
  const row = getDb().prepare(`
    SELECT u.id, u.username, u.role, u.totp_enabled, u.is_active, u.session_version, s.session_version AS stored_version
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id_hash = ? AND s.expires_at > ?
  `).get(hashLookupToken(rawToken), nowSqlDateTime()) as (AuthenticatedUser & { is_active: number; session_version: number; stored_version: number }) | undefined;
  if (!row || row.is_active !== 1 || row.session_version !== row.stored_version) return null;
  getDb().prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id_hash = ?").run(hashLookupToken(rawToken));
  return { user: publicUser(row) };
}

export function deleteSession(rawToken: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashLookupToken(rawToken));
}

export function purgeExpiredSessions(): void {
  getDb().prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(nowSqlDateTime());
}

export interface ApiKeyLimits {
  minute_limit: number;
  daily_limit: number;
}

function normalizeApiKeyLimit(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error(`${field} must be an integer between 0 and 1000000000`);
  }
  return value;
}

export function createApiKey(
  userId: number,
  name: string,
  tier: ApiKeyTier = 'operator',
  expiresAt?: string,
  limits: Partial<ApiKeyLimits> = {}
): { id: number; name: string; key: string; key_prefix: string } {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) throw new Error('User is not active');
  if (!['admin', 'operator', 'viewer'].includes(tier)) throw new Error('Invalid API key tier');
  // Non-admin users can only create operator or viewer keys
  if (user.role !== 'admin' && tier === 'admin') throw new Error('Only admins can create admin-tier API keys');
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 100) throw new Error('API key name must be 1-100 characters');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error('Invalid expiration date');
  const expiresAtSql = expiresAt ? new Date(expiresAt).toISOString().replace('T', ' ').replace('Z', '') : null;
  const minuteLimit = normalizeApiKeyLimit(limits.minute_limit, 'minute_limit');
  const dailyLimit = normalizeApiKeyLimit(limits.daily_limit, 'daily_limit');

  const key = `crs_${randomBytes(32).toString('base64url')}`;
  const prefix = key.substring(0, 12);
  const result = getDb().prepare(`
    INSERT INTO api_keys (user_id, name, key_prefix, key_hash, tier, minute_limit, daily_limit, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, normalizedName, prefix, hashLookupToken(key), tier, minuteLimit, dailyLimit, expiresAtSql);
  return { id: Number(result.lastInsertRowid), name: normalizedName, key, key_prefix: prefix };
}

export function listApiKeysForUser(user: AuthenticatedUser): Array<Omit<ApiKeyRecord, 'key_hash'>> {
  if (user.role === 'viewer') return [];
  const where = user.role === 'admin' ? '' : 'WHERE user_id = ?';
  const params = user.role === 'admin' ? [] : [user.id];
  return getDb().prepare(`
    SELECT id, user_id, name, key_prefix, tier, minute_limit, daily_limit, expires_at, revoked_at, last_used_at, created_at
    FROM api_keys ${where} ORDER BY created_at DESC
  `).all(...params) as Array<Omit<ApiKeyRecord, 'key_hash'>>;
}

export function authenticateApiKey(rawKey: string): { id: number; tier: ApiKeyTier; limits: ApiKeyLimits; user: AuthenticatedUser } | null {
  const row = getDb().prepare(`
    SELECT k.id, k.tier, k.minute_limit, k.daily_limit, u.id AS user_id, u.username, u.role
    FROM api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL AND u.is_active = 1
      AND (k.expires_at IS NULL OR k.expires_at > ?)
  `).get(hashLookupToken(rawKey), nowSqlDateTime()) as {
    id: number;
    tier: ApiKeyTier;
    minute_limit: number;
    daily_limit: number;
    user_id: number;
    username: string;
    role: UserRole;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    tier: row.tier,
    limits: { minute_limit: row.minute_limit, daily_limit: row.daily_limit },
    user: { id: row.user_id, username: row.username, role: row.role },
  };
}

export function touchApiKey(id: number): void {
  getDb().prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

export function revokeApiKey(id: number, actor: AuthenticatedUser): boolean {
  const where = actor.role === 'admin' ? 'id = ?' : 'id = ? AND user_id = ?';
  const params = actor.role === 'admin' ? [id] : [id, actor.id];
  return getDb().prepare(`UPDATE api_keys SET revoked_at = datetime('now') WHERE ${where} AND revoked_at IS NULL`).run(...params).changes > 0;
}

/**
 * Change the tier of an API key. Only admins can call this.
 */
export function updateApiKeyTier(id: number, tier: ApiKeyTier, actor: AuthenticatedUser): boolean {
  if (actor.role !== 'admin') throw new Error('Insufficient permissions');
  if (!['admin', 'operator', 'viewer'].includes(tier)) throw new Error('Invalid API key tier');
  return getDb().prepare("UPDATE api_keys SET tier = ? WHERE id = ? AND revoked_at IS NULL").run(tier, id).changes > 0;
}

export function updateApiKeyLimits(id: number, limits: ApiKeyLimits, actor: AuthenticatedUser): boolean {
  if (actor.role !== 'admin') throw new Error('Insufficient permissions');
  const minuteLimit = normalizeApiKeyLimit(limits.minute_limit, 'minute_limit');
  const dailyLimit = normalizeApiKeyLimit(limits.daily_limit, 'daily_limit');
  return getDb().prepare(`
    UPDATE api_keys SET minute_limit = ?, daily_limit = ? WHERE id = ? AND revoked_at IS NULL
  `).run(minuteLimit, dailyLimit, id).changes > 0;
}

export function consumeApiKeyQuota(id: number, windowSeconds: number, limit: number): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const periodStart = Math.floor(now / windowSeconds) * windowSeconds;
  const transaction = getDb().transaction(() => {
    const row = getDb().prepare(`
      SELECT request_count FROM api_key_usage
      WHERE api_key_id = ? AND period_start = ? AND period_seconds = ?
    `).get(id, periodStart, windowSeconds) as { request_count: number } | undefined;
    const count = (row?.request_count ?? 0) + 1;
    if (row) {
      getDb().prepare(`
        UPDATE api_key_usage SET request_count = ?
        WHERE api_key_id = ? AND period_start = ? AND period_seconds = ?
      `).run(count, id, periodStart, windowSeconds);
    } else {
      getDb().prepare(`
        INSERT INTO api_key_usage (api_key_id, period_start, period_seconds, request_count)
        VALUES (?, ?, ?, ?)
      `).run(id, periodStart, windowSeconds, count);
    }
    return count;
  });
  const count = transaction();
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: periodStart + windowSeconds };
}

export function writeAuditLog(actorUserId: number | null, action: string, targetType: string, targetId: string, ipAddress: string, details: Record<string, unknown> = {}): void {
  getDb().prepare(`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, ip_address, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorUserId, action, targetType, targetId, ipAddress, JSON.stringify(details));
}

// ── Password Reset Requests (admin-approval flow) ──

const RESET_REQUEST_EXPIRY_HOURS = 24;

function nowSqlDateTimePlusHours(hours: number): string {
  const d = new Date(Date.now() + hours * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${padNum(d.getUTCMonth() + 1)}-${padNum(d.getUTCDate())} ${padNum(d.getUTCHours())}:${padNum(d.getUTCMinutes())}:${padNum(d.getUTCSeconds())}`;
}

function nowSqlDateTimePlus(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60 * 1000);
  return `${d.getUTCFullYear()}-${padNum(d.getUTCMonth() + 1)}-${padNum(d.getUTCDate())} ${padNum(d.getUTCHours())}:${padNum(d.getUTCMinutes())}:${padNum(d.getUTCSeconds())}`;
}

/**
 * Create a password reset request for a user (operator/viewer).
 * Admins must approve before the password is actually reset.
 * Returns the approval token and list of admin emails to notify.
 */
export function createResetRequest(username: string): { token: string; username: string; adminEmails: string[] } | null {
  const user = getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND role != \'admin\'').get(username.trim()) as User | undefined;
  if (!user || user.is_active !== 1) return null;
  const token = randomBytes(RESET_TOKEN_LENGTH).toString('base64url');
  const expiresSql = nowSqlDateTimePlusHours(RESET_REQUEST_EXPIRY_HOURS);
  getDb().prepare(`
    INSERT INTO password_reset_requests (id, user_id, status, expires_at) VALUES (?, ?, 'pending', ?)
  `).run(token, user.id, expiresSql);
  // Get all admin emails for notification
  const adminEmails = (getDb().prepare(`
    SELECT ue.email FROM user_emails ue
    JOIN users u ON u.id = ue.user_id AND u.role = 'admin' AND u.is_active = 1
    WHERE ue.email_verified = 1
  `).all() as { email: string }[]).map(r => r.email);
  return { token, username: user.username, adminEmails };
}

export interface ResetRequest {
  id: string;
  user_id: number;
  requester_username: string;
  status: string;
  expires_at: string;
  created_at: string;
}

/**
 * Get reset request info (for admin to review before approving).
 */
export function getResetRequest(token: string): ResetRequest | null {
  return getDb().prepare(`
    SELECT r.id, r.user_id, u.username AS requester_username, r.status, r.expires_at, r.created_at
    FROM password_reset_requests r
    JOIN users u ON u.id = r.user_id
    WHERE r.id = ? AND r.status = 'pending' AND r.expires_at > datetime('now')
  `).get(token) as ResetRequest | undefined || null;
}

/**
 * Admin approves a reset request. Auto-generates a strong password and returns it.
 */
export function approveResetRequest(token: string, adminUserId: number): { username: string; newPassword: string } | null {
  const req = getResetRequest(token);
  if (!req) return null;
  const admin = getUserById(adminUserId);
  if (!admin || admin.role !== 'admin') throw new Error('Insufficient permissions');
  const user = getUserById(req.user_id);
  if (!user || user.is_active !== 1) return null;
  if (user.role === 'admin') throw new Error('Cannot reset another admin account');

  const newPassword = generateInitialPassword();
  getDb().prepare(`
    UPDATE password_reset_requests SET status = 'approved', approved_by = ?, new_password_hash = ? WHERE id = ?
  `).run(adminUserId, hashPassword(newPassword), token);
  getDb().prepare(`
    UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?
  `).run(hashPassword(newPassword), user.id);
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return { username: user.username, newPassword };
}

export function purgeExpiredResetTokens(): void {
  getDb().prepare("DELETE FROM password_reset_requests WHERE expires_at <= datetime('now') AND status = 'pending'").run();
}

// ── Admin Self-Reset Session (TOTP + email verification) ──

interface AdminResetSession {
  userId: number;
  emailCodeHash: string;
  expires: number;
}

const adminResetSessions = new Map<string, AdminResetSession>();

export function createAdminResetSession(userId: number): { tempToken: string; emailCode: string; email: string } | null {
  const email = getPrimaryEmail(userId);
  if (!email) return null;
  const emailCode = String(Math.floor(100000 + Math.random() * 900000));
  const tempToken = randomBytes(32).toString('base64url');
  adminResetSessions.set(tempToken, {
    userId,
    emailCodeHash: createHash('sha256').update(emailCode).digest('hex'),
    expires: Date.now() + 15 * 60 * 1000,
  });
  return { tempToken, emailCode, email };
}

export function consumeAdminResetSession(tempToken: string, emailCode: string, newPassword: string): AuthenticatedUser | null {
  const session = adminResetSessions.get(tempToken);
  if (!session || session.expires < Date.now()) {
    adminResetSessions.delete(tempToken);
    return null;
  }
  const codeHash = createHash('sha256').update(emailCode.trim()).digest('hex');
  if (codeHash !== session.emailCodeHash) return null;
  adminResetSessions.delete(tempToken);

  const user = getUserById(session.userId);
  if (!user || user.is_active !== 1) return null;
  const passwordError = validatePassword(newPassword, user.username);
  if (passwordError) throw new Error(passwordError);
  if (verifyPassword(newPassword, user.password_hash)) throw new Error('New password must be different from the current password');

  getDb().prepare(`
    UPDATE users SET password_hash = ?, session_version = session_version + 1,
      updated_at = datetime('now') WHERE id = ?
  `).run(hashPassword(newPassword), user.id);
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return publicUser(user);
}

/**
 * Verify the email code for an admin reset session WITHOUT consuming it.
 * Returns true if the code is correct and the session is still valid.
 */
export function verifyAdminResetEmailCode(tempToken: string, emailCode: string): boolean {
  const session = adminResetSessions.get(tempToken);
  if (!session || session.expires < Date.now()) return false;
  const codeHash = createHash('sha256').update(emailCode.trim()).digest('hex');
  return codeHash === session.emailCodeHash;
}

// ── Email Management ──

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmailFormat(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 254) return 'Email is required and must be at most 254 characters';
  if (!EMAIL_PATTERN.test(normalized)) return 'Invalid email address';
  return null;
}

export function listEmails(userId: number): UserEmail[] {
  return getDb().prepare('SELECT * FROM user_emails WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC').all(userId) as UserEmail[];
}

export function addEmail(userId: number, email: string): { code: string; email: string } {
  const normalized = email.trim().toLowerCase();
  const formatError = validateEmailFormat(normalized);
  if (formatError) throw new Error(formatError);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const tokenHash = createHash('sha256').update(code).digest('hex');
  const expiresSql = nowSqlDateTimePlus(15);
  const isPrimary = listEmails(userId).length === 0 ? 1 : 0;

  getDb().prepare(`
    INSERT INTO user_emails (user_id, email, email_verify_token_hash, email_verify_expires_at, is_primary)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, normalized, tokenHash, expiresSql, isPrimary);

  return { code, email: normalized };
}

export function resendVerificationCode(userId: number, emailId: number): { code: string; email: string } | null {
  const email = getDb().prepare('SELECT * FROM user_emails WHERE id = ? AND user_id = ? AND email_verified = 0')
    .get(emailId, userId) as UserEmail | undefined;
  if (!email) return null;

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const tokenHash = createHash('sha256').update(code).digest('hex');
  const expiresSql = nowSqlDateTimePlus(15);
  getDb().prepare('UPDATE user_emails SET email_verify_token_hash = ?, email_verify_expires_at = ? WHERE id = ?')
    .run(tokenHash, expiresSql, emailId);
  return { code, email: email.email };
}

export function verifyEmailCode(userId: number, emailId: number, code: string): UserEmail | null {
  const tokenHash = createHash('sha256').update(code.trim()).digest('hex');
  const row = getDb().prepare(`
    SELECT * FROM user_emails WHERE id = ? AND user_id = ? AND email_verify_token_hash = ? AND email_verify_expires_at > datetime('now')
  `).get(emailId, userId, tokenHash) as UserEmail | undefined;
  if (!row) return null;

  getDb().prepare('UPDATE user_emails SET email_verified = 1, email_verify_token_hash = NULL, email_verify_expires_at = NULL WHERE id = ?').run(emailId);
  row.email_verified = 1;
  return row;
}

export function setPrimaryEmail(userId: number, emailId: number): boolean {
  const row = getDb().prepare('SELECT * FROM user_emails WHERE id = ? AND user_id = ? AND email_verified = 1').get(emailId, userId);
  if (!row) return false;
  getDb().prepare('UPDATE user_emails SET is_primary = 0 WHERE user_id = ?').run(userId);
  getDb().prepare('UPDATE user_emails SET is_primary = 1 WHERE id = ?').run(emailId);
  return true;
}

export function deleteEmail(userId: number, emailId: number): boolean {
  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM user_emails WHERE user_id = ?').get(userId) as { c: number }).c;
  if (count <= 1) throw new Error('Cannot remove your only email address');
  const email = getDb().prepare('SELECT * FROM user_emails WHERE id = ? AND user_id = ?').get(emailId, userId) as UserEmail | undefined;
  if (!email) return false;
  const wasPrimary = !!email.is_primary;
  getDb().prepare('DELETE FROM user_emails WHERE id = ? AND user_id = ?').run(emailId, userId);
  // If we deleted the primary, make another one primary
  if (wasPrimary) {
    const next = getDb().prepare('SELECT id FROM user_emails WHERE user_id = ? LIMIT 1').get(userId) as { id: number } | undefined;
    if (next) getDb().prepare('UPDATE user_emails SET is_primary = 1 WHERE id = ?').run(next.id);
  }
  return true;
}

export function getPrimaryEmail(userId: number): string | null {
  const row = getDb().prepare('SELECT email FROM user_emails WHERE user_id = ? AND is_primary = 1 AND email_verified = 1').get(userId) as { email: string } | undefined;
  return row ? row.email : null;
}

// ── TOTP (RFC 6238) ──

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i].toUpperCase();
    if (c === '=') break;
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(output);
}

function generateTotp(secret: string, time = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(time / TOTP_PERIOD);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter), 0);
  const hmacSig = createHmac('sha1', base32Decode(secret)).update(counterBuf).digest();
  const offset = hmacSig[hmacSig.length - 1] & 0x0f;
  const code = ((hmacSig[offset] & 0x7f) << 24) | ((hmacSig[offset + 1] & 0xff) << 16) | ((hmacSig[offset + 2] & 0xff) << 8) | (hmacSig[offset + 3] & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function generateTotpSecret(username: string): string {
  const buf = randomBytes(20);
  const base32 = (buf: Buffer): string => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let result = '', bits = 0, value = 0;
    for (let i = 0; i < buf.length; i++) { value = (value << 8) | buf[i]; bits += 8; while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 0x1f]; bits -= 5; } }
    if (bits > 0) result += alphabet[(value << (5 - bits)) & 0x1f];
    return result + '====';
  };
  const secret = base32(buf).replace(/=+$/, '');
  const qrUri = `otpauth://totp/CrashReporter:${encodeURIComponent(username)}?secret=${secret}&issuer=CrashReporter&algorithm=SHA1&digits=6&period=30`;
  return `${secret}\n${qrUri}`;
}

export function enableTotp(userId: number, code: string, secret: string): boolean {
  if (!verifyTotpCode(secret, code)) return false;
  getDb().prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, userId);
  return true;
}

export function disableTotp(userId: number, code: string): boolean {
  const row = getDb().prepare('SELECT totp_secret FROM users WHERE id = ? AND totp_enabled = 1').get(userId) as { totp_secret: string } | undefined;
  if (!row) return false;
  if (!verifyTotpCode(row.totp_secret, code)) return false;
  getDb().prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(userId);
  return true;
}

function verifyTotpCode(secret: string, code: string): boolean {
  if (code.length !== TOTP_DIGITS || !/^\d+$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000);
  return generateTotp(secret, now) === code || generateTotp(secret, now - TOTP_PERIOD) === code;
}

export function verifyTotp(userId: number, code: string): boolean {
  const row = getDb().prepare('SELECT totp_secret FROM users WHERE id = ? AND totp_enabled = 1').get(userId) as { totp_secret: string } | undefined;
  if (!row) return false;
  return verifyTotpCode(row.totp_secret, code);
}

// ── TOTP temporary token (for login 2FA step) ──

const totpTempTokens = new Map<string, { userId: number; expires: number }>();

export function createTotpTempToken(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  totpTempTokens.set(token, { userId, expires: Date.now() + 60_000 });
  return token;
}

export function consumeTotpTempToken(token: string): number | null {
  const entry = totpTempTokens.get(token);
  if (!entry || entry.expires < Date.now()) { totpTempTokens.delete(token); return null; }
  totpTempTokens.delete(token);
  return entry.userId;
}

// ── Admin email verification during login ──

const FIRST_LOGIN_SESSION_TTL = 10 * 60 * 1000; // 10 minutes
const FIRST_LOGIN_RESEND_COOLDOWN = 60_000;       // 60 seconds

interface FirstLoginVerSession {
  userId: number;
  codeHash: string;
  email: string;
  expires: number;
  lastResentAt: number;
}

const firstLoginSessions = new Map<string, FirstLoginVerSession>();

/**
 * Get any email address for a user (prefer primary verified, fall back to any email).
 * Accepts unverified emails so they can be verified during login.
 */
function getAnyEmail(userId: number): string | null {
  // Prefer primary verified
  const primary = getPrimaryEmail(userId);
  if (primary) return primary;
  // Any verified email
  const verified = getDb().prepare('SELECT email FROM user_emails WHERE user_id = ? AND email_verified = 1 LIMIT 1').get(userId) as { email: string } | undefined;
  if (verified) return verified.email;
  // Any email at all (unverified is ok — this login step verifies it)
  const any = getDb().prepare('SELECT email FROM user_emails WHERE user_id = ? LIMIT 1').get(userId) as { email: string } | undefined;
  return any ? any.email : null;
}

/**
 * Create an admin login email verification session.
 * Generates a 6-digit code, stores in memory, and returns the code + token.
 * Returns null if the user has no email address.
 */
export function createFirstLoginVerSession(userId: number): { tempToken: string; emailCode: string; email: string } | null {
  const email = getAnyEmail(userId);
  if (!email) return null;
  const emailCode = String(Math.floor(100000 + Math.random() * 900000));
  const tempToken = randomBytes(32).toString('base64url');
  firstLoginSessions.set(tempToken, {
    userId,
    codeHash: createHash('sha256').update(emailCode).digest('hex'),
    email,
    expires: Date.now() + FIRST_LOGIN_SESSION_TTL,
    lastResentAt: Date.now(),
  });
  return { tempToken, emailCode, email };
}

/**
 * Verify the admin login email code.
 * If valid, marks the email as verified, creates a real session, and removes the verification session.
 * Returns the session token (cookie value) on success, null on failure.
 */
export function consumeFirstLoginVerSession(tempToken: string, code: string): string | null {
  const session = firstLoginSessions.get(tempToken);
  if (!session || session.expires < Date.now()) {
    firstLoginSessions.delete(tempToken);
    return null;
  }
  const codeHash = createHash('sha256').update(code.trim()).digest('hex');
  if (codeHash !== session.codeHash) return null;
  firstLoginSessions.delete(tempToken);
  // Mark the email as verified
  const emailRow = getDb().prepare('SELECT id FROM user_emails WHERE user_id = ? AND email = ?').get(session.userId, session.email) as { id: number } | undefined;
  if (emailRow) {
    getDb().prepare('UPDATE user_emails SET email_verified = 1, email_verify_token_hash = NULL, email_verify_expires_at = NULL WHERE id = ?').run(emailRow.id);
  }
  return createSession(session.userId);
}

/**
 * Resend the admin login verification code.
 * Returns null if the session is invalid/expired or within the 60s cooldown.
 */
export function resendFirstLoginCode(tempToken: string): { emailCode: string; email: string } | null {
  const session = firstLoginSessions.get(tempToken);
  if (!session || session.expires < Date.now()) {
    firstLoginSessions.delete(tempToken);
    return null;
  }
  if (Date.now() - session.lastResentAt < FIRST_LOGIN_RESEND_COOLDOWN) {
    return null;
  }
  const emailCode = String(Math.floor(100000 + Math.random() * 900000));
  session.codeHash = createHash('sha256').update(emailCode).digest('hex');
  session.lastResentAt = Date.now();
  return { emailCode, email: session.email };
}
