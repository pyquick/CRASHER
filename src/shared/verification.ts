import { createHash, randomBytes } from 'crypto';

/**
 * Generic in-memory verification session store.
 * Used for 2FA email/SMS code verification, TOTP temp tokens, and MFA sessions.
 *
 * Replaces 6 duplicate in-memory Map stores in auth.ts with a single generic implementation.
 */

export interface VerificationSession<T = Record<string, unknown>> {
  codeHash?: string;
  expires: number;
  lastResentAt: number;
  attempts: number;
  data: T;
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

export function createVerificationStore<T = Record<string, unknown>>(
  ttlMs: number,
  resendCooldownMs: number = 60000,
  maxAttempts: number = 0
) {
  const store = new Map<string, VerificationSession<T>>();

  function cleanup(): void {
    const now = Date.now();
    for (const [key, session] of store) {
      if (session.expires < now) store.delete(key);
    }
  }

  function create(data: T, code?: string): { token: string; code?: string } {
    const token = randomBytes(32).toString('base64url');
    const session: VerificationSession<T> = {
      expires: Date.now() + ttlMs,
      lastResentAt: Date.now(),
      attempts: 0,
      data,
    };
    if (code) {
      session.codeHash = hashCode(code);
    }
    store.set(token, session);
    return { token, code };
  }

  function createWithCode(data: T): { token: string; code: string } {
    const code = generateCode();
    return { ...create(data, code), code };
  }

  function verify(token: string, code: string): boolean {
    cleanup();
    const session = store.get(token);
    if (!session || session.expires < Date.now()) {
      store.delete(token);
      return false;
    }
    if (maxAttempts > 0 && session.attempts >= maxAttempts) {
      store.delete(token);
      return false;
    }
    session.attempts++;
    if (!session.codeHash) return true; // No code needed (e.g. TOTP tokens)
    return hashCode(code) === session.codeHash;
  }

  function consume<T2 = T>(token: string): T2 | null {
    cleanup();
    const session = store.get(token);
    if (!session || session.expires < Date.now()) {
      store.delete(token);
      return null;
    }
    store.delete(token);
    return session.data as unknown as T2;
  }

  function get<T2 = T>(token: string): T2 | null {
    cleanup();
    const session = store.get(token);
    if (!session || session.expires < Date.now()) {
      store.delete(token);
      return null;
    }
    return session.data as unknown as T2;
  }

  function resend(token: string): string | null {
    cleanup();
    const session = store.get(token);
    if (!session || session.expires < Date.now()) {
      store.delete(token);
      return null;
    }
    if (Date.now() - session.lastResentAt < resendCooldownMs) {
      return null;
    }
    const code = generateCode();
    session.codeHash = hashCode(code);
    session.lastResentAt = Date.now();
    return code;
  }

  return { create, createWithCode, verify, consume, get, resend, cleanup };
}

/**
 * Simple token store — no verification code, just create → consume.
 * Used for TOTP temp tokens and MFA session tokens.
 */
export function createTokenStore(ttlMs: number) {
  const store = new Map<string, { data: Record<string, unknown>; expires: number }>();

  function create(data: Record<string, unknown> = {}): string {
    const token = randomBytes(32).toString('base64url');
    store.set(token, { data, expires: Date.now() + ttlMs });
    return token;
  }

  function consume<T = Record<string, unknown>>(token: string): T | null {
    const entry = store.get(token);
    if (!entry || entry.expires < Date.now()) {
      store.delete(token);
      return null;
    }
    store.delete(token);
    return entry.data as unknown as T;
  }

  function get<T = Record<string, unknown>>(token: string): T | null {
    const entry = store.get(token);
    if (!entry || entry.expires < Date.now()) {
      store.delete(token);
      return null;
    }
    return entry.data as unknown as T;
  }

  return { create, consume, get };
}
