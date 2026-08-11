import { insertAuditLog } from '../database/auth-contact-store.js';

export function writeAuditLog(
  actorUserId: number | null,
  action: string,
  targetType: string,
  targetId: string,
  ipAddress: string,
  details: Record<string, unknown> = {}
): void {
  insertAuditLog(actorUserId, action, targetType, targetId, ipAddress, JSON.stringify(details));
}
