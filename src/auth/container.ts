import { existsSync, unlinkSync } from 'fs';
import { config } from '../config.js';
import * as store from '../database/auth-store.js';
import type { Container, ContainerStatus, ContainerTier } from '../model.js';
import { CONTAINER_TIER_LIMITS } from '../model.js';
import { writeAuditLog } from './audit.js';

export function createContainer(name: string, tier: number, createdBy: number): Container {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 100) throw new Error('Container name must be 1-100 characters');
  if (!/^[A-Za-z0-9_\-. ]+$/.test(normalizedName)) throw new Error('Container name contains invalid characters');
  if (![1, 2, 3, 4, 5].includes(tier)) throw new Error('Invalid tier. Must be 1-5');

  const existing = store.findContainerByName(normalizedName);
  if (existing) throw new Error('A container with this name already exists');

  const result = store.insertContainer(normalizedName, tier, createdBy);
  return getContainerById(Number(result.lastInsertRowid))!;
}

export function getContainerById(id: number): Container | undefined {
  return store.findContainerById(id);
}

export function getContainerByName(name: string): Container | undefined {
  return store.findContainerByName(name.trim());
}

export function listContainers(): Container[] {
  return store.listAllContainers();
}

export function listActiveContainers(): Container[] {
  return store.listActiveContainers();
}

export function banContainer(id: number, actorId: number): Container | null {
  const container = getContainerById(id);
  if (!container) return null;
  store.banContainer(id);
  store.deleteSessionsForContainer(id);
  writeAuditLog(actorId, 'container.banned', 'container', String(id), '', { name: container.name });
  return getContainerById(id)!;
}

export function unbanContainer(id: number, actorId: number): Container | null {
  const container = getContainerById(id);
  if (!container) return null;
  store.unbanContainer(id);
  writeAuditLog(actorId, 'container.unbanned', 'container', String(id), '', { name: container.name });
  return getContainerById(id)!;
}

export function deleteContainer(id: number, actorId: number): boolean {
  const container = getContainerById(id);
  if (!container) return false;

  // Delete files from disk
  for (const a of store.getCrashAttachmentPaths(id)) { try { if (existsSync(a.file_path)) unlinkSync(a.file_path); } catch {} }
  for (const a of store.getFeedbackAttachmentPaths(id)) { try { if (existsSync(a.file_path)) unlinkSync(a.file_path); } catch {} }
  for (const f of store.getSourceFilePaths(id)) { try { if (existsSync(f.storage_path)) unlinkSync(f.storage_path); } catch {} }
  for (const f of store.getSymbolFilePaths(id)) { try { if (existsSync(f.file_path)) unlinkSync(f.file_path); } catch {} }

  store.deleteContainerCascade(id);
  writeAuditLog(actorId, 'container.deleted', 'container', String(id), '', { name: container.name });
  return true;
}

export function isContainerBanned(containerId: number): boolean {
  return store.isContainerBanned(containerId);
}

export function getContainerAdminsForNotification(containerId: number): { userId: number; email: string; username: string }[] {
  return store.findContainerAdmins(containerId);
}

export function markBanNotificationSent(containerId: number): void {
  store.markBanNotificationSent(containerId);
}

export function getContainerStorageSize(containerId: number): number {
  return store.sumCrashReportDataSize(containerId)
    + store.sumCrashAttachmentSize(containerId)
    + store.sumFeedbackAttachmentSize(containerId)
    + store.sumSymbolSize(containerId);
}

export function getContainerStatus(containerId: number): ContainerStatus | null {
  const container = getContainerById(containerId);
  if (!container) return null;

  const storageBytes = getContainerStorageSize(containerId);
  const limitBytes = CONTAINER_TIER_LIMITS[container.tier as ContainerTier];

  return {
    container,
    storage_bytes: storageBytes,
    limit_bytes: limitBytes,
    usage_percent: limitBytes > 0 ? (storageBytes / limitBytes) * 100 : 0,
    is_over_limit: storageBytes > limitBytes,
    user_count: store.countUsersInContainer(containerId),
    crash_count: store.countCrashReportsInContainer(containerId),
    feedback_count: store.countFeedbackInContainer(containerId),
    symbol_count: store.countSymbolsInContainer(containerId),
  };
}

export function listContainerStatuses(): ContainerStatus[] {
  return listContainers().map(c => getContainerStatus(c.id)!).filter(Boolean);
}

export function isContainerOverLimit(containerId: number): boolean {
  const tier = store.getContainerTier(containerId) ?? 1;
  const limitBytes = CONTAINER_TIER_LIMITS[tier as ContainerTier];
  return getContainerStorageSize(containerId) > limitBytes;
}

export function getUserContainerId(userId: number): number | null {
  return store.getUserContainerId(userId);
}
