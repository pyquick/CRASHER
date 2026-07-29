import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { config } from '../config.js';
import { unlinkSync } from 'fs';
import * as store from '../store.js';
import type { PlayerFeedbackInput } from '../model.js';

const router = Router();

const attachmentStorage = multer.diskStorage({
  destination: config.attachmentsDir,
  filename: (_req, file, cb) => {
    const unique = randomBytes(12).toString('hex');
    const extension = file.originalname.split('.').pop() ?? 'bin';
    cb(null, `${unique}.${extension}`);
  },
});

const upload = multer({
  storage: attachmentStorage,
  limits: { fileSize: config.maxAttachmentSize, files: 10 },
});

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
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const feedback = store.createFeedback(input, clientIp, now);
    const files = ((req as any).files ?? []) as Express.Multer.File[];
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

function cleanupUploads(req: Request): void {
  const files = ((req as any).files ?? []) as Express.Multer.File[];
  for (const file of files) {
    try { unlinkSync(file.path); } catch {}
  }
}

function extractInput(req: Request): PlayerFeedbackInput {
  const body = req.body ?? {};
  if (body.feedback) {
    return typeof body.feedback === 'string'
      ? JSON.parse(body.feedback) as PlayerFeedbackInput
      : body.feedback as PlayerFeedbackInput;
  }

  const text = (key: string) => String(body[key] ?? '').trim();
  const input: PlayerFeedbackInput = {
    title: text('title'),
    description: text('description'),
    category: text('category') as PlayerFeedbackInput['category'],
    severity: text('severity') as PlayerFeedbackInput['severity'],
    player_id: text('player_id') || undefined,
    player_name: text('player_name') || undefined,
    contact: text('contact') || undefined,
    app_version: text('app_version') || undefined,
    platform: text('platform') || undefined,
    device_model: text('device_model') || undefined,
    scene_name: text('scene_name') || undefined,
    client_timestamp: text('client_timestamp') || undefined,
  };

  if (body.custom_data) {
    try {
      input.custom_data = typeof body.custom_data === 'string'
        ? JSON.parse(body.custom_data)
        : body.custom_data;
    } catch {
      input.custom_data = String(body.custom_data);
    }
  }
  return input;
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
