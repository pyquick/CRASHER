import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const FORMAT_VERSION = 'v1';

function encryptionKey(): Buffer {
  const value = config.aiEncryptionKey.trim();
  if (!value) throw new Error('AI encryption is not configured');
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('AI_ENCRYPTION_KEY must be exactly 32 bytes encoded as 64 hexadecimal characters');
  }
  const key = Buffer.from(value, 'hex');
  if (key.length !== KEY_LENGTH) throw new Error('AI encryption key must be 32 bytes');
  return key;
}

export function isAiEncryptionConfigured(): boolean {
  const value = config.aiEncryptionKey.trim();
  if (!value) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('AI_ENCRYPTION_KEY must be exactly 32 bytes encoded as 64 hexadecimal characters');
  }
  return true;
}

export function encryptAiValue(plaintext: string, aad: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [FORMAT_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':');
}

export function decryptAiValue(payload: string, aad: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) throw new Error('Invalid encrypted AI value');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_LENGTH || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Invalid encrypted AI value');
  }
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
