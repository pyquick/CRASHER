import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import * as auth from '../auth.js';
import { sendVerificationEmail } from '../notification/service.js';
import { clearCookie, setSessionCookie } from '../shared/cookie.js';
import {
  rateLimit,
  readSession,
  requireApiAuth,
  setCsrfCookie,
} from '../middleware.js';
import { completeLogin, continueLogin, maskEmail } from './auth-common.js';

const router = Router();

// ── Initial Setup (no users yet) ──

/**
 * GET /api/v1/auth/setup-status
 * Returns whether the server needs initial admin setup.
 */
router.get('/setup-status', (_req: Request, res: Response): void => {
  res.json({ needs_setup: !auth.hasUsers() });
});

/**
 * POST /api/v1/auth/setup
 * Create the first admin account. Only works when zero users exist.
 * Auto-logs in the new admin on success.
 */
router.post('/setup', (req: Request, res: Response): void => {
  if (auth.hasUsers()) {
    res.status(403).json({ error: 'Forbidden', message: 'Setup has already been completed' });
    return;
  }
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!username || !password) {
    res.status(400).json({ error: 'Bad Request', message: 'Username and password are required' });
    return;
  }
  try {
    // First user is always UltraAdmin
    const user = auth.createUser(username, password, 'ultraadmin');
    if (email) {
      try { auth.addEmail(user.id, email); } catch { /* duplicate or invalid — skip */ }
    }
    const token = auth.createSession(user.id);
    setSessionCookie(res, 'auth_token', token, config.sessionHours * 60 * 60 * 1000);
    setCsrfCookie(res);
    auth.writeAuditLog(user.id, 'setup.completed', 'user', String(user.id), req.ip ?? '', { role: 'ultraadmin' });
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

router.get('/csrf', requireApiAuth, (req: Request, res: Response): void => {
  res.json({ csrf_token: setCsrfCookie(res) });
});

// ── Login ──

router.post('/login', rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: config.loginRateLimit,
  key: req => `${req.ip}:${String(req.body?.username ?? '').trim().toLowerCase()}`,
}), async (req: Request, res: Response): Promise<void> => {
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const containerId = req.body?.container_id ? parseInt(String(req.body.container_id), 10) : undefined;
  let user = auth.authenticateUser(username, password, containerId);
  if (!user && containerId) {
    // Retry without container filter for UltraAdmin login
    user = auth.authenticateUser(username, password, null);
    if (user && user.role !== 'ultraadmin') user = null;
  }
  // Non-ultraadmin users must select a container
  if (user && user.role !== 'ultraadmin' && !containerId) {
    user = null;
  }
  if (!user) {
    auth.writeAuditLog(null, 'login.failed', 'user', username.substring(0, 64), req.ip ?? '', {});
    res.status(401).json({ success: false, message: 'Invalid username or password' });
    return;
  }

  await continueLogin(req, res, user.id);
});

/**
 * POST /api/v1/auth/login/verify-email
 * Complete the email identity-verification step. On success the login chain
 * continues (2FA step or session).
 */
router.post('/login/verify-email', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `login-email-verify:${req.ip}`,
}), async (req: Request, res: Response): Promise<void> => {
  const tempToken = typeof req.body?.temp_token === 'string' ? req.body.temp_token.trim() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
  if (!tempToken || !code) {
    res.status(400).json({ error: 'Bad Request', message: 'Temp token and verification code are required' });
    return;
  }
  const userId = auth.consumeLoginEmailVerificationSession(tempToken, code);
  if (!userId) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired verification code' });
    return;
  }
  await continueLogin(req, res, userId, true);
});

/**
 * POST /api/v1/auth/login/resend-email
 * Resend the login email-verification code.
 */
router.post('/login/resend-email', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  key: req => `login-email-resend:${req.ip}`,
}), async (req: Request, res: Response): Promise<void> => {
  const tempToken = typeof req.body?.temp_token === 'string' ? req.body.temp_token.trim() : '';
  if (!tempToken) {
    res.status(400).json({ error: 'Bad Request', message: 'Temp token is required' });
    return;
  }
  const result = auth.resendLoginEmailVerificationCode(tempToken);
  if (!result) {
    res.status(400).json({ error: 'Bad Request', message: 'Too many requests. Please wait 60 seconds before requesting a new code, or the verification session has expired.' });
    return;
  }
  const sendResult = await sendVerificationEmail(result.email, result.code);
  console.log(`[login] EMAIL-VERIFICATION code (resent) for ${result.email}: ${result.code}`);
  res.json({
    success: true,
    email_hint: maskEmail(result.email),
    message: sendResult.ok
      ? `A new verification code has been sent to ${maskEmail(result.email)}.`
      : `SMTP unavailable. Check console for the new verification code.`,
  });
});

/**
 * POST /api/v1/auth/login/totp
 * Complete the TOTP step of the login chain.
 */
router.post('/login/totp', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `totp:${req.ip}`,
}), (req: Request, res: Response): void => {
  const tempToken = typeof req.body?.temp_token === 'string' ? req.body.temp_token : '';
  const totpCode = typeof req.body?.totp_code === 'string' ? req.body.totp_code.replace(/\s/g, '') : '';
  if (!tempToken || !totpCode) {
    res.status(400).json({ error: 'Bad Request', message: 'Temporary token and TOTP code are required' });
    return;
  }
  const userId = auth.consumeTotpTempToken(tempToken);
  if (!userId) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired temporary token. Please log in again.' });
    return;
  }
  if (!auth.verifyTotp(userId, totpCode)) {
    auth.writeAuditLog(userId, 'login.totp_failed', 'user', String(userId), req.ip ?? '', {});
    res.status(401).json({ success: false, message: 'Invalid TOTP code' });
    return;
  }
  completeLogin(req, res, userId, { totp: true });
});

router.post('/logout', requireApiAuth, (req: Request, res: Response): void => {
  const session = readSession(req);
  if (session) auth.deleteSession(session.sessionId);
  if (req.authUser) auth.writeAuditLog(req.authUser.id, 'logout', 'user', String(req.authUser.id), req.ip ?? '', {});
  clearCookie(res, 'auth_token');
  clearCookie(res, 'csrf_token');
  res.json({ success: true });
});

router.get('/me', requireApiAuth, (req: Request, res: Response): void => {
  const u = req.authUser!;
  const full = auth.getUserById(u.id);
  const methods = auth.getAvailable2FAMethods(u.id);
  let containerName: string | undefined;
  if (full?.container_id) {
    const c = auth.getContainerById(full.container_id);
    containerName = c?.name;
  }
  res.json({
    user: {
      id: u.id, username: u.username, role: u.role,
      container_id: full?.container_id ?? null, container_name: containerName,
      totp_enabled: full?.totp_enabled ?? 0,
      two_factor_method: full?.two_factor_method ?? 'totp',
      verify_email_on_login: full?.verify_email_on_login ?? 0,
      has_verified_email: auth.hasVerifiedEmail(u.id),
      available_2fa_methods: methods,
    },
  });
});

export default router;
