import type { TwoFactorMethod } from '../../model.js';
import { createVerificationStore } from '../../shared/verification.js';
import { getPrimaryEmail } from '../email/manage.js';
import { getPrimaryPhone } from './phone.js';
import { verifyTotp } from './totp.js';

// ── Operation 2FA ──
//
// Sensitive account operations (user creation, API key management, email/phone
// changes, ...) are wrapped in a 2FA challenge. The challenge stores the pending
// request body; once the code is verified, the handler re-executes the operation
// with the stored payload.

const OPERATION_2FA_TTL = 5 * 60 * 1000;
const OPERATION_2FA_COOLDOWN = 60_000;
const OPERATION_2FA_MAX_ATTEMPTS = 5;

interface Operation2FAData {
  userId: number;
  method: TwoFactorMethod;
  action: string;
  bodyPayload: string;
  email?: string;
  phone?: string;
}

const store = createVerificationStore<Operation2FAData>(
  OPERATION_2FA_TTL,
  OPERATION_2FA_COOLDOWN,
  OPERATION_2FA_MAX_ATTEMPTS
);

export function createOperation2FASession(
  userId: number, method: TwoFactorMethod, action: string, bodyPayload: Record<string, unknown>
): { tempToken: string; code?: string; email?: string; phone?: string } | null {
  const data: Operation2FAData = {
    userId, method, action, bodyPayload: JSON.stringify(bodyPayload),
  };

  if (method === 'email' || method === 'sms') {
    const contact = method === 'email' ? getPrimaryEmail(userId) : getPrimaryPhone(userId);
    if (!contact) return null;
    if (method === 'email') data.email = contact; else data.phone = contact;
    const { token, code } = store.createWithCode(data);
    return { tempToken: token, code, email: data.email, phone: data.phone };
  }

  const { token } = store.create(data);
  return { tempToken: token };
}

export function consumeOperation2FASession(
  tempToken: string, code: string
): { userId: number; action: string; bodyPayload: Record<string, unknown> } | null {
  const data = store.get<Operation2FAData>(tempToken);
  if (!data) return null;

  const valid = data.method === 'totp' ? verifyTotp(data.userId, code) : store.verify(tempToken, code);
  if (!valid) return null;

  store.consume(tempToken);
  let bodyPayload: Record<string, unknown> = {};
  try { bodyPayload = JSON.parse(data.bodyPayload); } catch {}
  return { userId: data.userId, action: data.action, bodyPayload };
}

export function resendOperation2FACode(tempToken: string): { code: string; email?: string; phone?: string } | null {
  const data = store.get<Operation2FAData>(tempToken);
  if (!data || data.method === 'totp') return null;
  const code = store.resend(tempToken);
  if (!code) return null;
  return { code, email: data.email, phone: data.phone };
}
