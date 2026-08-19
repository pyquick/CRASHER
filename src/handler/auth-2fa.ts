import { Router, type Request, type Response } from 'express';
import * as auth from '../auth.js';
import { updateUserTwoFactorMethod } from '../database/auth-store.js';
import { sendSmsCode, sendVerificationEmail } from '../notification/service.js';
import {
  rateLimit,
  requireApiAuth,
  requireCsrf,
  requireRole,
} from '../middleware.js';
import { markMfaVerified, maskEmail, maskPhone, resolve2FA } from './auth-common.js';

const router = Router();

// ── Operation 2FA Routes ──

/**
 * POST /api/v1/auth/2fa/challenge
 * Initiate a 2FA challenge for an account operation.
 * Body: { action, method? }
 */
router.post('/2fa/challenge', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  const action = typeof req.body?.action === 'string' ? req.body.action.trim() : '';
  const method = typeof req.body?.method === 'string' ? req.body.method.trim() : undefined;
  if (!action) {
    res.status(400).json({ error: 'Bad Request', message: 'Action name is required' });
    return;
  }
  const user = req.authUser!;
  const methods = auth.getAvailable2FAMethods(user.id);
  if (methods.length === 0) {
    res.status(400).json({ error: 'Bad Request', message: 'No 2FA methods available. Set up a verified email or phone number first.' });
    return;
  }
  const chosenMethod = method && methods.includes(method) ? method : methods[0];
  const { _2fa_token, ...cleanBody } = req.body || {};
  const session = auth.createOperation2FASession(user.id, chosenMethod, action, cleanBody);
  if (!session) {
    res.status(400).json({ error: 'Bad Request', message: 'Could not create 2FA challenge.' });
    return;
  }

  let emailHint: string | undefined;
  let phoneHint: string | undefined;
  if (chosenMethod === 'email' && session.email && session.code) {
    await sendVerificationEmail(session.email!, session.code!);
    console.log(`[2fa] EMAIL code for ${user.username} (${session.email}): ${session.code}`);
    emailHint = maskEmail(session.email!);
  } else if (chosenMethod === 'sms' && session.phone && session.code) {
    await sendSmsCode(session.phone!, session.code!);
    console.log(`[2fa] SMS code for ${user.username} (${session.phone}): ${session.code}`);
    phoneHint = maskPhone(session.phone!);
  } else if (chosenMethod === 'totp') {
    console.log(`[2fa] TOTP challenge for ${user.username} (action: ${action})`);
  }

  auth.writeAuditLog(user.id, '2fa.challenged', 'user', String(user.id), req.ip ?? '', { method: chosenMethod, action });

  res.json({
    success: true,
    temp_token: session.tempToken,
    method: chosenMethod,
    available_methods: methods,
    email_hint: emailHint,
    phone_hint: phoneHint,
    message: chosenMethod === 'totp'
      ? 'Enter your authenticator code.'
      : `A verification code has been sent to your ${chosenMethod}.`,
  });
});

/**
 * POST /api/v1/auth/2fa/verify
 * Verify a 2FA code for an account operation. Sets MFA session cookie.
 * Body: { temp_token, code }
 */
router.post('/2fa/verify', requireApiAuth, rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  key: req => `2fa-verify:${req.ip}`,
}), (req: Request, res: Response): void => {
  const tempToken = typeof req.body?.temp_token === 'string' ? req.body.temp_token.trim() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
  if (!tempToken || !code) {
    res.status(400).json({ error: 'Bad Request', message: 'Temp token and verification code are required' });
    return;
  }
  const result = auth.consumeOperation2FASession(tempToken, code);
  if (!result || result.userId !== req.authUser!.id) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired verification code' });
    return;
  }

  // Create MFA session (sets cookie so the original request can be retried)
  markMfaVerified(req, res, result.action);
  res.json({ success: true, action: result.action });
});

/**
 * POST /api/v1/auth/2fa/resend
 * Resend the code for an operation 2FA challenge.
 * Body: { temp_token }
 */
router.post('/2fa/resend', requireApiAuth, rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  key: req => `2fa-resend:${req.ip}`,
}), async (req: Request, res: Response): Promise<void> => {
  const tempToken = typeof req.body?.temp_token === 'string' ? req.body.temp_token.trim() : '';
  if (!tempToken) {
    res.status(400).json({ error: 'Bad Request', message: 'Temp token is required' });
    return;
  }
  const result = auth.resendOperation2FACode(tempToken);
  if (!result) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired session. Please start again.' });
    return;
  }
  if (result.email) {
    await sendVerificationEmail(result.email, result.code);
    console.log(`[2fa] EMAIL code (resent) for ${result.email}: ${result.code}`);
  } else if (result.phone) {
    await sendSmsCode(result.phone, result.code);
    console.log(`[2fa] SMS code (resent) for ${result.phone}: ${result.code}`);
  }
  res.json({
    success: true,
    email_hint: result.email ? maskEmail(result.email) : undefined,
    phone_hint: result.phone ? maskPhone(result.phone) : undefined,
    message: 'A new verification code has been sent.',
  });
});

/**
 * PATCH /api/v1/auth/me/two-factor-method
 * Change the user's preferred 2FA method for account operations.
 * Body: { method: 'totp' | 'email' | 'sms' | 'none' }
 */
router.patch('/me/two-factor-method', requireApiAuth, requireCsrf, (req: Request, res: Response): void => {
  const method = typeof req.body?.method === 'string' ? req.body.method.trim() : '';
  if (!['totp', 'email', 'sms', 'none'].includes(method)) {
    res.status(400).json({ error: 'Bad Request', message: 'Method must be totp, email, sms, or none' });
    return;
  }
  const user = req.authUser!;
  const methods = auth.getAvailable2FAMethods(user.id);
  if (method !== 'none' && method !== 'totp' && !methods.includes(method)) {
    res.status(400).json({ error: 'Bad Request', message: `Cannot set method to '${method}' without a verified ${method === 'sms' ? 'phone number' : 'email address'}` });
    return;
  }
  if (method === 'totp') {
    const full = auth.getUserById(user.id);
    if (!full?.totp_enabled) {
      res.status(400).json({ error: 'Bad Request', message: 'TOTP is not enabled for your account. Enable it first.' });
      return;
    }
  }
  updateUserTwoFactorMethod(user.id, method);
  auth.writeAuditLog(user.id, 'user.2fa_method_changed', 'user', String(user.id), req.ip ?? '', { method });
  res.json({ success: true, two_factor_method: method });
});

// ── TOTP Routes (admin only) ──

router.get('/me/totp/setup', requireApiAuth, requireRole('admin'), (req: Request, res: Response): void => {
  const full = auth.getUserById(req.authUser!.id);
  if (full?.totp_enabled) {
    res.status(400).json({ error: 'Bad Request', message: '2FA is already enabled. Disable it first to set up a new one.' });
    return;
  }
  const data = auth.generateTotpSecret(req.authUser!.username);
  const [secret, qrUri] = data.split('\n');
  res.json({ secret, qr_uri: qrUri });
});

router.post('/me/totp/enable', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
  const secret = typeof req.body?.secret === 'string' ? req.body.secret : '';
  if (!code || !secret) {
    res.status(400).json({ error: 'Bad Request', message: 'TOTP code and secret are required' });
    return;
  }
  if (!auth.enableTotp(req.authUser!.id, code, secret)) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid TOTP code' });
    return;
  }
  auth.writeAuditLog(req.authUser!.id, 'totp.enabled', 'user', String(req.authUser!.id), req.ip ?? '', {});
  res.json({ success: true });
});

router.post('/me/totp/disable', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
  if (!code) {
    res.status(400).json({ error: 'Bad Request', message: 'TOTP code is required' });
    return;
  }
  if (!auth.disableTotp(req.authUser!.id, code)) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid TOTP code or 2FA not enabled' });
    return;
  }
  auth.writeAuditLog(req.authUser!.id, 'totp.disabled', 'user', String(req.authUser!.id), req.ip ?? '', {});
  res.json({ success: true });
});

// ── Phone Management Routes ──

router.get('/me/phones', requireApiAuth, (req: Request, res: Response): void => {
  res.json({ items: auth.listPhones(req.authUser!.id) });
});

router.post('/me/phones', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  if (!phone) {
    res.status(400).json({ error: 'Bad Request', message: 'Phone number is required' });
    return;
  }
  try {
    const result = auth.addPhone(req.authUser!.id, phone);
    const sendResult = await sendSmsCode(result.phone, result.code);
    auth.writeAuditLog(req.authUser!.id, 'phone.added', 'user', String(req.authUser!.id), req.ip ?? '', { phone: result.phone });
    if (sendResult.ok) {
      res.json({ success: true, method: 'sms', message: `Verification code sent to ${maskPhone(result.phone)}.` });
    } else {
      console.log(`[phone] Verification code for ${result.phone}: ${result.code}`);
      res.json({ success: true, method: 'console', message: `SMS unavailable: ${sendResult.error || 'not configured'}. Verification code logged to console.` });
    }
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

router.post('/me/phones/:id/verify', requireApiAuth, requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!Number.isInteger(id) || id <= 0 || !code) {
    res.status(400).json({ error: 'Bad Request', message: 'Phone ID and verification code are required' });
    return;
  }
  const result = auth.verifyPhoneCode(req.authUser!.id, id, code);
  if (!result) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired verification code' });
    return;
  }
  auth.writeAuditLog(req.authUser!.id, 'phone.verified', 'user', String(req.authUser!.id), req.ip ?? '', { phone: result.phone });
  res.json({ success: true, phone: result.phone, phone_verified: true });
});

router.post('/me/phones/:id/primary', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'phone.set_primary', () => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid phone ID' });
      return;
    }
    if (!auth.setPrimaryPhone(req.authUser!.id, id)) {
      res.status(400).json({ error: 'Bad Request', message: 'Phone not found or not verified. Verify it first.' });
      return;
    }
    res.json({ success: true });
  });
});

router.delete('/me/phones/:id', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'phone.delete', () => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid phone ID' });
      return;
    }
    try {
      const deleted = auth.deletePhone(req.authUser!.id, id);
      if (!deleted) {
        res.status(404).json({ error: 'Not Found', message: 'Phone not found' });
        return;
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: 'Bad Request', message: error.message });
    }
  });
});

router.post('/me/phones/:id/resend', requireApiAuth, requireCsrf, async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid phone ID' });
    return;
  }
  const result = auth.resendPhoneVerificationCode(req.authUser!.id, id);
  if (!result) {
    res.status(400).json({ error: 'Bad Request', message: 'Phone not found or already verified' });
    return;
  }
  const sendResult = await sendSmsCode(result.phone, result.code);
  console.log(`[phone] Verification code (resent) for ${result.phone}: ${result.code}`);
  if (sendResult.ok) {
    res.json({ success: true, message: `Verification code sent to ${maskPhone(result.phone)}.` });
  } else {
    res.json({ success: true, message: `SMS unavailable: ${sendResult.error || 'not configured'}. Code logged to console.` });
  }
});

export default router;
