import { createHash, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { config } from './config.js';
import { getDb } from './database.js';
import type { ApiKeyRecord, ApiKeyTier, AuthenticatedUser, User, UserRole } from './model.js';

const SCRYPT_KEY_LENGTH = 64;
// SHA-256 via PBKDF2: 128-bit salt, 310,000 iterations, 32-byte output (256-bit)
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 310_000;
// PBKDF2 minimum iterations (OWASP 2023 recommendation for SHA-256: 600,000)
// We use 310k for server performance; adjust higher if needed
const RESET_TOKEN_LENGTH = 32;
const RESET_TOKEN_EXPIRY_MINUTES = 15;
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

function publicUser(user: Pick<User, 'id' | 'username' | 'role'>): AuthenticatedUser {
  return { id: user.id, username: user.username, role: user.role };
}

export function bootstrapAdmin(): void {
  const count = (getDb().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  if (count > 0) return;
  createUser(config.bootstrapAdminUsername, config.bootstrapAdminPassword, 'admin');
  console.warn(`[security] Initial admin account created: ${config.bootstrapAdminUsername}`);
  if (config.generatedBootstrapPassword) {
    console.warn(`[security] One-time generated admin password: ${config.bootstrapAdminPassword}`);
    console.warn('[security] Change this password immediately after the first login.');
  }
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
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
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

export function updateUser(id: number, changes: { role?: UserRole; is_active?: boolean }): boolean {
  const user = getUserById(id);
  if (!user) return false;
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
  return rawToken;
}

export function getValidSession(rawToken: string, now: string): { user: AuthenticatedUser } | null {
  const row = getDb().prepare(`
    SELECT u.id, u.username, u.role, u.is_active, u.session_version, s.session_version AS stored_version
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

export function createApiKey(userId: number, name: string, tier: ApiKeyTier = 'operator', expiresAt?: string): { id: number; name: string; key: string; key_prefix: string } {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) throw new Error('User is not active');
  if (!['admin', 'operator', 'viewer'].includes(tier)) throw new Error('Invalid API key tier');
  // Non-admin users can only create operator or viewer keys
  if (user.role !== 'admin' && tier === 'admin') throw new Error('Only admins can create admin-tier API keys');
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 100) throw new Error('API key name must be 1-100 characters');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error('Invalid expiration date');
  const expiresAtSql = expiresAt ? new Date(expiresAt).toISOString().replace('T', ' ').replace('Z', '') : null;

  const key = `crs_${randomBytes(32).toString('base64url')}`;
  const prefix = key.substring(0, 12);
  const result = getDb().prepare(`
    INSERT INTO api_keys (user_id, name, key_prefix, key_hash, tier, expires_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, normalizedName, prefix, hashLookupToken(key), tier, expiresAtSql);
  return { id: Number(result.lastInsertRowid), name: normalizedName, key, key_prefix: prefix };
}

export function listApiKeysForUser(user: AuthenticatedUser): Array<Omit<ApiKeyRecord, 'key_hash'>> {
  if (user.role === 'viewer') return [];
  const where = user.role === 'admin' ? '' : 'WHERE user_id = ?';
  const params = user.role === 'admin' ? [] : [user.id];
  return getDb().prepare(`
    SELECT id, user_id, name, key_prefix, tier, expires_at, revoked_at, last_used_at, created_at
    FROM api_keys ${where} ORDER BY created_at DESC
  `).all(...params) as Array<Omit<ApiKeyRecord, 'key_hash'>>;
}

export function authenticateApiKey(rawKey: string): { id: number; tier: ApiKeyTier; user: AuthenticatedUser } | null {
  const row = getDb().prepare(`
    SELECT k.id, k.tier, u.id AS user_id, u.username, u.role
    FROM api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL AND u.is_active = 1
      AND (k.expires_at IS NULL OR k.expires_at > ?)
  `).get(hashLookupToken(rawKey), nowSqlDateTime()) as { id: number; tier: ApiKeyTier; user_id: number; username: string; role: UserRole } | undefined;
  if (!row) return null;
  return { id: row.id, tier: row.tier, user: { id: row.user_id, username: row.username, role: row.role } };
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

export function writeAuditLog(actorUserId: number | null, action: string, targetType: string, targetId: string, ipAddress: string, details: Record<string, unknown> = {}): void {
  getDb().prepare(`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, ip_address, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorUserId, action, targetType, targetId, ipAddress, JSON.stringify(details));
}

// ── Password Reset (forgot-password flow) ──

/**
 * Generate a password reset token for a user, stored as SHA-256 hash.
 * Returns the raw token to be sent to the user (e.g., via admin / email).
 */
export function createPasswordResetToken(username: string): { token: string; username: string } | null {
  const user = getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username.trim()) as User | undefined;
  if (!user || user.is_active !== 1) return null;
  // Expire any existing unused tokens for this user
  getDb().prepare("UPDATE password_reset_tokens SET expires_at = datetime('now') WHERE user_id = ? AND expires_at > datetime('now') AND used_at IS NULL")
    .run(user.id);
  const rawToken = randomBytes(RESET_TOKEN_LENGTH).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAtSql = nowSqlDateTimePlus(RESET_TOKEN_EXPIRY_MINUTES);
  getDb().prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)
  `).run(user.id, tokenHash, expiresAtSql);
  return { token: rawToken, username: user.username };
}

/**
 * Verify a reset token and return the user if valid.
 */
export function consumeResetToken(rawToken: string): AuthenticatedUser | null {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const row = getDb().prepare(`
    SELECT u.id, u.username, u.role
    FROM password_reset_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.expires_at > datetime('now') AND t.used_at IS NULL AND u.is_active = 1
  `).get(tokenHash) as AuthenticatedUser | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE token_hash = ?").run(tokenHash);
  return row;
}

/**
 * Reset a user's password using a valid reset token.
 * Increments session_version to invalidate all existing sessions (including this reset).
 */
export function resetPasswordWithToken(rawToken: string, newPassword: string): AuthenticatedUser | null {
  const user = consumeResetToken(rawToken);
  if (!user) return null;
  const fullUser = getUserById(user.id);
  if (!fullUser) return null;
  const passwordError = validatePassword(newPassword, fullUser.username);
  if (passwordError) throw new Error(passwordError);
  if (verifyPassword(newPassword, fullUser.password_hash)) throw new Error('New password must be different from the current password');
  getDb().prepare(`
    UPDATE users SET password_hash = ?, session_version = session_version + 1,
      updated_at = datetime('now') WHERE id = ?
  `).run(hashPassword(newPassword), user.id);
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return user;
}

/**
 * Admin-initiated password reset: generates a reset token for any user.
 * Only admins can call this.
 */
export function adminResetPassword(actor: AuthenticatedUser, userId: number): { token: string; username: string } | null {
  if (actor.role !== 'admin') throw new Error('Insufficient permissions');
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return null;
  // Expire any existing unused tokens for this user
  getDb().prepare("UPDATE password_reset_tokens SET expires_at = datetime('now') WHERE user_id = ? AND expires_at > datetime('now') AND used_at IS NULL")
    .run(user.id);
  const rawToken = randomBytes(RESET_TOKEN_LENGTH).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAtSql = nowSqlDateTimePlus(RESET_TOKEN_EXPIRY_MINUTES);
  getDb().prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)
  `).run(user.id, tokenHash, expiresAtSql);
  return { token: rawToken, username: user.username };
}

function nowSqlDateTimePlus(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60 * 1000);
  return `${d.getUTCFullYear()}-${padNum(d.getUTCMonth() + 1)}-${padNum(d.getUTCDate())} ${padNum(d.getUTCHours())}:${padNum(d.getUTCMinutes())}:${padNum(d.getUTCSeconds())}`;
}

export function purgeExpiredResetTokens(): void {
  getDb().prepare("DELETE FROM password_reset_tokens WHERE expires_at <= datetime('now')").run();
}
