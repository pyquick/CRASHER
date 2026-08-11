import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import * as store from '../store.js';
import type { PlayerFeedbackInput } from '../model.js';
import { createAttachmentUpload, cleanupUploads, getUploadedFiles, getClientIp, getContainerId, extractFeedbackFormFields } from '../shared/upload.js';

const router = Router();
const upload = createAttachmentUpload(10);

/**
 * POST /player-feedback
 * Public endpoint for a player-authored issue, suggestion, or other feedback.
 * Accepts application/json or multipart/form-data with an optional attachments[] field.
 */
router.post('/player-feedback', upload.array('attachments', 10), (req: Request, res: Response): void => {
  try {
    const input = extractInput(req);
    const error = validateInput(input);
    if (error) {
      cleanupUploads(req);
      res.status(400).json({ error: 'Bad Request', message: error });
      return;
    }

    const now = new Date().toISOString();
    const clientIp = getClientIp(req);
    const containerId = getContainerId(req);
    const feedback = store.createFeedback(input, clientIp, now, containerId);

    const files = getUploadedFiles(req);
    const attachments = files.map(file =>
      store.createFeedbackAttachment(feedback.id, file.originalname, file.mimetype, file.size, file.path)
    );

    res.status(201).json({
      id: feedback.id,
      status: feedback.status,
      attachments: attachments.map(attachment => ({
        id: attachment.id,
        filename: attachment.filename,
        file_size: attachment.file_size,
      })),
    });
  } catch (err: any) {
    cleanupUploads(req);
    console.error('Error ingesting player feedback:', err);
    res.status(500).json({ error: 'Internal Server Error', message: 'Could not ingest player feedback' });
  }
});

function extractInput(req: Request): PlayerFeedbackInput {
  const body = req.body ?? {};
  if (body.feedback) {
    return typeof body.feedback === 'string'
      ? JSON.parse(body.feedback) as PlayerFeedbackInput
      : body.feedback as PlayerFeedbackInput;
  }
  return extractFeedbackFormFields(body) as unknown as PlayerFeedbackInput;
}

function validateInput(input: PlayerFeedbackInput): string | null {
  if (!input.title) return 'title is required';
  if (!input.description) return 'description is required';
  if (input.title.length > 200) return 'title must be at most 200 characters';
  if (input.description.length > config.maxLogSize) {
    return `description must be at most ${config.maxLogSize} characters`;
  }
  if (input.category && !['bug', 'suggestion', 'other'].includes(input.category)) {
    return 'category must be: bug, suggestion, or other';
  }
  if (input.severity && !['low', 'normal', 'high', 'critical'].includes(input.severity)) {
    return 'severity must be: low, normal, high, or critical';
  }
  return null;
}

export default router;
