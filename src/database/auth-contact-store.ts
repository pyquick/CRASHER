import { getDb } from './connection.js';
import type { UserEmail, UserPhone } from '../model.js';

// ── Emails ──

export function listUserEmails(userId: number): UserEmail[] {
  return getDb().prepare('SELECT * FROM user_emails WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC').all(userId) as UserEmail[];
}

export function insertUserEmail(userId: number, email: string, tokenHash: string, expiresSql: string, isPrimary: number): { lastInsertRowid: number | bigint } {
  return getDb().prepare(
    'INSERT INTO user_emails (user_id, email, email_verify_token_hash, email_verify_expires_at, is_primary) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, email, tokenHash, expiresSql, isPrimary);
}

export function updateEmailVerificationCode(emailId: number, tokenHash: string, expiresSql: string): void {
  getDb().prepare('UPDATE user_emails SET email_verify_token_hash = ?, email_verify_expires_at = ? WHERE id = ?').run(tokenHash, expiresSql, emailId);
}

export function findPendingEmailVerification(userId: number, emailId: number): UserEmail | undefined {
  return getDb().prepare('SELECT * FROM user_emails WHERE id = ? AND user_id = ? AND email_verified = 0').get(emailId, userId) as UserEmail | undefined;
}

export function findEmailByToken(userId: number, emailId: number, tokenHash: string): UserEmail | undefined {
  return getDb().prepare(
    'SELECT * FROM user_emails WHERE id = ? AND user_id = ? AND email_verify_token_hash = ? AND email_verify_expires_at > datetime(\'now\')'
  ).get(emailId, userId, tokenHash) as UserEmail | undefined;
}

export function markEmailVerified(emailId: number): void {
  getDb().prepare('UPDATE user_emails SET email_verified = 1, email_verify_token_hash = NULL, email_verify_expires_at = NULL WHERE id = ?').run(emailId);
}

export function clearPrimaryEmails(userId: number): void {
  getDb().prepare('UPDATE user_emails SET is_primary = 0 WHERE user_id = ?').run(userId);
}

export function setEmailPrimary(emailId: number): void {
  getDb().prepare('UPDATE user_emails SET is_primary = 1 WHERE id = ?').run(emailId);
}

export function findVerifiedEmail(emailId: number, userId: number): UserEmail | undefined {
  return getDb().prepare('SELECT * FROM user_emails WHERE id = ? AND user_id = ? AND email_verified = 1').get(emailId, userId) as UserEmail | undefined;
}

export function countUserEmails(userId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM user_emails WHERE user_id = ?').get(userId) as { c: number }).c;
}

export function deleteUserEmail(emailId: number, userId: number): void {
  getDb().prepare('DELETE FROM user_emails WHERE id = ? AND user_id = ?').run(emailId, userId);
}

export function findFirstUserEmail(userId: number): { id: number } | undefined {
  return getDb().prepare('SELECT id FROM user_emails WHERE user_id = ? LIMIT 1').get(userId) as { id: number } | undefined;
}

export function findPrimaryVerifiedEmail(userId: number): { email: string } | undefined {
  return getDb().prepare('SELECT email FROM user_emails WHERE user_id = ? AND is_primary = 1 AND email_verified = 1').get(userId) as { email: string } | undefined;
}

export function findAnyVerifiedEmail(userId: number): { email: string } | undefined {
  return getDb().prepare('SELECT email FROM user_emails WHERE user_id = ? AND email_verified = 1 LIMIT 1').get(userId) as { email: string } | undefined;
}

export function findAnyEmail(userId: number): { email: string } | undefined {
  return getDb().prepare('SELECT email FROM user_emails WHERE user_id = ? LIMIT 1').get(userId) as { email: string } | undefined;
}

export function findEmailsByUserIdAndEmail(userId: number, email: string): { id: number } | undefined {
  return getDb().prepare('SELECT id FROM user_emails WHERE user_id = ? AND email = ?').get(userId, email) as { id: number } | undefined;
}

export function countVerifiedEmails(userId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM user_emails WHERE user_id = ? AND email_verified = 1').get(userId) as { c: number }).c;
}

export function findAdminEmailsForContainer(containerId: number): { email: string }[] {
  return getDb().prepare(
    `SELECT ue.email FROM user_emails ue
     JOIN users u ON u.id = ue.user_id AND u.role = 'admin' AND u.is_active = 1 AND u.container_id = ?
     WHERE ue.email_verified = 1`
  ).all(containerId) as { email: string }[];
}

// ── Phones ──

export function listUserPhones(userId: number): UserPhone[] {
  return getDb().prepare('SELECT * FROM user_phones WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC').all(userId) as UserPhone[];
}

export function insertUserPhone(userId: number, phone: string, tokenHash: string, expiresSql: string, isPrimary: number): { lastInsertRowid: number | bigint } {
  return getDb().prepare(
    'INSERT INTO user_phones (user_id, phone, phone_verify_token_hash, phone_verify_expires_at, is_primary) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, phone, tokenHash, expiresSql, isPrimary);
}

export function updatePhoneVerificationCode(phoneId: number, tokenHash: string, expiresSql: string): void {
  getDb().prepare('UPDATE user_phones SET phone_verify_token_hash = ?, phone_verify_expires_at = ? WHERE id = ?').run(tokenHash, expiresSql, phoneId);
}

export function findPendingPhoneVerification(userId: number, phoneId: number): UserPhone | undefined {
  return getDb().prepare('SELECT * FROM user_phones WHERE id = ? AND user_id = ? AND phone_verified = 0').get(phoneId, userId) as UserPhone | undefined;
}

export function findPhoneByToken(userId: number, phoneId: number, tokenHash: string): UserPhone | undefined {
  return getDb().prepare(
    'SELECT * FROM user_phones WHERE id = ? AND user_id = ? AND phone_verify_token_hash = ? AND phone_verify_expires_at > datetime(\'now\')'
  ).get(phoneId, userId, tokenHash) as UserPhone | undefined;
}

export function markPhoneVerified(phoneId: number): void {
  getDb().prepare('UPDATE user_phones SET phone_verified = 1, phone_verify_token_hash = NULL, phone_verify_expires_at = NULL WHERE id = ?').run(phoneId);
}

export function clearPrimaryPhones(userId: number): void {
  getDb().prepare('UPDATE user_phones SET is_primary = 0 WHERE user_id = ?').run(userId);
}

export function setPhonePrimary(phoneId: number): void {
  getDb().prepare('UPDATE user_phones SET is_primary = 1 WHERE id = ?').run(phoneId);
}

export function findVerifiedPhone(phoneId: number, userId: number): UserPhone | undefined {
  return getDb().prepare('SELECT * FROM user_phones WHERE id = ? AND user_id = ? AND phone_verified = 1').get(phoneId, userId) as UserPhone | undefined;
}

export function countUserPhones(userId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM user_phones WHERE user_id = ?').get(userId) as { c: number }).c;
}

export function deleteUserPhone(phoneId: number, userId: number): void {
  getDb().prepare('DELETE FROM user_phones WHERE id = ? AND user_id = ?').run(phoneId, userId);
}

export function findFirstUserPhone(userId: number): { id: number } | undefined {
  return getDb().prepare('SELECT id FROM user_phones WHERE user_id = ? LIMIT 1').get(userId) as { id: number } | undefined;
}

export function findPrimaryVerifiedPhone(userId: number): { phone: string } | undefined {
  return getDb().prepare('SELECT phone FROM user_phones WHERE user_id = ? AND is_primary = 1 AND phone_verified = 1').get(userId) as { phone: string } | undefined;
}

export function countVerifiedPhones(userId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM user_phones WHERE user_id = ? AND phone_verified = 1').get(userId) as { c: number }).c;
}

// ── Audit ──

export function insertAuditLog(actorUserId: number | null, action: string, targetType: string, targetId: string, ipAddress: string, details: string): void {
  getDb().prepare(
    'INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, ip_address, details) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(actorUserId, action, targetType, targetId, ipAddress, details);
}

// ── Password Reset ──

export function insertPasswordResetRequest(token: string, userId: number, expiresSql: string): void {
  getDb().prepare(
    "INSERT INTO password_reset_requests (id, user_id, status, expires_at) VALUES (?, ?, 'pending', ?)"
  ).run(token, userId, expiresSql);
}

export function findPendingResetRequest(token: string) {
  return getDb().prepare(
    `SELECT r.id, r.user_id, u.username AS requester_username, r.status, r.expires_at, r.created_at
     FROM password_reset_requests r JOIN users u ON u.id = r.user_id
     WHERE r.id = ? AND r.status = 'pending' AND r.expires_at > datetime('now')`
  ).get(token) as any | undefined;
}

export function approveResetRequest(token: string, adminId: number, newPasswordHash: string): void {
  getDb().prepare(
    "UPDATE password_reset_requests SET status = 'approved', approved_by = ?, new_password_hash = ? WHERE id = ?"
  ).run(adminId, newPasswordHash, token);
}

export function deleteExpiredResetRequests(): void {
  getDb().prepare("DELETE FROM password_reset_requests WHERE expires_at <= datetime('now') AND status = 'pending'").run();
}

