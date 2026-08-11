import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import type { AuthenticatedUser } from '../model.js';
import type { ApiKeyTier } from '../model.js';
import * as store from '../database/auth-store.js';
import { nowSqlDateTime } from '../shared/date.js';
import { getUserById } from './user.js';
import { isContainerBanned } from './container.js';

function hashLookupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeApiKeyLimit(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error(`${field} must be an integer between 0 and 1000000000`);
  }
  return value;
}

export interface ApiKeyLimits {
  minute_limit: number;
  daily_limit: number;
}

export function createApiKey(
  userId: number,
  name: string,
  tier: ApiKeyTier = 'operator',
  expiresAt?: string,
  limits: Partial<ApiKeyLimits> = {}
): { id: number; name: string; key: string; key_prefix: string } {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) throw new Error('User is not active');
  if (!['admin', 'operator', 'viewer'].includes(tier)) throw new Error('Invalid API key tier');
  if (user.role !== 'admin' && tier === 'admin') throw new Error('Only admins can create admin-tier API keys');
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 100) throw new Error('API key name must be 1-100 characters');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error('Invalid expiration date');
  const expiresAtSql = expiresAt ? new Date(expiresAt).toISOString().replace('T', ' ').replace('Z', '') : null;
  const minuteLimit = normalizeApiKeyLimit(limits.minute_limit, 'minute_limit');
  const dailyLimit = normalizeApiKeyLimit(limits.daily_limit, 'daily_limit');

  const key = `crs_${randomBytes(32).toString('base64url')}`;
  const prefix = key.substring(0, 12);
  const result = store.insertApiKey(userId, normalizedName, prefix, hashLookupToken(key), tier, minuteLimit, dailyLimit, expiresAtSql);
  return { id: Number(result.lastInsertRowid), name: normalizedName, key, key_prefix: prefix };
}

export function listApiKeysForUser(user: AuthenticatedUser) {
  if (user.role === 'viewer') return [];
  return store.listApiKeysForUser(user.role === 'admin' ? null : user.id, user.role);
}

export function authenticateApiKey(rawKey: string) {
  const row = store.findApiKey(hashLookupToken(rawKey), nowSqlDateTime());
  if (!row) return null;
  if (row.role !== 'ultraadmin' && row.container_id) {
    if (isContainerBanned(row.container_id)) return null;
  }
  return {
    id: row.id,
    tier: row.tier as ApiKeyTier,
    limits: { minute_limit: row.minute_limit, daily_limit: row.daily_limit },
    user: { id: row.user_id, username: row.username, role: row.role, container_id: row.container_id },
  };
}

export function touchApiKey(id: number): void {
  store.touchApiKey(id);
}

export function revokeApiKey(id: number, actor: AuthenticatedUser): boolean {
  const userId = actor.role === 'admin' ? undefined : actor.id;
  return store.revokeApiKeyById(id, userId) > 0;
}

export function updateApiKeyTier(id: number, tier: ApiKeyTier, actor: AuthenticatedUser): boolean {
  if (actor.role !== 'admin') throw new Error('Insufficient permissions');
  if (!['admin', 'operator', 'viewer'].includes(tier)) throw new Error('Invalid API key tier');
  return store.updateApiKeyTier(id, tier) > 0;
}

export function updateApiKeyLimits(id: number, limits: ApiKeyLimits, actor: AuthenticatedUser): boolean {
  if (actor.role !== 'admin') throw new Error('Insufficient permissions');
  const minuteLimit = normalizeApiKeyLimit(limits.minute_limit, 'minute_limit');
  const dailyLimit = normalizeApiKeyLimit(limits.daily_limit, 'daily_limit');
  return store.updateApiKeyLimits(id, minuteLimit, dailyLimit) > 0;
}

export function consumeApiKeyQuota(id: number, windowSeconds: number, limit: number): { allowed: boolean; remaining: number; resetAt: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const periodStart = Math.floor(nowSec / windowSeconds) * windowSeconds;

  const count = store.findApiKeyQuota(id, periodStart, windowSeconds) + 1;
  if (store.findApiKeyQuota(id, periodStart, windowSeconds) > 0) {
    store.updateApiKeyQuota(id, periodStart, windowSeconds, count);
  } else {
    store.insertApiKeyQuota(id, periodStart, windowSeconds, count);
  }

  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: periodStart + windowSeconds };
}
