import type { TwoFactorMethod } from '../../model.js';
import * as contactStore from '../../database/auth-contact-store.js';
import { createTokenStore } from '../../shared/verification.js';
import { config } from '../../config.js';
import { getUserById } from '../user.js';

// ── MFA session (short-lived, set as a cookie after a successful 2FA verify) ──

const MFA_SESSION_TTL = 5 * 60 * 1000;

const mfaSessions = createTokenStore(MFA_SESSION_TTL);

export function createMfaSession(userId: number): string {
  return mfaSessions.create({ userId });
}

export function validateMfaSession(token: string, userId: number): boolean {
  const data = mfaSessions.get<{ userId: number }>(token);
  return data?.userId === userId;
}

// ── Available 2FA methods ──

export function getAvailable2FAMethods(userId: number): TwoFactorMethod[] {
  const methods: TwoFactorMethod[] = [];
  const user = getUserById(userId);
  if (user?.role === 'admin' && user.totp_enabled) methods.push('totp');
  if (config.emailEnabled && contactStore.countVerifiedEmails(userId) > 0) methods.push('email');
  if (contactStore.countVerifiedPhones(userId) > 0) methods.push('sms');
  return methods;
}
