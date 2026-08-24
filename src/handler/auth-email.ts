import { Router, type Request, type Response } from 'express';
import * as auth from '../auth.js';
import { config } from '../config.js';
import { sendVerificationEmail } from '../notification/service.js';
import { requireApiAuth, requireCsrf, requireRole } from '../middleware.js';
import { resolve2FA } from './auth-common.js';

const router = Router();

// ── Email Management Routes ──

// Email verification requires a fully configured SMTP stack; otherwise the
// feature is disabled entirely (the UI hides it as well).
router.use((_req, res, next) => {
  if (!config.emailEnabled) {
    res.status(503).json({ error: 'EMAIL_DISABLED', message: 'Email verification is disabled: SMTP is not fully configured' });
    return;
  }
  next();
});

router.get('/me/emails', requireApiAuth, (req: Request, res: Response): void => {
  res.json({ items: auth.listEmails(req.authUser!.id) });
});

router.post('/me/emails', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!email) {
    res.status(400).json({ error: 'Bad Request', message: 'Email is required' });
    return;
  }
  try {
    const result = auth.addEmail(req.authUser!.id, email);
    const sendResult = await sendVerificationEmail(result.email, result.code);
    auth.writeAuditLog(req.authUser!.id, 'email.added', 'user', String(req.authUser!.id), req.ip ?? '', { email: result.email, smtp: sendResult.ok });
    if (sendResult.ok) {
      res.json({ success: true, email_id: result.id, method: 'smtp', message: `Verification code sent to ${result.email}.` });
    } else {
      res.json({ success: true, email_id: result.id, method: 'console', message: `SMTP unavailable: ${sendResult.error || 'not configured'}. Verification code logged to console.` });
    }
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

router.post('/me/emails/:id/verify', requireApiAuth, requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!Number.isInteger(id) || id <= 0 || !code) {
    res.status(400).json({ error: 'Bad Request', message: 'Email ID and verification code are required' });
    return;
  }
  const result = auth.verifyEmailCode(req.authUser!.id, id, code);
  if (!result) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired verification code' });
    return;
  }
  auth.writeAuditLog(req.authUser!.id, 'email.verified', 'user', String(req.authUser!.id), req.ip ?? '', { email: result.email });
  res.json({ success: true, email: result.email, email_verified: true });
});

router.post('/me/emails/:id/primary', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'email.set_primary', () => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid email ID' });
      return;
    }
    if (!auth.setPrimaryEmail(req.authUser!.id, id)) {
      res.status(400).json({ error: 'Bad Request', message: 'Email not found or not verified. Verify it first.' });
      return;
    }
    res.json({ success: true });
  });
});

router.delete('/me/emails/:id', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'email.delete', () => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid email ID' });
      return;
    }
    try {
      const deleted = auth.deleteEmail(req.authUser!.id, id);
      if (!deleted) {
        res.status(404).json({ error: 'Not Found', message: 'Email not found' });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: 'Bad Request', message: error.message });
    }
  });
});

router.post('/me/emails/:id/resend', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid email ID' });
    return;
  }
  const result = auth.resendVerificationCode(req.authUser!.id, id);
  if (!result) {
    res.status(400).json({ error: 'Bad Request', message: 'Email not found or already verified' });
    return;
  }
  const sendResult = await sendVerificationEmail(result.email, result.code);
  if (sendResult.ok) {
    res.json({ success: true, message: `Verification code sent to ${result.email}.` });
  } else {
    res.json({ success: true, message: `SMTP unavailable: ${sendResult.error || 'not configured'}. Code logged to console.` });
  }
});

// ── Verify-email-on-login preference (admin only) ──

/**
 * PATCH /api/v1/auth/me/verify-email-on-login
 * Toggle the "verify email on every login" identity check.
 * Body: { enabled: boolean }
 */
router.patch('/me/verify-email-on-login', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'Bad Request', message: 'enabled must be a boolean' });
    return;
  }
  try {
    auth.setVerifyEmailOnLogin(req.authUser!.id, enabled);
    auth.writeAuditLog(req.authUser!.id, 'user.verify_email_on_login_changed', 'user', String(req.authUser!.id), req.ip ?? '', { enabled });
    res.json({ success: true, verify_email_on_login: enabled ? 1 : 0 });
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

export default router;
