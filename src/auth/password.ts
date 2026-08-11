import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import type { UserRole } from '../model.js';
import { findUltraAdminByUsername } from '../database/auth-store.js';
import { nowSqlDateTime } from '../shared/date.js';

const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 310_000;
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const UA_USERNAME_MIN_LENGTH = 15;
const UA_HAS_LETTER = /[A-Za-z]/;
const UA_HAS_DIGIT = /\d/;
const UA_HAS_SYMBOL = /[^A-Za-z0-9]/;

export { nowSqlDateTime };

export function validateUsername(username: string, role?: UserRole): string | null {
  if (role === 'ultraadmin') {
    if (username.length < UA_USERNAME_MIN_LENGTH || username.length > 64) return `UltraAdmin username must be ${UA_USERNAME_MIN_LENGTH}-64 characters`;
    if (!UA_HAS_LETTER.test(username)) return 'UltraAdmin username must contain at least one letter';
    if (!UA_HAS_DIGIT.test(username)) return 'UltraAdmin username must contain at least one number';
    if (!UA_HAS_SYMBOL.test(username)) return 'UltraAdmin username must contain at least one symbol';
    return null;
  }
  if (!USERNAME_PATTERN.test(username)) return 'Username must be 3-64 characters and contain only letters, numbers, dot, underscore, or hyphen';
  const ua = findUltraAdminByUsername(username);
  if (ua) return 'Username is already taken';
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

export function passwordIsCurrent(encoded: string): boolean {
  return encoded.startsWith('pbkdf2-sha256$');
}

export function generateInitialPassword(): string {
  return `V9!${randomBytes(24).toString('base64url')}`;
}
