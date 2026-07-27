import type { Request, Response, NextFunction } from 'express';
import { createHmac } from 'crypto';
import { config } from './config.js';

export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url} - ${req.ip}`);
  next();
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(`[ERROR] ${req.method} ${req.url}:`, err.message);
  if (err.stack) {
    console.error(err.stack);
  }
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'Not Found', path: req.url });
}

// ---------- Auth / Session ----------

interface SessionPayload {
  username: string;
  iat: number;
  exp: number;
}

function createSessionToken(username: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 24 * 60 * 60; // 24 hours
  const payload: SessionPayload = { username, iat, exp };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = createHmac('sha256', config.sessionSecret);
  hmac.update(data);
  const signature = hmac.digest('base64url');
  return `${data}.${signature}`;
}

function verifySessionToken(token: string): SessionPayload | null {
  try {
    const [data, signature] = token.split('.');
    if (!data || !signature) return null;

    const hmac = createHmac('sha256', config.sessionSecret);
    hmac.update(data);
    const expected = hmac.digest('base64url');
    if (signature !== expected) return null;

    const payload: SessionPayload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

function readSession(req: Request): SessionPayload | null {
  const token = req.cookies?.auth_token;
  if (!token) return null;
  return verifySessionToken(token);
}

/** Protect web page routes — redirects to login if unauthenticated. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = readSession(req);
  if (!session) {
    // For API requests return 401, for page requests redirect to login
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    } else {
      res.redirect('/web/login?redirect=' + encodeURIComponent(req.originalUrl));
    }
    return;
  }
  next();
}

/** Protect API routes — returns 401 if unauthenticated. */
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    return;
  }
  next();
}

export { createSessionToken, verifySessionToken, readSession };
