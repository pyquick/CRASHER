import { createHash } from 'crypto';
import type { UserEmail } from '../../model.js';
import * as store from '../../database/auth-store.js';
import * as contactStore from '../../database/auth-contact-store.js';
import { nowSqlDateTimePlusMinutes } from '../../shared/date.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmailFormat(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 254) return 'Email is required and must be at most 254 characters';
  if (!EMAIL_PATTERN.test(normalized)) return 'Invalid email address';
  return null;
}

function generateAndHashCode(): { code: string; hash: string } {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  return { code, hash: createHash('sha256').update(code).digest('hex') };
}

export function listEmails(userId: number): UserEmail[] {
  return contactStore.listUserEmails(userId);
}

export function addEmail(userId: number, email: string): { code: string; email: string; id: number } {
  const normalized = email.trim().toLowerCase();
  const formatError = validateEmailFormat(normalized);
  if (formatError) throw new Error(formatError);

  const { code, hash } = generateAndHashCode();
  const expiresSql = nowSqlDateTimePlusMinutes(15);
  const isPrimary = listEmails(userId).length === 0 ? 1 : 0;

  const result = contactStore.insertUserEmail(userId, normalized, hash, expiresSql, isPrimary);
  return { code, email: normalized, id: Number(result.lastInsertRowid) };
}

export function resendVerificationCode(userId: number, emailId: number): { code: string; email: string } | null {
  const email = contactStore.findPendingEmailVerification(userId, emailId);
  if (!email) return null;

  const { code, hash } = generateAndHashCode();
  const expiresSql = nowSqlDateTimePlusMinutes(15);
  contactStore.updateEmailVerificationCode(emailId, hash, expiresSql);
  return { code, email: email.email };
}

export function verifyEmailCode(userId: number, emailId: number, code: string): UserEmail | null {
  const hash = createHash('sha256').update(code.trim()).digest('hex');
  const row = contactStore.findEmailByToken(userId, emailId, hash);
  if (!row) return null;

  contactStore.markEmailVerified(emailId);
  row.email_verified = 1;
  return row;
}

export function setPrimaryEmail(userId: number, emailId: number): boolean {
  const row = contactStore.findVerifiedEmail(emailId, userId);
  if (!row) return false;
  contactStore.clearPrimaryEmails(userId);
  contactStore.setEmailPrimary(emailId);
  return true;
}

export function deleteEmail(userId: number, emailId: number): boolean {
  const count = contactStore.countUserEmails(userId);
  if (count <= 1) throw new Error('Cannot remove your only email address');
  const email = contactStore.findVerifiedEmail(emailId, userId) ?? contactStore.findPendingEmailVerification(userId, emailId);
  if (!email) return false;
  const wasPrimary = !!email.is_primary;
  contactStore.deleteUserEmail(emailId, userId);
  if (wasPrimary) {
    const next = contactStore.findFirstUserEmail(userId);
    if (next) contactStore.setEmailPrimary(next.id);
  }
  return true;
}

export function getPrimaryEmail(userId: number): string | null {
  const row = contactStore.findPrimaryVerifiedEmail(userId);
  return row ? row.email : null;
}

export function getAnyEmail(userId: number): string | null {
  const primary = contactStore.findPrimaryVerifiedEmail(userId);
  if (primary) return primary.email;
  const verified = contactStore.findAnyVerifiedEmail(userId);
  if (verified) return verified.email;
  const any = contactStore.findAnyEmail(userId);
  return any ? any.email : null;
}

export function hasVerifiedEmail(userId: number): boolean {
  return contactStore.countVerifiedEmails(userId) > 0;
}

// ── Verify-email-on-login preference (admin only) ──

export function isVerifyEmailOnLogin(userId: number): boolean {
  const user = store.findUserById(userId);
  return user?.verify_email_on_login === 1;
}

export function setVerifyEmailOnLogin(userId: number, enabled: boolean): void {
  const user = store.findUserById(userId);
  if (!user) throw new Error('User not found');
  if (user.role !== 'admin') throw new Error('Only administrators can enable login email verification');
  if (enabled && !hasVerifiedEmail(userId)) {
    throw new Error('A verified email address is required to enable login email verification');
  }
  store.setUserVerifyEmailOnLogin(userId, enabled ? 1 : 0);
}
