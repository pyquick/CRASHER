import { Router, type Request, type Response } from 'express';
import * as auth from '../auth.js';
import { sendResetApprovalEmail, sendVerificationEmail } from '../notification/service.js';
import { rateLimit, requireApiAuth, requireCsrf, requireRole } from '../middleware.js';
import { maskEmail } from './auth-common.js';

const router = Router();

// ── Password Reset Routes ──

/**
 * POST /api/v1/auth/forgot-password
 * Initiate the forgot-password flow. Rate-limited to prevent enumeration.
 * Admin accounts with TOTP get self-service flow (TOTP + email verification).
 * Operator/viewer accounts create an admin-approval request.
 */
router.post('/forgot-password', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `forgot:${req.ip}`,
}), (req: Request, res: Response): void => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username || username.length > 64) {
    res.json({ success: true, message: 'If the account exists, your request has been submitted.' });
    return;
  }
  const user = auth.lookupUserByUsername(username);
  if (user && user.role === 'admin' && user.totp_enabled) {
    auth.writeAuditLog(user.id, 'password_reset.self_requested', 'user', String(user.id), req.ip ?? '', {});
    res.json({ success: true, requires_totp: true, username: user.username });
    return;
  }
  // Non-admin: create an approval request, notify admins
  const result = auth.createResetRequest(username);
  auth.writeAuditLog(null, 'password_reset.requested', 'user', username.substring(0, 64), req.ip ?? '', { success: !!result });
  if (result) {
    console.log(`[reset] APPROVAL-TOKEN for ${result.username}: ${result.token} (valid 24h)`);
    // Notify admins via email
    for (const adminEmail of result.adminEmails) {
      sendResetApprovalEmail(adminEmail, result.token, result.username).catch(() => {});
    }
  }
  res.json({ success: true, message: 'If the account exists, administrators have been notified and will review your request.' });
});

/**
 * POST /api/v1/auth/forgot-password/totp
 * Step 2 of admin self-reset: verify TOTP and send email verification code.
 */
router.post('/forgot-password/totp', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  key: req => `forgot-totp:${req.ip}`,
}), async (req: Request, res: Response): Promise<void> => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const totpCode = typeof req.body?.totp_code === 'string' ? req.body.totp_code.replace(/\s/g, '') : '';
  if (!username || !totpCode) {
    res.status(400).json({ error: 'Bad Request', message: 'Username and TOTP code are required' });
    return;
  }
  const user = auth.lookupUserByUsername(username);
  if (!user || user.role !== 'admin' || !user.totp_enabled) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid request' });
    return;
  }
  if (!auth.verifyTotp(user.id, totpCode)) {
    auth.writeAuditLog(user.id, 'password_reset.self_totp_failed', 'user', String(user.id), req.ip ?? '', {});
    res.status(400).json({ error: 'Bad Request', message: 'Invalid 2FA code' });
    return;
  }
  const session = auth.createAdminResetSession(user.id);
  if (!session) {
    res.status(400).json({ error: 'Bad Request', message: 'No verified email address found. Contact another admin for help.' });
    return;
  }
  auth.writeAuditLog(user.id, 'password_reset.self_totp_ok', 'user', String(user.id), req.ip ?? '', {});
  sendVerificationEmail(session.email, session.emailCode).catch(() => {});
  console.log(`[reset] ADMIN-SELF-RESET code for ${user.username} (${session.email}): ${session.emailCode}`);
  res.json({ success: true, temp_token: session.tempToken, message: 'Verification code sent to your primary email.', email_hint: maskEmail(session.email) });
});

/**
 * POST /api/v1/auth/forgot-password/verify-email
 * Verify the email code for an admin self-reset session (does NOT consume it).
 */
router.post('/forgot-password/verify-email', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `forgot-verify-email:${req.ip}`,
}), (req: Request, res: Response): void => {
  const tempToken = typeof req.body?.temp_token === 'string' ? req.body.temp_token.trim() : '';
  const emailCode = typeof req.body?.email_code === 'string' ? req.body.email_code.replace(/\s/g, '') : '';
  if (!tempToken || !emailCode) {
    res.status(400).json({ error: 'Bad Request', message: 'Temp token and email code are required' });
    return;
  }
  if (auth.verifyAdminResetEmailCode(tempToken, emailCode)) {
    res.json({ success: true, valid: true });
  } else {
    res.json({ success: true, valid: false, message: 'Invalid email code' });
  }
});

/**
 * GET /api/v1/auth/reset-request/:token
 * Get reset request info (for admin to review before approving).
 */
router.get('/reset-request/:token', requireApiAuth, requireRole('admin'), (req: Request, res: Response): void => {
  const info = auth.getResetRequest(String(req.params.token));
  if (!info) {
    res.status(404).json({ error: 'Not Found', message: 'Reset request not found, already handled, or expired.' });
    return;
  }
  res.json({ request: info });
});

/**
 * POST /api/v1/auth/reset-request/:token/approve
 * Admin approves a reset request. Auto-generates a password and returns it.
 */
router.post('/reset-request/:token/approve', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  const token = String(req.params.token);
  try {
    const result = auth.approveResetRequest(token, req.authUser!.id);
    if (!result) {
      res.status(400).json({ error: 'Bad Request', message: 'Reset request not found, already handled, or expired.' });
      return;
    }
    auth.writeAuditLog(req.authUser!.id, 'password_reset.approved', 'user', result.username, req.ip ?? '', {});
    console.log(`[reset] APPROVED by ${req.authUser!.username} for ${result.username}: ${result.newPassword}`);
    res.json({ success: true, username: result.username, new_password: result.newPassword });
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

export default router;
