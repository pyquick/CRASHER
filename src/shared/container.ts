import type { Request } from 'express';
import type { AuthenticatedUser } from '../model.js';

export function resolveContainerScopeForUser(user: AuthenticatedUser): number | null | undefined {
  if (user.role === 'ultraadmin') return undefined;
  return user.container_id ?? null;
}

/**
 * Resolve container scope for database queries.
 * UltraAdmin sees everything (returns null = no filter).
 * Regular users see only their container's data.
 */
export function resolveContainerScope(req: Request): number | null {
  const user = req.authUser;
  if (!user) return null;
  return resolveContainerScopeForUser(user) ?? null;
}

/**
 * Legacy: returns undefined for UltraAdmin (means "no filter" to existing store functions).
 */
export function getContainerScope(req: Request): number | null | undefined {
  const user = req.authUser;
  if (!user || user.role === 'ultraadmin') return undefined;
  return user.container_id ?? null;
}
