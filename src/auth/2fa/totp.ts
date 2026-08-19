import { createHmac, randomBytes } from 'crypto';
import * as userStore from '../../database/auth-store.js';
import { createTokenStore } from '../../shared/verification.js';

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

// ── TOTP temp token (login 2FA step) ──

const TOTP_TEMP_TOKEN_TTL = 60_000;

const totpTempTokens = createTokenStore(TOTP_TEMP_TOKEN_TTL);

export function createTotpTempToken(userId: number): string {
  return totpTempTokens.create({ userId });
}

export function consumeTotpTempToken(token: string): number | null {
  const data = totpTempTokens.consume<{ userId: number }>(token);
  return data?.userId ?? null;
}
