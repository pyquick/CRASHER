import { getDb } from './connection.js';
import type { AiAgentEvent } from '../model.js';

// Agent activity log for AI conversations. Payloads are stored encrypted by
// the caller (src/ai/crypto.ts) with an owner-scoped AAD, matching how
// ai_messages content is protected.

export function insertAiAgentEvent(
  conversationId: number,
  ownerUserId: number,
  kind: AiAgentEvent['kind'],
  name: string,
  status: AiAgentEvent['status'],
  groupId: number | null,
  encryptedPayload: string,
  now: string,
): number {
  const result = getDb().prepare(`
    INSERT INTO ai_agent_events (conversation_id, owner_user_id, kind, name, status, group_id, encrypted_payload, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM ai_conversations WHERE id = ? AND owner_user_id = ?
    )
  `).run(conversationId, ownerUserId, kind, name, status, groupId, encryptedPayload, now, conversationId, ownerUserId);
  if (result.changes === 0) throw new Error('Conversation not found');
  return Number(result.lastInsertRowid);
}

export function listAiAgentEvents(conversationId: number, ownerUserId: number): AiAgentEvent[] {
  return getDb().prepare(`
    SELECT e.* FROM ai_agent_events e
    JOIN ai_conversations c ON c.id = e.conversation_id
    WHERE e.conversation_id = ? AND c.owner_user_id = ?
    ORDER BY e.id
  `).all(conversationId, ownerUserId) as AiAgentEvent[];
}

export function deleteAiAgentEvents(conversationId: number, ownerUserId: number, eventIds: number[]): void {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => '?').join(', ');
  getDb().prepare(`
    DELETE FROM ai_agent_events
    WHERE conversation_id = ? AND owner_user_id = ? AND id IN (${placeholders})
  `).run(conversationId, ownerUserId, ...eventIds);
}
// Attaches a turn's events to its persisted assistant message (back-patched
// once the exchange is inserted, so replay can group events per message).
export function patchAiAgentEventsMessageId(
  conversationId: number,
  ownerUserId: number,
  eventIds: number[],
  messageId: number,
): void {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => '?').join(', ');
  getDb().prepare(`
    UPDATE ai_agent_events SET message_id = ?
    WHERE message_id IS NULL AND conversation_id = ? AND owner_user_id = ?
      AND id IN (${placeholders})
  `).run(messageId, conversationId, ownerUserId, ...eventIds);
}
