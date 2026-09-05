import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import * as store from '../store.js';
import { requireCsrf, requireRole } from '../middleware.js';
import { nowSqlDateTime } from '../shared/date.js';
import { parsePositiveId } from '../shared/string.js';
import { resolve2FA } from './auth-common.js';
import { decryptAiValue, encryptAiValue, isAiEncryptionConfigured } from '../ai/crypto.js';
import { writeAuditLog } from '../auth.js';
import { config } from '../config.js';
import { parseBashPolicy } from '../ai/bash-policy.js';
import type { AiProvider } from '../model.js';

const router = Router();
const PROVIDER: AiProvider = 'deepseek';

function sessionOnly(req: Request, res: Response): boolean {
  if (req.authType !== 'session') {
    res.status(403).json({ error: 'Forbidden', message: 'AI provider settings require session authentication' });
    return false;
  }
  return true;
}

export function maskAiProviderKey(value: string): string {
  return value.slice(0, 2) + '*'.repeat(15) + value.slice(-2);
}

function newKeyAad(userId: number): string {
  return `provider-key:${userId}:${randomUUID()}`;
}

function viewConfig(userId: number) {
  const keys = store.listAiProviderKeys(userId, PROVIDER);
  return {
    provider: PROVIDER,
    configured: isAiEncryptionConfigured() && keys.some(key => key.enabled),
    server_ready: isAiEncryptionConfigured(),
    enabled: keys.some(key => key.enabled),
    updated_at: keys.reduce<string | null>((latest, key) => !latest || key.updated_at > latest ? key.updated_at : latest, null),
    keys,
  };
}

function validateApiKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 20 || value.length > 500) return null;
  return value;
}

function bashConfig() {
  const settings = store.getAiBashSettings();
  const parsed = parseBashPolicy(settings.policy_json);
  return { enabled: Boolean(settings.enabled), policy: parsed, updated_at: settings.updated_at };
}

router.get('/ai-bash', requireRole('admin', 'operator'), (req, res): void => {
  if (!sessionOnly(req, res)) return;
  res.json(bashConfig());
});

router.put('/ai-bash', requireRole('admin', 'operator'), requireCsrf, (req, res): void => {
  if (!sessionOnly(req, res)) return;
  const enabled = req.body?.enabled === true;
  const policy = req.body?.policy;
  if (!policy || typeof policy !== 'object') { res.status(400).json({ error: 'Bad Request', message: 'A policy object is required' }); return; }
  const raw = JSON.stringify(policy);
  const parsed = parseBashPolicy(raw);
  if (raw.length > 50000 || (!['allow', 'deny'].includes(parsed.default))) { res.status(400).json({ error: 'Bad Request', message: 'Invalid Bash policy' }); return; }
  const saved = store.updateAiBashSettings(enabled, JSON.stringify(parsed), req.authUser!.id, nowSqlDateTime());
  config.aiBashEnabled = Boolean(saved.enabled);
  config.aiBashPolicy = saved.policy_json;
  writeAuditLog(req.authUser!.id, 'ai_bash.updated', 'ai_bash_settings', '1', req.ip ?? '', { enabled });
  res.json(bashConfig());
});
router.get('/ai-provider', requireRole('admin', 'operator'), (req, res): void => {
  if (!sessionOnly(req, res)) return;
  res.json(viewConfig(req.authUser!.id));
});
router.get('/ai-provider/keys', requireRole('admin', 'operator'), (req, res): void => {
  if (!sessionOnly(req, res)) return;
  res.json(viewConfig(req.authUser!.id));
});

router.post('/ai-provider/keys', requireRole('admin', 'operator'), requireCsrf, async (req, res): Promise<void> => {
  if (!sessionOnly(req, res)) return;
  await resolve2FA(req, res, 'ai_provider_key.create', () => {
    if (!isAiEncryptionConfigured()) { res.status(503).json({ error: 'AI_UNAVAILABLE', message: 'AI encryption is not configured on the server' }); return; }
    const apiKey = validateApiKey(req.body?.api_key);
    if (!apiKey) { res.status(400).json({ error: 'Bad Request', message: 'A valid DeepSeek API key is required' }); return; }
    try {
      const now = nowSqlDateTime();
      const aad = newKeyAad(req.authUser!.id);
      const created = store.createAiProviderKey(req.authUser!.id, PROVIDER, encryptAiValue(apiKey, aad), maskAiProviderKey(apiKey), aad, req.body?.enabled !== false, now);
      writeAuditLog(req.authUser!.id, 'ai_provider_key.created', 'ai_provider_key', String(created.id), req.ip ?? '', { provider: PROVIDER, enabled: Boolean(created.enabled) });
      res.status(201).json(viewConfig(req.authUser!.id));
    } catch (error) {
      if (error instanceof Error && error.message === 'AI_PROVIDER_KEY_LIMIT') { res.status(400).json({ error: 'AI_PROVIDER_KEY_LIMIT', message: 'A maximum of 10 DeepSeek API keys is allowed' }); return; }
      throw error;
    }
  });
});

router.patch('/ai-provider/keys/:id', requireRole('admin', 'operator'), requireCsrf, async (req, res): Promise<void> => {
  if (!sessionOnly(req, res)) return;
  await resolve2FA(req, res, 'ai_provider_key.update', () => {
    if (!isAiEncryptionConfigured()) { res.status(503).json({ error: 'AI_UNAVAILABLE', message: 'AI encryption is not configured on the server' }); return; }
    const id = parsePositiveId(req.params.id);
    if (!id) { res.status(400).json({ error: 'Bad Request', message: 'Invalid key ID' }); return; }
    const apiKey = req.body?.api_key === undefined ? undefined : validateApiKey(req.body.api_key);
    if (req.body?.api_key !== undefined && !apiKey) { res.status(400).json({ error: 'Bad Request', message: 'A valid DeepSeek API key is required' }); return; }
    if (apiKey && apiKey === req.body?.masked_api_key) { res.status(400).json({ error: 'Bad Request', message: 'Enter the full replacement key' }); return; }
    const now = nowSqlDateTime();
    const aad = apiKey ? newKeyAad(req.authUser!.id) : undefined;
    const updated = store.updateAiProviderKey(id, req.authUser!.id, PROVIDER, {
      encryptedApiKey: apiKey && aad ? encryptAiValue(apiKey, aad) : undefined,
      maskedApiKey: apiKey ? maskAiProviderKey(apiKey) : undefined,
      encryptionAad: aad,
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
      now,
    });
    if (!updated) { res.status(404).json({ error: 'Not Found', message: 'Provider key not found' }); return; }
    writeAuditLog(req.authUser!.id, 'ai_provider_key.updated', 'ai_provider_key', String(id), req.ip ?? '', { provider: PROVIDER, replaced: Boolean(apiKey) });
    res.json(viewConfig(req.authUser!.id));
  });
});

router.delete('/ai-provider/keys/:id', requireRole('admin', 'operator'), requireCsrf, async (req, res): Promise<void> => {
  if (!sessionOnly(req, res)) return;
  await resolve2FA(req, res, 'ai_provider_key.delete', () => {
    const id = parsePositiveId(req.params.id);
    if (!id) { res.status(400).json({ error: 'Bad Request', message: 'Invalid key ID' }); return; }
    const deleted = store.deleteAiProviderKey(id, req.authUser!.id, PROVIDER);
    if (!deleted) { res.status(404).json({ error: 'Not Found', message: 'Provider key not found' }); return; }
    writeAuditLog(req.authUser!.id, 'ai_provider_key.deleted', 'ai_provider_key', String(id), req.ip ?? '', { provider: PROVIDER });
    res.json({ success: true, ...viewConfig(req.authUser!.id) });
  });
});

router.put('/ai-provider', requireRole('admin', 'operator'), requireCsrf, async (req, res): Promise<void> => {
  if (!sessionOnly(req, res)) return;
  await resolve2FA(req, res, 'ai_provider.update', () => {
    if (!isAiEncryptionConfigured()) { res.status(503).json({ error: 'AI_UNAVAILABLE', message: 'AI encryption is not configured on the server' }); return; }
    const apiKey = validateApiKey(req.body?.api_key);
    if (req.body?.provider !== PROVIDER || !apiKey) { res.status(400).json({ error: 'Bad Request', message: 'A valid DeepSeek API key is required' }); return; }
    const current = store.listAiProviderKeys(req.authUser!.id, PROVIDER)[0];
    const now = nowSqlDateTime();
    const aad = newKeyAad(req.authUser!.id);
    if (current) {
      store.updateAiProviderKey(current.id, req.authUser!.id, PROVIDER, { encryptedApiKey: encryptAiValue(apiKey, aad), maskedApiKey: maskAiProviderKey(apiKey), encryptionAad: aad, enabled: req.body?.enabled !== false, now });
    } else {
      try { store.createAiProviderKey(req.authUser!.id, PROVIDER, encryptAiValue(apiKey, aad), maskAiProviderKey(apiKey), aad, req.body?.enabled !== false, now); }
      catch (error) { if (error instanceof Error && error.message === 'AI_PROVIDER_KEY_LIMIT') { res.status(400).json({ error: 'AI_PROVIDER_KEY_LIMIT', message: 'A maximum of 10 DeepSeek API keys is allowed' }); return; } throw error; }
    }
    res.json(viewConfig(req.authUser!.id));
  });
});

router.delete('/ai-provider', requireRole('admin', 'operator'), requireCsrf, async (req, res): Promise<void> => {
  if (!sessionOnly(req, res)) return;
  await resolve2FA(req, res, 'ai_provider.delete', () => {
    const current = store.listAiProviderKeys(req.authUser!.id, PROVIDER)[0];
    const deleted = current ? store.deleteAiProviderKey(current.id, req.authUser!.id, PROVIDER) : false;
    res.json({ success: true, deleted, ...viewConfig(req.authUser!.id) });
  });
});

export interface ProviderKeyCandidate {
  id: number;
  key: string;
}

export function readConfiguredProviderKeys(userId: number, now: string): ProviderKeyCandidate[] {
  return store.listSelectableAiProviderKeys(userId, PROVIDER, now).map(row => ({
    id: row.id,
    key: decryptAiValue(row.encrypted_api_key, row.encryption_aad),
  }));
}

export default router;
