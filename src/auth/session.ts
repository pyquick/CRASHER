import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import type { UserRole } from '../model.js';
import { config } from '../config.js';
import * as store from '../database/auth-store.js';
import { nowSqlDateTime, nowSqlDateTimePlusHours } from '../shared/date.js';
import { isContainerBanned } from './container.js';

function hashLookupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(userId: number): string {
  const user = store.findUserById(userId);
  if (!user || user.is_active !== 1) throw new Error('User is not active');
  const rawToken = randomBytes(32).toString('base64url');
  const expiresAtSql = nowSqlDateTimePlusHours(config.sessionHours);
  store.insertSession(hashLookupToken(rawToken), user.id, user.session_version, expiresAtSql);
  store.updateUserLastLogin(userId);
  return rawToken;
}

export function getValidSession(rawToken: string): { user: { id: number; username: string; role: UserRole; container_id: number | null; totp_enabled: number } } | null {
  const row = store.findValidSession(hashLookupToken(rawToken), nowSqlDateTime());
  if (!row || row.is_active !== 1 || row.session_version !== row.stored_version) return null;
  if (row.role !== 'ultraadmin' && row.container_id) {
    if (isContainerBanned(row.container_id)) return null;
  }
  store.touchSession(hashLookupToken(rawToken));
  return {
    user: {
      id: row.id,
      username: row.username,
      role: row.role as UserRole,
      container_id: row.container_id ?? null,
      totp_enabled: row.totp_enabled ?? 0,
    },
  };
}

export function deleteSession(rawToken: string): void {
  store.deleteSessionByHash(hashLookupToken(rawToken));
}

export function purgeExpiredSessions(): void {
  store.deleteExpiredSessions(nowSqlDateTime());
}

export { hashLookupToken };
