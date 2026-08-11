import type { Request, Response, NextFunction } from 'express';
import { consumeApiKeyQuota } from '../auth/api-key.js';

// ── Types ──

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitConfig {
  windowMs: number;
  limit: number;
  key?: (req: Request) => string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number;
}

const MAX_ENTRIES = 10000;

export function createMemoryRateLimiter(config: RateLimitConfig) {
  const entries = new Map<string, RateLimitEntry>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = config.key?.(req) ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const current = entries.get(key);
    const entry: RateLimitEntry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + config.windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    entries.set(key, entry);

    setRateLimitHeaders(res, { limit: config.limit, remaining: Math.max(0, config.limit - entry.count), resetAt: entry.resetAt });

    if (entry.count > config.limit) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Too Many Requests', message: 'Rate limit exceeded' });
      return;
    }

    if (entries.size > MAX_ENTRIES) {
      for (const [storedKey, stored] of entries) {
        if (stored.resetAt <= now) entries.delete(storedKey);
      }
    }

    next();
  };
}

// ── API Key Rate Limiter (DB-backed) ──

export function createApiKeyRateLimiter(windowSeconds: number, limitField: 'minute_limit' | 'daily_limit') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const limit = req.apiKeyLimits?.[limitField] ?? 0;
    if (req.authType !== 'api_key' || !req.apiKeyId || limit === 0) {
      next();
      return;
    }

    const quota = consumeApiKeyQuota(req.apiKeyId, windowSeconds, limit);
    setRateLimitHeaders(res, { limit, remaining: quota.remaining, resetAt: quota.resetAt });

    if (!quota.allowed) {
      res.setHeader('Retry-After', Math.max(1, quota.resetAt - Math.floor(Date.now() / 1000)));
      res.status(429).json({ error: 'Too Many Requests', message: 'API key rate limit exceeded' });
      return;
    }
    next();
  };
}

// ── Helper: set standard rate limit headers ──

export function setRateLimitHeaders(res: Response, info: RateLimitInfo): void {
  res.setHeader('X-RateLimit-Limit', info.limit);
  res.setHeader('X-RateLimit-Remaining', info.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(info.resetAt / 1000));
}
