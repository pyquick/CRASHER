import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import type { AuthenticatedUser } from '../model.js';
import * as store from '../database/auth-store.js';
import * as contactStore from '../database/auth-contact-store.js';
import { getUserById } from './user.js';
import { hashPassword, verifyPassword, validatePassword, generateInitialPassword } from './password.js';
import { nowSqlDateTimePlusHours } from '../shared/date.js';
import { writeAuditLog } from './audit.js';
import { getPrimaryEmail } from './email.js';

const RESET_REQUEST_EXPIRY_HOURS = 24;
const RESET_TOKEN_LENGTH = 32;

export function createResetRequest(username: string): { token: string; username: string; adminEmails: string[] } | null {
  const user = store.findUserByUsername(username.trim());
  if (!user || user.is_active !== 1) return null;
  if (user.role === 'admin' || user.role === 'ultraadmin') return null;

  const token = randomBytes(RESET_TOKEN_LENGTH).toString('base64url');
  const expiresSql = nowSqlDateTimePlusHours(RESET_REQUEST_EXPIRY_HOURS);
  contactStore.insertPasswordResetRequest(token, user.id, expiresSql);

  let adminEmails: string[] = [];
  if (user.container_id) {
    adminEmails = contactStore.findAdminEmailsForContainer(user.container_id).map(r => r.email);
  }
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

export function getResetRequest(token: string): ResetRequest | null {
  return contactStore.findPendingResetRequest(token) as ResetRequest | undefined || null;
}

export function approveResetRequest(token: string, adminUserId: number): { username: string; newPassword: string } | null {
  const req = getResetRequest(token);
  if (!req) return null;
  const admin = getUserById(adminUserId);
  if (!admin || (admin.role !== 'admin' && admin.role !== 'ultraadmin')) throw new Error('Insufficient permissions');
  const user = getUserById(req.user_id);
  if (!user || user.is_active !== 1) return null;
  if (user.role === 'admin' || user.role === 'ultraadmin') throw new Error('Cannot reset another admin account');
  if (admin.role === 'admin' && admin.container_id !== user.container_id) {
    throw new Error('Cannot reset users from other containers');
  }

  const newPassword = generateInitialPassword();
  contactStore.approveResetRequest(token, adminUserId, hashPassword(newPassword));
  store.updateUserPassword(user.id, hashPassword(newPassword));
  store.deleteSessionsForUser(user.id);
  return { username: user.username, newPassword };
}

export function purgeExpiredResetTokens(): void {
  contactStore.deleteExpiredResetRequests();
}

// ── Admin Self-Reset (TOTP + email verification) ──

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

  store.updateUserPassword(user.id, hashPassword(newPassword));
  store.deleteSessionsForUser(user.id);
  return { id: user.id, username: user.username, role: user.role, container_id: user.container_id ?? null };
}

export function verifyAdminResetEmailCode(tempToken: string, emailCode: string): boolean {
  const session = adminResetSessions.get(tempToken);
  if (!session || session.expires < Date.now()) return false;
  const codeHash = createHash('sha256').update(emailCode.trim()).digest('hex');
  return codeHash === session.emailCodeHash;
}
