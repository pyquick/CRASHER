import type { Request, Response, NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { config } from './config.js';
import * as auth from './auth.js';
import type { AuthenticatedUser, UserRole } from './model.js';

const CSRF_COOKIE = 'csrf_token';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
      authType?: 'session' | 'api_key';
      apiKeyTier?: import('./model.js').ApiKeyTier;
      apiKeyId?: number;
      apiKeyLimits?: import('./auth.js').ApiKeyLimits;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on('finish', () => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms - ${req.ip}`);
  });
  next();
}

export function errorHandler(
  err: Error & { status?: number; type?: string },
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err.message);
  if (status >= 500 && err.stack) console.error(err.stack);
  if (res.headersSent) return;
  res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : 'Request Error',
    message: status === 500 ? 'The server could not process the request' : err.message,
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'Not Found', path: req.path });
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readCookie(req: Request, name: string): string | undefined {
  const value = req.cookies?.[name];
  if (typeof value !== 'string') return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function readSession(req: Request): { sessionId: string; csrfToken?: string } | null {
  const sessionId = readCookie(req, 'auth_token');
  if (!sessionId || sessionId.length < 32) return null;
  return { sessionId, csrfToken: readCookie(req, CSRF_COOKIE) };
}

export function authenticateSession(req: Request, _res: Response, next: NextFunction): void {
  authenticateSessionUser(req);
  next();
}

function authenticateSessionUser(req: Request): AuthenticatedUser | null {
  const token = readSession(req);
  if (!token) return null;
  const session = auth.getValidSession(token.sessionId, new Date().toISOString());
  if (!session) return null;
  req.authType = 'session';
  req.authUser = session.user;
  return session.user;
}

function authenticateApiKey(req: Request): AuthenticatedUser | null {
  const authorization = req.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const rawKey = bearer || req.get('x-api-key');
  if (!rawKey || rawKey.length < 20) return null;
  const apiKey = auth.authenticateApiKey(rawKey);
  if (!apiKey) return null;
  auth.touchApiKey(apiKey.id);
  req.authType = 'api_key';
  req.authUser = apiKey.user;
  req.apiKeyId = apiKey.id;
  req.apiKeyTier = apiKey.tier;
  req.apiKeyLimits = apiKey.limits;
  return apiKey.user;
}

export function getAuthenticatedUser(req: Request): AuthenticatedUser | null {
  return req.authUser ?? authenticateSessionUser(req);
}

function rejectUnauthorized(req: Request, res: Response): void {
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  } else {
    res.redirect('/web/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!getAuthenticatedUser(req)) {
    rejectUnauthorized(req, res);
    return;
  }
  next();
}

export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  if (!getAuthenticatedUser(req)) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    return;
  }
  next();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiRequireKey) {
    next();
    return;
  }
  if (!authenticateApiKey(req)) {
    res.status(401).json({ error: 'Unauthorized', message: 'A valid API key is required' });
    return;
  }
  next();
}

export function clearApiKeyIdentity(req: Request, _res: Response, next: NextFunction): void {
  if (req.authType === 'api_key') {
    delete req.authType;
    delete req.authUser;
    delete req.apiKeyId;
    delete req.apiKeyTier;
    delete req.apiKeyLimits;
  }
  next();
}

/**
 * Restrict API key by tier. Viewer keys can only GET, operator keys cannot DELETE.
 * Session-authenticated users (login cookie) are not restricted.
 */
export function requireApiKeyTier(...tiers: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.authType !== 'api_key') { next(); return; }
    const tier = req.apiKeyTier || 'operator';
    if (!tiers.includes(tier)) {
      res.status(403).json({ error: 'Forbidden', message: `API key tier '${tier}' cannot perform this action` });
      return;
    }
    next();
  };
}

/**
 * Block viewer-tier API keys from using any POST/PUT/PATCH/DELETE method.
 */
export function requireApiKeyWriteAccess(req: Request, res: Response, next: NextFunction): void {
  if (req.authType !== 'api_key') { next(); return; }
  const tier = req.apiKeyTier || 'operator';
  if (tier === 'viewer' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.status(403).json({ error: 'Forbidden', message: 'Viewer-tier API keys cannot perform write operations' });
    return;
  }
  next();
}

/**
 * Block viewer and operator-tier API keys from DELETE operations.
 * Admin-tier keys and session auth pass through.
 */
export function requireApiKeyDeleteAccess(req: Request, res: Response, next: NextFunction): void {
  if (req.authType !== 'api_key') { next(); return; }
  const tier = req.apiKeyTier || 'operator';
  if (req.method === 'DELETE' && tier !== 'admin') {
    res.status(403).json({ error: 'Forbidden', message: 'Only admin-tier API keys can perform delete operations' });
    return;
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: 'Forbidden', message: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookieToken = readCookie(req, CSRF_COOKIE);
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || !tokensEqual(cookieToken, headerToken)) {
    res.status(403).json({ error: 'Forbidden', message: 'Invalid CSRF token' });
    return;
  }
  next();
}

export function setCsrfCookie(res: Response): string {
  const token = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: config.sessionHours * 60 * 60 * 1000,
    path: '/',
  });
  return token;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export function rateLimit(options: { windowMs: number; limit: number; key?: (req: Request) => string }) {
  const entries = new Map<string, RateLimitEntry>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = options.key?.(req) ?? req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const current = entries.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + options.windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    entries.set(key, entry);

    res.setHeader('RateLimit-Limit', options.limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, options.limit - entry.count));
    res.setHeader('RateLimit-Reset', Math.ceil(entry.resetAt / 1000));
    if (entry.count > options.limit) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Too Many Requests', message: 'Rate limit exceeded' });
      return;
    }

    if (entries.size > 10000) {
      for (const [storedKey, stored] of entries) {
        if (stored.resetAt <= now) entries.delete(storedKey);
      }
    }
    next();
  };
}

export function apiKeyRateLimit(windowSeconds: number, limitField: 'minute_limit' | 'daily_limit') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const limit = req.apiKeyLimits?.[limitField] ?? 0;
    if (req.authType !== 'api_key' || !req.apiKeyId || limit === 0) {
      next();
      return;
    }

    const quota = auth.consumeApiKeyQuota(req.apiKeyId, windowSeconds, limit);
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', quota.remaining);
    res.setHeader('RateLimit-Reset', quota.resetAt);
    if (!quota.allowed) {
      res.setHeader('Retry-After', Math.max(1, quota.resetAt - Math.floor(Date.now() / 1000)));
      res.status(429).json({ error: 'Too Many Requests', message: 'API key rate limit exceeded' });
      return;
    }
    next();
  };
}

export { readSession };
