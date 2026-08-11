import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import type { AuthenticatedUser, UserRole } from '../model.js';
import * as store from '../database/auth-store.js';
import { hashPassword, verifyPassword, validatePassword, validateUsername, passwordIsCurrent, generateInitialPassword } from './password.js';
import { nowSqlDateTime } from '../shared/date.js';
import { writeAuditLog } from './audit.js';
import { isContainerBanned, getContainerById } from './container.js';

// ── User helpers ──

function publicUser(user: { id: number; username: string; role: UserRole; container_id?: number | null; totp_enabled?: number | null }): AuthenticatedUser {
  return { id: user.id, username: user.username, role: user.role, container_id: user.container_id ?? null, totp_enabled: user.totp_enabled ?? 0 };
}

// ── User CRUD ──

export function hasUsers(): boolean {
  return store.countUsers() > 0;
}

export function createUser(username: string, password: string, role: UserRole, containerId?: number | null): AuthenticatedUser {
  const normalizedUsername = username.trim();
  const usernameError = validateUsername(normalizedUsername, role);
  if (usernameError) throw new Error(usernameError);
  const passwordError = validatePassword(password, normalizedUsername);
  if (passwordError) throw new Error(passwordError);
  if (!['ultraadmin', 'admin', 'operator', 'viewer'].includes(role)) throw new Error('Invalid role');
  if (role === 'ultraadmin' && hasUsers()) throw new Error('UltraAdmin can only be created during initial setup');

  const result = store.insertUser(normalizedUsername, hashPassword(password), role, containerId ?? null, role === 'ultraadmin' ? 1 : 0);
  return { id: Number(result.lastInsertRowid), username: normalizedUsername, role, container_id: containerId ?? null };
}

export { generateInitialPassword };

export function authenticateUser(username: string, password: string, containerId?: number | null): AuthenticatedUser | null {
  let user;
  if (containerId !== undefined && containerId !== null) {
    user = store.findUserByUsernameInContainer(username.trim(), containerId);
  } else {
    user = store.findUserByUsername(username.trim());
  }
  const fallback = 'pbkdf2-sha256$AAAAAAAAAAAAAAAAAAAAAA$' + Buffer.alloc(32).toString('base64url');
  const valid = verifyPassword(password, user?.password_hash ?? fallback);
  if (!user || !valid || user.is_active !== 1) return null;
  if (user.role !== 'ultraadmin' && user.container_id) {
    if (isContainerBanned(user.container_id)) return null;
  }
  if (!passwordIsCurrent(user.password_hash)) {
    store.updateUserPassword(user.id, hashPassword(password));
  }
  return publicUser(user);
}

export function listUsers(containerId?: number | null) {
  return store.listUsers(containerId);
}

export function getUserById(id: number) {
  return store.findUserById(id);
}

export function getUserByUsernameInContainer(username: string, containerId: number) {
  return store.findUserByUsernameInContainer(username, containerId) || null;
}

export function lookupUserByUsername(username: string) {
  return store.findUserByUsername(username.trim()) || null;
}

export function updateUser(id: number, changes: { role?: UserRole; is_active?: boolean }, actorId?: number): boolean {
  const user = getUserById(id);
  if (!user) return false;
  if (user.role === 'ultraadmin') throw new Error('Cannot modify UltraAdmin account');
  if (actorId === id && changes.is_active === false) throw new Error('You cannot disable your own account');
  const role = changes.role ?? user.role;
  const active = changes.is_active === undefined ? user.is_active : changes.is_active ? 1 : 0;
  if (!['admin', 'operator', 'viewer'].includes(role)) throw new Error('Invalid role');
  if (user.role === 'admin' && user.is_active === 1 && (role !== 'admin' || active === 0) && store.countActiveAdminsInContainer(user.container_id) <= 1) {
    throw new Error('At least one active admin account is required in this container');
  }
  store.updateUserRole(id, role, active);
  store.invalidateUserSessions(id);
  return true;
}

export function changePassword(actor: AuthenticatedUser, userId: number, currentPassword: string | undefined, newPassword: string): boolean {
  const user = getUserById(userId);
  if (!user) return false;
  if (actor.id !== userId && actor.role !== 'admin') throw new Error('Insufficient permissions');
  if (actor.id === userId && !currentPassword) throw new Error('Current password is required');
  if (actor.id === userId && !verifyPassword(currentPassword!, user.password_hash)) throw new Error('Current password is incorrect');
  const passwordError = validatePassword(newPassword, user.username);
  if (passwordError) throw new Error(passwordError);
  if (verifyPassword(newPassword, user.password_hash)) throw new Error('New password must be different from the current password');

  store.updateUserPassword(userId, hashPassword(newPassword));
  store.invalidateUserSessions(userId);
  return true;
}

export function createUserInContainer(username: string, password: string, role: UserRole, containerId: number): AuthenticatedUser {
  if (!['admin', 'operator', 'viewer'].includes(role)) throw new Error('Invalid role for container user');
  const container = getContainerById(containerId);
  if (!container) throw new Error('Container not found');
  if (container.is_banned) throw new Error('Container is banned');
  return createUser(username, password, role, containerId);
}

export { generateInitialPassword as generatePassword };

export function countActiveAdmins(containerId?: number | null): number {
  return store.countActiveAdminsInContainer(containerId);
}
