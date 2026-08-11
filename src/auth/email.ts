import { createHash } from 'crypto';
import type { UserEmail } from '../model.js';
import * as store from '../database/auth-contact-store.js';
import { nowSqlDateTimePlusMinutes } from '../shared/date.js';

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
  return store.listUserEmails(userId);
}

export function addEmail(userId: number, email: string): { code: string; email: string } {
  const normalized = email.trim().toLowerCase();
  const formatError = validateEmailFormat(normalized);
  if (formatError) throw new Error(formatError);

  const { code, hash } = generateAndHashCode();
  const expiresSql = nowSqlDateTimePlusMinutes(15);
  const isPrimary = listEmails(userId).length === 0 ? 1 : 0;

  store.insertUserEmail(userId, normalized, hash, expiresSql, isPrimary);
  return { code, email: normalized };
}

export function resendVerificationCode(userId: number, emailId: number): { code: string; email: string } | null {
  const email = store.findPendingEmailVerification(userId, emailId);
  if (!email) return null;

  const { code, hash } = generateAndHashCode();
  const expiresSql = nowSqlDateTimePlusMinutes(15);
  store.updateEmailVerificationCode(emailId, hash, expiresSql);
  return { code, email: email.email };
}

export function verifyEmailCode(userId: number, emailId: number, code: string): UserEmail | null {
  const hash = createHash('sha256').update(code.trim()).digest('hex');
  const row = store.findEmailByToken(userId, emailId, hash);
  if (!row) return null;

  store.markEmailVerified(emailId);
  row.email_verified = 1;
  return row;
}

export function setPrimaryEmail(userId: number, emailId: number): boolean {
  const row = store.findVerifiedEmail(emailId, userId);
  if (!row) return false;
  store.clearPrimaryEmails(userId);
  store.setEmailPrimary(emailId);
  return true;
}

export function deleteEmail(userId: number, emailId: number): boolean {
  const count = store.countUserEmails(userId);
  if (count <= 1) throw new Error('Cannot remove your only email address');
  const email = store.findVerifiedEmail(emailId, userId) ?? store.findPendingEmailVerification(userId, emailId);
  if (!email) return false;
  const wasPrimary = !!email.is_primary;
  store.deleteUserEmail(emailId, userId);
  if (wasPrimary) {
    const next = store.findFirstUserEmail(userId);
    if (next) store.setEmailPrimary(next.id);
  }
  return true;
}

export function getPrimaryEmail(userId: number): string | null {
  const row = store.findPrimaryVerifiedEmail(userId);
  return row ? row.email : null;
}

export function getAnyEmail(userId: number): string | null {
  const primary = store.findPrimaryVerifiedEmail(userId);
  if (primary) return primary.email;
  const verified = store.findAnyVerifiedEmail(userId);
  if (verified) return verified.email;
  const any = store.findAnyEmail(userId);
  return any ? any.email : null;
}

export function hasVerifiedEmail(userId: number): boolean {
  return store.countVerifiedEmails(userId) > 0;
}
