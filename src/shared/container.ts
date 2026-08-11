import type { Request } from 'express';

/**
 * Resolve container scope for database queries.
 * UltraAdmin sees everything (returns null = no filter).
 * Regular users see only their container's data.
 */
export function resolveContainerScope(req: Request): number | null {
  const user = req.authUser;
  if (!user || user.role === 'ultraadmin') return null;
  return user.container_id ?? null;
}

/**
 * Legacy: returns undefined for UltraAdmin (means "no filter" to existing store functions).
 */
export function getContainerScope(req: Request): number | null | undefined {
  const user = req.authUser;
  if (!user || user.role === 'ultraadmin') return undefined;
  return user.container_id ?? null;
}
