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

// ── Learnable code-analysis knowledge base ──

export interface AnalysisKnowledgeRow {
  id: number;
  exception_type: string;
  language: string;
  project_id: number | null;
  kind: 'suggestion' | 'root_cause' | 'hint' | 'quote';
  title: string;
  description: string;
  payload_json: string;
  confidence: number;
  source_review_id: number | null;
  created_at: string;
  updated_at: string;
}

export function upsertAnalysisKnowledge(
  exceptionType: string,
  language: string,
  kind: AnalysisKnowledgeRow['kind'],
  title: string,
  description: string,
  payloadJson: string,
  confidence: number,
  sourceReviewId: number | null,
  now: string,
  projectId: number | null = null,
): AnalysisKnowledgeRow {
  getDb().transaction(() => {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM analysis_knowledge WHERE exception_type = ? AND language = ? AND project_id IS ? AND kind = ? AND title = ?')
      .get(exceptionType, language, projectId, kind, title) as { id: number } | undefined;
    if (existing) {
      db.prepare(`UPDATE analysis_knowledge
        SET description = ?, payload_json = ?, confidence = ?, source_review_id = ?, updated_at = ?
        WHERE id = ?`).run(description, payloadJson, confidence, sourceReviewId, now, existing.id);
    } else {
      db.prepare(`INSERT INTO analysis_knowledge
        (exception_type, language, project_id, kind, title, description, payload_json, confidence, source_review_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        exceptionType, language, projectId, kind, title, description, payloadJson, confidence, sourceReviewId, now, now,
      );
    }
  })();
  return getDb().prepare('SELECT * FROM analysis_knowledge WHERE exception_type = ? AND language = ? AND project_id IS ? AND kind = ? AND title = ?')
    .get(exceptionType, language, projectId, kind, title) as AnalysisKnowledgeRow;
}

export function listAnalysisKnowledge(exceptionType: string, language: string, projectId: number | null = null): AnalysisKnowledgeRow[] {
  return getDb().prepare(`
    SELECT * FROM analysis_knowledge
    WHERE exception_type = ? AND (language = '' OR language = ?) AND (project_id IS NULL OR project_id IS ?)
    ORDER BY confidence DESC, id DESC
  `).all(exceptionType, language, projectId) as AnalysisKnowledgeRow[];
}

// ── Code-analysis self-improvement jobs ──

export interface AnalysisLearningJobRow {
  id: number;
  user_id: number;
  container_id: number | null;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  total_count: number;
  processed_count: number;
  knowledge_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function createAnalysisLearningJob(
  userId: number,
  containerId: number | null,
  model: string,
  totalCount: number,
  now: string,
): AnalysisLearningJobRow {
  const result = getDb().prepare(`
    INSERT INTO analysis_learning_jobs (user_id, container_id, model, status, total_count, created_at, updated_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?)
  `).run(userId, containerId, model, totalCount, now, now);
  return getDb().prepare('SELECT * FROM analysis_learning_jobs WHERE id = ?').get(Number(result.lastInsertRowid)) as AnalysisLearningJobRow;
}

export function getAnalysisLearningJob(id: number): AnalysisLearningJobRow | undefined {
  return getDb().prepare('SELECT * FROM analysis_learning_jobs WHERE id = ?').get(id) as AnalysisLearningJobRow | undefined;
}

export function getRunningAnalysisLearningJob(): AnalysisLearningJobRow | undefined {
  return getDb().prepare("SELECT * FROM analysis_learning_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1").get() as AnalysisLearningJobRow | undefined;
}

export function getLatestAnalysisLearningJob(): AnalysisLearningJobRow | undefined {
  return getDb().prepare('SELECT * FROM analysis_learning_jobs ORDER BY id DESC LIMIT 1').get() as AnalysisLearningJobRow | undefined;
}

export function updateAnalysisLearningJob(id: number, fields: { status?: AnalysisLearningJobRow['status']; processedCount?: number; knowledgeCount?: number; errorMessage?: string | null; now: string }): boolean {
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [fields.now];
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.processedCount !== undefined) { sets.push('processed_count = ?'); values.push(fields.processedCount); }
  if (fields.knowledgeCount !== undefined) { sets.push('knowledge_count = ?'); values.push(fields.knowledgeCount); }
  if (fields.errorMessage !== undefined) { sets.push('error_message = ?'); values.push(fields.errorMessage); }
  values.push(id);
  return getDb().prepare(`UPDATE analysis_learning_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes > 0;
}

// ── Per-crash log lines for self-improvement jobs ──

export interface AnalysisLearningJobLogRow {
  id: number;
  job_id: number;
  report_id: number | null;
  attempt: number | null;
  message: string;
  created_at: string;
}

export function insertAnalysisLearningJobLog(jobId: number, reportId: number | null, attempt: number | null, message: string, now: string): void {
  getDb().prepare(`
    INSERT INTO analysis_learning_job_logs (job_id, report_id, attempt, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(jobId, reportId, attempt, message.slice(0, 2000), now);
}

export function listAnalysisLearningJobLogs(jobId: number, limit = 200): AnalysisLearningJobLogRow[] {
  return getDb().prepare(`
    SELECT * FROM analysis_learning_job_logs
    WHERE job_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(jobId, limit).reverse() as AnalysisLearningJobLogRow[];
}

// ── Code-analysis learning: reviews, fine-tune jobs, user default model ──

export interface AnalysisReviewRow {
  id: number;
  report_id: number;
  user_id: number;
  model: string;
  correct: number;
  notes: string;
  corrections_json: string;
  suggestions_json: string;
  context_json: string;
  exception_type: string;
  created_at: string;
}

export function insertAnalysisReview(
  reportId: number,
  userId: number,
  model: string,
  correct: boolean,
  notes: string,
  correctionsJson: string,
  suggestionsJson: string,
  exceptionType: string,
  now: string,
): AnalysisReviewRow {
  const result = getDb().prepare(`
    INSERT INTO analysis_reviews (report_id, user_id, model, correct, notes, corrections_json, suggestions_json, context_json, exception_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)
  `).run(reportId, userId, model, correct ? 1 : 0, notes, correctionsJson, suggestionsJson, exceptionType, now);
  return getDb().prepare('SELECT * FROM analysis_reviews WHERE id = ?').get(Number(result.lastInsertRowid)) as AnalysisReviewRow;
}

export function getLatestAnalysisReview(reportId: number): AnalysisReviewRow | undefined {
  return getDb().prepare('SELECT * FROM analysis_reviews WHERE report_id = ? ORDER BY id DESC LIMIT 1').get(reportId) as AnalysisReviewRow | undefined;
}

export function setUserDefaultAiModel(userId: number, model: string): void {
  getDb().prepare('UPDATE users SET default_ai_model = ? WHERE id = ?').run(model, userId);
}

export function getUserDefaultAiModel(userId: number): string {
  return (getDb().prepare('SELECT default_ai_model FROM users WHERE id = ?').get(userId) as { default_ai_model: string } | undefined)?.default_ai_model ?? '';
}
