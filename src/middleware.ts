import type { Request, Response, NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { config } from './config.js';
import * as auth from './auth.js';
import type { AuthenticatedUser, UserRole } from './model.js';
import { CONTAINER_TIER_LIMITS } from './model.js';
import { setSessionCookie, clearCookie } from './shared/cookie.js';

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
  const session = auth.getValidSession(token.sessionId);
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

/**
 * Middleware: requireUltraAdmin
 * Only UltraAdmin can access routes protected by this middleware.
 */
export function requireUltraAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = getAuthenticatedUser(req);
  if (!user || user.role !== 'ultraadmin') {
    res.status(403).json({ error: 'Forbidden', message: 'UltraAdmin access required' });
    return;
  }
  next();
}

/**
 * Middleware: requireContainerAccess
 * For non-ultraadmin users:
 * - Ensures the user belongs to a container
 * - Redirects to login if not
 * - Sets req.containerScope for downstream use
 * UltraAdmin passes through without container scope.
 */
export function requireContainerAccess(req: Request, res: Response, next: NextFunction): void {
  const user = getAuthenticatedUser(req);
  if (!user) {
    // No authenticated user — pass through for public routes (login, forgot-password, etc.)
    // Protected routes are gated by requireAuth/requireApiAuth in their handlers
    next();
    return;
  }
  if (user.role === 'ultraadmin') {
    next();
    return;
  }
  if (!user.container_id) {
    // User has no container — shouldn't happen for non-ultraadmin users
    res.status(403).json({ error: 'Forbidden', message: 'No container assigned. Contact your UltraAdmin.' });
    return;
  }
  // Check if container is banned
  if (auth.isContainerBanned(user.container_id)) {
    // Clear session
    const session = readSession(req);
    if (session) auth.deleteSession(session.sessionId);
    clearCookie(res, 'auth_token');
    clearCookie(res, 'csrf_token');
    res.status(403).json({
      error: 'Forbidden',
      message: 'Your container has been suspended. Please contact your administrator.',
      container_banned: true,
    });
    return;
  }
  next();
}

/**
 * Middleware: enforceContainerSizeLimit
 * For ingest routes (POST), checks if the container has exceeded its storage limit.
 * Only applies to non-ultraadmin users with API key auth (session auth skips for management).
 */
export function enforceContainerSizeLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }
  if (!config.apiRequireKey) {
    next();
    return;
  }
  const user = getAuthenticatedUser(req);
  if (!user || user.role === 'ultraadmin' || !user.container_id) {
    next();
    return;
  }
  const containerId = user.container_id;
  const container = auth.getContainerById(containerId);
  if (!container) {
    next();
    return;
  }
  const limitBytes = CONTAINER_TIER_LIMITS[container.tier];
  const storageBytes = auth.getContainerStorageSize(containerId);
  if (storageBytes > limitBytes) {
    res.status(403).json({
      error: 'Forbidden',
      message: `Container storage limit exceeded. Current: ${(storageBytes / (1024 * 1024)).toFixed(1)}MB, Limit: ${(limitBytes / (1024 * 1024)).toFixed(1)}MB. Contact your UltraAdmin to upgrade your container tier.`,
      container_over_limit: true,
    });
    return;
  }
  next();
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
  setSessionCookie(res, CSRF_COOKIE, token, config.sessionHours * 60 * 60 * 1000, false);
  return token;
}

export { createMemoryRateLimiter as rateLimit, createApiKeyRateLimiter as apiKeyRateLimit } from './shared/rate-limit.js';

export { readSession };

const MFA_COOKIE = 'mfa_token';

export function setMfaCookie(res: Response, token?: string): string {
  const mfaToken = token || randomBytes(32).toString('base64url');
  setSessionCookie(res, MFA_COOKIE, mfaToken, 5 * 60 * 1000);
  return mfaToken;
}

export function readMfaToken(req: Request): string | undefined {
  return readCookie(req, MFA_COOKIE);
}

export function clearMfaCookie(res: Response): void {
  clearCookie(res, MFA_COOKIE);
}
