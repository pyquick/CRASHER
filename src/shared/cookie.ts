import type { Response } from 'express';
import { config } from '../config.js';

/**
 * Set a session cookie with standard secure attributes.
 */
export function setSessionCookie(res: Response, name: string, value: string, maxAgeMs: number, httpOnly = true): void {
  res.cookie(name, value, {
    httpOnly,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: maxAgeMs,
    path: '/',
  });
}

/**
 * Clear a cookie with matching attributes.
 */
export function clearCookie(res: Response, name: string): void {
  res.clearCookie(name, { path: '/', secure: config.cookieSecure, sameSite: 'strict' });
}
