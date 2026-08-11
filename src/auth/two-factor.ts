import { createHash, createHmac, randomBytes } from 'crypto';
import type { TwoFactorMethod } from '../model.js';
import * as userStore from '../database/auth-store.js';
import * as contactStore from '../database/auth-contact-store.js';
import { getUserById } from './user.js';
import { getAnyEmail } from './email.js';
import { getPrimaryEmail } from './email.js';
import { getPrimaryPhone } from './phone.js';
import { createSession } from './session.js';

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
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '', bits = 0, value = 0;
  for (let i = 0; i < buf.length; i++) { value = (value << 8) | buf[i]; bits += 8; while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 0x1f]; bits -= 5; } }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 0x1f];
  const secret = (result + '====').replace(/=+$/, '');
  const qrUri = `otpauth://totp/CrashReporter:${encodeURIComponent(username)}?secret=${secret}&issuer=CrashReporter&algorithm=SHA1&digits=6&period=30`;
  return `${secret}\n${qrUri}`;
}

export function enableTotp(userId: number, code: string, secret: string): boolean {
  if (!verifyTotpCode(secret, code)) return false;
  userStore.enableUserTotp(userId, secret);
  return true;
}

export function disableTotp(userId: number, code: string): boolean {
  if (!verifyTotp(userId, code)) return false;
  userStore.disableUserTotp(userId);
  return true;
}

function verifyTotpCode(secret: string, code: string): boolean {
  if (code.length !== TOTP_DIGITS || !/^\d+$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000);
  return generateTotp(secret, now) === code || generateTotp(secret, now - TOTP_PERIOD) === code;
}

export function verifyTotp(userId: number, code: string): boolean {
  const row = userStore.findUserTotpSecret(userId);
  if (!row) return false;
  return verifyTotpCode(row.totp_secret, code);
}

// ── TOTP temp token (for login 2FA step) ──

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

// ── First login email verification (admin) ──

const FIRST_LOGIN_TTL = 10 * 60 * 1000;
const FIRST_LOGIN_COOLDOWN = 60_000;

interface Email2FASession {
  userId: number;
  codeHash: string;
  email: string;
  expires: number;
  lastResentAt: number;
}

const firstLoginSessions = new Map<string, Email2FASession>();

export function createFirstLoginVerSession(userId: number): { tempToken: string; emailCode: string; email: string } | null {
  const email = getAnyEmail(userId);
  if (!email) return null;
  const emailCode = String(Math.floor(100000 + Math.random() * 900000));
  const tempToken = randomBytes(32).toString('base64url');
  firstLoginSessions.set(tempToken, {
    userId, email, expires: Date.now() + FIRST_LOGIN_TTL,
    codeHash: createHash('sha256').update(emailCode).digest('hex'), lastResentAt: Date.now(),
  });
  return { tempToken, emailCode, email };
}

export function consumeFirstLoginVerSession(tempToken: string, code: string): string | null {
  const session = firstLoginSessions.get(tempToken);
  if (!session || session.expires < Date.now()) { firstLoginSessions.delete(tempToken); return null; }
  if (createHash('sha256').update(code.trim()).digest('hex') !== session.codeHash) return null;
  firstLoginSessions.delete(tempToken);
  const emailRow = contactStore.findEmailsByUserIdAndEmail(session.userId, session.email);
  if (emailRow) contactStore.markEmailVerified(emailRow.id);
  return createSession(session.userId);
}

export function resendFirstLoginCode(tempToken: string): { emailCode: string; email: string } | null {
  const session = firstLoginSessions.get(tempToken);
  if (!session || session.expires < Date.now()) { firstLoginSessions.delete(tempToken); return null; }
  if (Date.now() - session.lastResentAt < FIRST_LOGIN_COOLDOWN) return null;
  const emailCode = String(Math.floor(100000 + Math.random() * 900000));
  session.codeHash = createHash('sha256').update(emailCode).digest('hex');
  session.lastResentAt = Date.now();
  return { emailCode, email: session.email };
}

// ── Login email 2FA ──

const LOGIN_EMAIL_2FA_TTL = 10 * 60 * 1000;
const LOGIN_EMAIL_2FA_COOLDOWN = 60_000;

const loginEmail2FASessions = new Map<string, Email2FASession>();

export function createLoginEmail2FASession(userId: number): { tempToken: string; emailCode: string; email: string } | null {
  const email = getPrimaryEmail(userId);
  if (!email) return null;
  const emailCode = String(Math.floor(100000 + Math.random() * 900000));
  const tempToken = randomBytes(32).toString('base64url');
  loginEmail2FASessions.set(tempToken, {
    userId, email, expires: Date.now() + LOGIN_EMAIL_2FA_TTL,
    codeHash: createHash('sha256').update(emailCode).digest('hex'), lastResentAt: Date.now(),
  });
  return { tempToken, emailCode, email };
}

export function consumeLoginEmail2FASession(tempToken: string, code: string): number | null {
  const session = loginEmail2FASessions.get(tempToken);
  if (!session || session.expires < Date.now()) { loginEmail2FASessions.delete(tempToken); return null; }
  if (createHash('sha256').update(code.trim()).digest('hex') !== session.codeHash) return null;
  loginEmail2FASessions.delete(tempToken);
  return session.userId;
}

export function resendLoginEmail2FACode(tempToken: string): { emailCode: string; email: string } | null {
  const session = loginEmail2FASessions.get(tempToken);
  if (!session || session.expires < Date.now()) { loginEmail2FASessions.delete(tempToken); return null; }
  if (Date.now() - session.lastResentAt < LOGIN_EMAIL_2FA_COOLDOWN) return null;
  const emailCode = String(Math.floor(100000 + Math.random() * 900000));
  session.codeHash = createHash('sha256').update(emailCode).digest('hex');
  session.lastResentAt = Date.now();
  return { emailCode, email: session.email };
}

// ── Operation 2FA ──

const OPERATION_2FA_TTL = 5 * 60 * 1000;
const OPERATION_2FA_COOLDOWN = 60_000;

interface Operation2FASession {
  userId: number;
  method: TwoFactorMethod;
  action: string;
  bodyPayload: string;
  codeHash?: string;
  email?: string;
  phone?: string;
  expires: number;
  lastResentAt: number;
}

const operation2FASessions = new Map<string, Operation2FASession>();

export function createOperation2FASession(
  userId: number, method: TwoFactorMethod, action: string, bodyPayload: Record<string, unknown>
): { tempToken: string; code?: string; email?: string; phone?: string } | null {
  const tempToken = randomBytes(32).toString('base64url');
  const session: Operation2FASession = {
    userId, method, action, bodyPayload: JSON.stringify(bodyPayload),
    expires: Date.now() + OPERATION_2FA_TTL, lastResentAt: Date.now(),
  };

  if (method === 'email' || method === 'sms') {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    session.codeHash = createHash('sha256').update(code).digest('hex');
    if (method === 'email') {
      const email = getPrimaryEmail(userId);
      if (!email) return null;
      session.email = email;
      operation2FASessions.set(tempToken, session);
      return { tempToken, code, email };
    } else {
      const phone = getPrimaryPhone(userId);
      if (!phone) return null;
      session.phone = phone;
      operation2FASessions.set(tempToken, session);
      return { tempToken, code, phone };
    }
  }

  operation2FASessions.set(tempToken, session);
  return { tempToken };
}

export function consumeOperation2FASession(
  tempToken: string, code: string
): { userId: number; action: string; bodyPayload: Record<string, unknown> } | null {
  const session = operation2FASessions.get(tempToken);
  if (!session || session.expires < Date.now()) { operation2FASessions.delete(tempToken); return null; }

  let valid = false;
  if (session.method === 'totp') {
    valid = verifyTotp(session.userId, code);
  } else if (session.codeHash) {
    valid = createHash('sha256').update(code.trim()).digest('hex') === session.codeHash;
  }

  if (!valid) return null;

  operation2FASessions.delete(tempToken);
  let bodyPayload: Record<string, unknown> = {};
  try { bodyPayload = JSON.parse(session.bodyPayload); } catch {}
  return { userId: session.userId, action: session.action, bodyPayload };
}

export function resendOperation2FACode(tempToken: string): { code: string; email?: string; phone?: string } | null {
  const session = operation2FASessions.get(tempToken);
  if (!session || session.expires < Date.now()) { operation2FASessions.delete(tempToken); return null; }
  if (session.method === 'totp') return null;
  if (Date.now() - session.lastResentAt < OPERATION_2FA_COOLDOWN) return null;

  const code = String(Math.floor(100000 + Math.random() * 900000));
  session.codeHash = createHash('sha256').update(code).digest('hex');
  session.lastResentAt = Date.now();
  return { code, email: session.email, phone: session.phone };
}

// ── Available methods ──

export function getAvailable2FAMethods(userId: number): TwoFactorMethod[] {
  const methods: TwoFactorMethod[] = [];
  const user = getUserById(userId);
  if (user?.totp_enabled) methods.push('totp');
  if (contactStore.countVerifiedEmails(userId) > 0) methods.push('email');
  if (contactStore.countVerifiedPhones(userId) > 0) methods.push('sms');
  return methods;
}

// ── MFA session ──

const MFA_SESSION_TTL = 5 * 60 * 1000;

const mfaSessions = new Map<string, { userId: number; expires: number }>();

export function createMfaSession(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  mfaSessions.set(token, { userId, expires: Date.now() + MFA_SESSION_TTL });
  return token;
}

export function validateMfaSession(token: string, userId: number): boolean {
  const session = mfaSessions.get(token);
  if (!session || session.expires < Date.now()) { mfaSessions.delete(token); return false; }
  return session.userId === userId;
}
