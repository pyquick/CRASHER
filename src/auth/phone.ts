import { createHash } from 'crypto';
import type { UserPhone } from '../model.js';
import * as store from '../database/auth-contact-store.js';
import { nowSqlDateTimePlusMinutes } from '../shared/date.js';

const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

function validatePhoneFormat(phone: string): string | null {
  const normalized = phone.trim();
  if (!normalized || normalized.length > 20) return 'Phone number is required and must be at most 20 characters';
  if (!PHONE_PATTERN.test(normalized)) return 'Phone number must be in E.164 format (e.g., +1234567890)';
  return null;
}

function generateAndHashCode(): { code: string; hash: string } {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  return { code, hash: createHash('sha256').update(code).digest('hex') };
}

export function listPhones(userId: number): UserPhone[] {
  return store.listUserPhones(userId);
}

export function addPhone(userId: number, phone: string): { code: string; phone: string } {
  const normalized = phone.trim();
  const formatError = validatePhoneFormat(normalized);
  if (formatError) throw new Error(formatError);

  const { code, hash } = generateAndHashCode();
  const expiresSql = nowSqlDateTimePlusMinutes(15);
  const isPrimary = listPhones(userId).length === 0 ? 1 : 0;

  store.insertUserPhone(userId, normalized, hash, expiresSql, isPrimary);
  return { code, phone: normalized };
}

export function resendPhoneVerificationCode(userId: number, phoneId: number): { code: string; phone: string } | null {
  const phone = store.findPendingPhoneVerification(userId, phoneId);
  if (!phone) return null;

  const { code, hash } = generateAndHashCode();
  const expiresSql = nowSqlDateTimePlusMinutes(15);
  store.updatePhoneVerificationCode(phoneId, hash, expiresSql);
  return { code, phone: phone.phone };
}

export function verifyPhoneCode(userId: number, phoneId: number, code: string): UserPhone | null {
  const hash = createHash('sha256').update(code.trim()).digest('hex');
  const row = store.findPhoneByToken(userId, phoneId, hash);
  if (!row) return null;

  store.markPhoneVerified(phoneId);
  row.phone_verified = 1;
  return row;
}

export function setPrimaryPhone(userId: number, phoneId: number): boolean {
  const row = store.findVerifiedPhone(phoneId, userId);
  if (!row) return false;
  store.clearPrimaryPhones(userId);
  store.setPhonePrimary(phoneId);
  return true;
}

export function deletePhone(userId: number, phoneId: number): boolean {
  const count = store.countUserPhones(userId);
  const emailCount = store.countUserEmails(userId);
  if (count <= 1 && emailCount === 0) throw new Error('Cannot remove your only contact method');
  const phone = store.findVerifiedPhone(phoneId, userId) ?? store.findPendingPhoneVerification(userId, phoneId);
  if (!phone) return false;
  const wasPrimary = !!phone.is_primary;
  store.deleteUserPhone(phoneId, userId);
  if (wasPrimary) {
    const next = store.findFirstUserPhone(userId);
    if (next) store.setPhonePrimary(next.id);
  }
  return true;
}

export function getPrimaryPhone(userId: number): string | null {
  const row = store.findPrimaryVerifiedPhone(userId);
  return row ? row.phone : null;
}

export function hasVerifiedPhone(userId: number): boolean {
  return store.countVerifiedPhones(userId) > 0;
}

export function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  const visible = 3;
  return phone.substring(0, visible + 1) + '****' + phone.substring(phone.length - 2);
}
