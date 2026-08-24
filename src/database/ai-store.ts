import { getDb } from './connection.js';
import type {
  AiConversation,
  AiConversationView,
  AiMessage,
  AiMessageRole,
  AiProvider,
  AiProviderKey,
  AiProviderKeyView,
} from '../model.js';
import { patchAiAgentEventsMessageId } from './ai-agent-store.js';

export function listAiProviderKeys(userId: number, provider: AiProvider): AiProviderKeyView[] {
  return getDb().prepare(`
    SELECT id, provider, masked_api_key, enabled, failure_count, last_failure_code,
           last_failure_at, retry_after_at, last_used_at, created_at, updated_at
    FROM ai_provider_keys WHERE user_id = ? AND provider = ? ORDER BY last_used_at IS NOT NULL, last_used_at, id
  `).all(userId, provider).map((row: any) => ({
    ...row,
    enabled: Boolean(row.enabled),
  })) as AiProviderKeyView[];
}

export function countAiProviderKeys(userId: number, provider: AiProvider): number {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM ai_provider_keys WHERE user_id = ? AND provider = ?').get(userId, provider) as { count: number }).count;
}

export function getAiProviderKey(id: number, userId: number, provider: AiProvider): AiProviderKey | undefined {
  return getDb().prepare('SELECT * FROM ai_provider_keys WHERE id = ? AND user_id = ? AND provider = ?').get(id, userId, provider) as AiProviderKey | undefined;
}

export function createAiProviderKey(userId: number, provider: AiProvider, encryptedApiKey: string, maskedApiKey: string, encryptionAad: string, enabled: boolean, now: string): AiProviderKey {
  const db = getDb();
  const transaction = db.transaction(() => {
    const count = (db.prepare('SELECT COUNT(*) AS count FROM ai_provider_keys WHERE user_id = ? AND provider = ?').get(userId, provider) as { count: number }).count;
    if (count >= 10) throw new Error('AI_PROVIDER_KEY_LIMIT');
    const result = db.prepare(`INSERT INTO ai_provider_keys (user_id, provider, encrypted_api_key, masked_api_key, encryption_aad, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, provider, encryptedApiKey, maskedApiKey, encryptionAad, enabled ? 1 : 0, now, now);
    return Number(result.lastInsertRowid);
  });
  return getAiProviderKey(transaction(), userId, provider)!;
}

export function updateAiProviderKey(id: number, userId: number, provider: AiProvider, fields: { encryptedApiKey?: string; maskedApiKey?: string; encryptionAad?: string; enabled?: boolean; now: string }): boolean {
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [fields.now];
  if (fields.encryptedApiKey !== undefined) { sets.push('encrypted_api_key = ?', 'masked_api_key = ?', 'encryption_aad = ?', 'failure_count = 0', 'last_failure_code = NULL', 'last_failure_at = NULL', 'retry_after_at = NULL'); values.push(fields.encryptedApiKey, fields.maskedApiKey, fields.encryptionAad); }
  if (fields.enabled !== undefined) { sets.push('enabled = ?'); values.push(fields.enabled ? 1 : 0); }
  values.push(id, userId, provider);
  return getDb().prepare(`UPDATE ai_provider_keys SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND provider = ?`).run(...values).changes > 0;
}

export function deleteAiProviderKey(id: number, userId: number, provider: AiProvider): boolean {
  return getDb().prepare('DELETE FROM ai_provider_keys WHERE id = ? AND user_id = ? AND provider = ?').run(id, userId, provider).changes > 0;
}

export function listSelectableAiProviderKeys(userId: number, provider: AiProvider, now: string): AiProviderKey[] {
  return getDb().prepare(`SELECT * FROM ai_provider_keys WHERE user_id = ? AND provider = ? AND enabled = 1 AND (retry_after_at IS NULL OR retry_after_at <= ?) ORDER BY last_used_at IS NOT NULL, last_used_at, id`).all(userId, provider, now) as AiProviderKey[];
}

export function recordAiProviderUse(id: number, userId: number, provider: AiProvider, now: string): void {
  getDb().prepare('UPDATE ai_provider_keys SET last_used_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND provider = ?').run(now, now, id, userId, provider);
}

export function recordAiProviderSuccess(id: number, userId: number, provider: AiProvider, now: string): void {
  getDb().prepare('UPDATE ai_provider_keys SET failure_count = 0, last_failure_code = NULL, last_failure_at = NULL, retry_after_at = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND provider = ?').run(now, id, userId, provider);
}

export function recordAiProviderFailure(id: number, userId: number, provider: AiProvider, code: string, retryAfterAt: string | null, now: string): void {
  const authFailure = code === 'AI_PROVIDER_AUTH' ? 1 : 0;
  const quotaRetryAt = code === 'AI_PROVIDER_QUOTA' && retryAfterAt === null ? now : retryAfterAt;
  getDb().prepare('UPDATE ai_provider_keys SET enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END, failure_count = failure_count + 1, last_failure_code = ?, last_failure_at = ?, retry_after_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND provider = ?').run(authFailure, code, now, quotaRetryAt, now, id, userId, provider);
}

export function countAiConversations(userId: number, now: string): number {
  return (getDb().prepare(
    'SELECT COUNT(*) AS count FROM ai_conversations WHERE owner_user_id = ? AND expires_at > ?'
  ).get(userId, now) as { count: number }).count;
}

export function listAiConversations(userId: number, now: string): AiConversationView[] {
  return getDb().prepare(`
    SELECT c.id, c.group_id, c.report_id, c.title, c.created_at, c.updated_at, c.expires_at,
           COUNT(m.id) AS message_count
    FROM ai_conversations c
    LEFT JOIN ai_messages m ON m.conversation_id = c.id
    WHERE c.owner_user_id = ? AND c.expires_at > ?
    GROUP BY c.id
    ORDER BY c.updated_at DESC, c.id DESC
  `).all(userId, now) as AiConversationView[];
}

export function createAiConversation(
  ownerUserId: number,
  groupId: number | null,
  reportId: number | null,
  title: string,
  now: string,
  expiresAt: string,
): AiConversation {
  const result = getDb().prepare(`
    INSERT INTO ai_conversations (owner_user_id, group_id, report_id, title, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ownerUserId, groupId, reportId, title, now, now, expiresAt);
  return getDb().prepare('SELECT * FROM ai_conversations WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as AiConversation;
}

export function getAiConversationForOwner(
  id: number,
  ownerUserId: number,
  now: string,
): AiConversation | undefined {
  return getDb().prepare(`
    SELECT * FROM ai_conversations
    WHERE id = ? AND owner_user_id = ? AND expires_at > ?
  `).get(id, ownerUserId, now) as AiConversation | undefined;
}
export function deleteAiConversation(id: number, ownerUserId: number): boolean {
  return getDb().prepare(
    'DELETE FROM ai_conversations WHERE id = ? AND owner_user_id = ?'
  ).run(id, ownerUserId).changes > 0;
}

export function updateAiConversationBinding(
  id: number,
  ownerUserId: number,
  groupId: number | null,
  reportId: number | null,
  title: string,
  now: string,
  expiresAt: string,
): boolean {
  return getDb().prepare(`
    UPDATE ai_conversations
    SET group_id = ?, report_id = ?, title = ?, updated_at = ?, expires_at = ?
    WHERE id = ? AND owner_user_id = ? AND expires_at > ?
  `).run(groupId, reportId, title, now, expiresAt, id, ownerUserId, now).changes > 0;
}

export function touchAiConversation(id: number, ownerUserId: number, now: string, expiresAt: string): boolean {
  return getDb().prepare(`
    UPDATE ai_conversations SET updated_at = ?, expires_at = ?
    WHERE id = ? AND owner_user_id = ? AND expires_at > ?
  `).run(now, expiresAt, id, ownerUserId, now).changes > 0;
}

export function countAiMessages(id: number, ownerUserId: number): number {
  return (getDb().prepare(`
    SELECT COUNT(*) AS count FROM ai_messages m
    JOIN ai_conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ? AND c.owner_user_id = ?
  `).get(id, ownerUserId) as { count: number }).count;
}

export function listAiMessages(id: number, ownerUserId: number, limit: number): AiMessage[] {
  return getDb().prepare(`
    SELECT m.* FROM ai_messages m
    JOIN ai_conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ? AND c.owner_user_id = ?
    ORDER BY m.id DESC LIMIT ?
  `).all(id, ownerUserId, limit).reverse() as AiMessage[];
}

export function insertAiMessage(
  conversationId: number,
  ownerUserId: number,
  role: AiMessageRole,
  encryptedContent: string,
  encryptedReasoning: string | null,
  now: string,
): AiMessage {
  const result = getDb().prepare(`
    INSERT INTO ai_messages (conversation_id, role, encrypted_content, encrypted_reasoning, created_at)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM ai_conversations WHERE id = ? AND owner_user_id = ?
    )
  `).run(conversationId, role, encryptedContent, encryptedReasoning, now, conversationId, ownerUserId);
  if (result.changes === 0) throw new Error('Conversation not found');
  return getDb().prepare('SELECT * FROM ai_messages WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as AiMessage;
}

export function insertAiMessageExchange(
  conversationId: number,
  ownerUserId: number,
  encryptedUserContent: string,
  encryptedAssistantContent: string,
  encryptedAssistantReasoning: string | null,
  now: string,
  expiresAt: string,
  maxMessages: number,
  eventIds: number[] = [],
): AiMessage {
  return getDb().transaction(() => {
    const count = countAiMessages(conversationId, ownerUserId);
    if (maxMessages > 0 && count + 2 > maxMessages) throw new Error('AI_MESSAGE_LIMIT');
    insertAiMessage(conversationId, ownerUserId, 'user', encryptedUserContent, null, now);
    const assistant = insertAiMessage(conversationId, ownerUserId, 'assistant', encryptedAssistantContent, encryptedAssistantReasoning, now);
    touchAiConversation(conversationId, ownerUserId, now, expiresAt);
    patchAiAgentEventsMessageId(conversationId, ownerUserId, eventIds, assistant.id);
    return assistant;
  })();
}

export function purgeExpiredAiConversations(now: string): number {
  return getDb().prepare('DELETE FROM ai_conversations WHERE expires_at <= ?').run(now).changes;
}
