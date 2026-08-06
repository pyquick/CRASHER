import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import * as auth from '../auth.js';
import { sendResetApprovalEmail, sendVerificationEmail } from '../notification/service.js';
import {
  rateLimit,
  readSession,
  requireApiAuth,
  requireCsrf,
  requireRole,
  setCsrfCookie,
} from '../middleware.js';

const router = Router();

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!name || !domain) return email;
  const dn = domain.split('.');
  return `${name[0]}***@${dn[0][0]}***.${dn.slice(1).join('.')}`;
}

async function beginAdminEmailVerification(
  user: { id: number; username: string; role: string },
  req: Request,
  res: Response,
): Promise<boolean> {
  if (user.role !== 'admin') return false;

  const emails = auth.listEmails(user.id);
  if (emails.length === 0 || emails.some(email => email.email_verified === 1)) return false;

  const session = auth.createFirstLoginVerSession(user.id);
  if (!session) return false;

  auth.writeAuditLog(user.id, 'login.email_verification_required', 'user', String(user.id), req.ip ?? '', {});
  const sendResult = await sendVerificationEmail(session.email, session.emailCode);
  console.log(`[login] EMAIL-VERIFICATION code for ${user.username} (${session.email}): ${session.emailCode}`);
  res.json({
    success: true,
    requires_email_verification: true,
    temp_token: session.tempToken,
    email_hint: maskEmail(session.email),
    message: sendResult.ok
      ? `A verification code has been sent to ${maskEmail(session.email)}.`
      : 'SMTP unavailable. Check console for the verification code.',
  });
  return true;
}

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
    const user = auth.createUser(username, password, 'admin');
    if (email) {
      try { auth.addEmail(user.id, email); } catch { /* duplicate or invalid — skip */ }
    }
    const token = auth.createSession(user.id);
    res.cookie('auth_token', token, {
      httpOnly: true, secure: config.cookieSecure, sameSite: 'strict',
      maxAge: config.sessionHours * 60 * 60 * 1000, path: '/',
    });
    setCsrfCookie(res);
    auth.writeAuditLog(user.id, 'setup.completed', 'user', String(user.id), req.ip ?? '', {});
    res.json({ success: true, user });
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

router.get('/csrf', requireApiAuth, (req: Request, res: Response): void => {
  res.json({ csrf_token: setCsrfCookie(res) });
});

router.post('/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.loginRateLimit,
  key: req => `${req.ip}:${String(req.body?.username ?? '').trim().toLowerCase()}`,
}), async (req: Request, res: Response): Promise<void> => {
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = auth.authenticateUser(username, password);
  if (!user) {
    auth.writeAuditLog(null, 'login.failed', 'user', username.substring(0, 64), req.ip ?? '', {});
    res.status(401).json({ success: false, message: 'Invalid username or password' });
    return;
  }

  const full = auth.getUserById(user.id);
  if (full?.totp_enabled) {
    const tempToken = auth.createTotpTempToken(user.id);
    res.json({ success: true, requires_totp: true, temp_token: tempToken });
    return;
  }

  // Admins with email addresses must verify one before a session is created.
  if (full && await beginAdminEmailVerification(full, req, res)) return;

  const token = auth.createSession(user.id);
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: config.sessionHours * 60 * 60 * 1000,
    path: '/',
  });
  setCsrfCookie(res);
  auth.writeAuditLog(user.id, 'login.succeeded', 'user', String(user.id), req.ip ?? '', {});
  res.json({ success: true, user });
});

router.post('/login/totp', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `totp:${req.ip}`,
}), async (req: Request, res: Response): Promise<void> => {
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
  const user = auth.getUserById(userId);
  if (!user || !user.is_active) {
    res.status(401).json({ success: false, message: 'Account is disabled' });
    return;
  }
  if (await beginAdminEmailVerification(user, req, res)) return;

  const sessionToken = auth.createSession(userId);
  res.cookie('auth_token', sessionToken, {
    httpOnly: true, secure: config.cookieSecure, sameSite: 'strict',
    maxAge: config.sessionHours * 60 * 60 * 1000, path: '/',
  });
  setCsrfCookie(res);
  auth.writeAuditLog(userId, 'login.succeeded', 'user', String(userId), req.ip ?? '', { totp: true });
  res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, totp_enabled: user.totp_enabled } });
});

router.post('/login/verify-email', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `login-email-verify:${req.ip}`,
}), (req: Request, res: Response): void => {
  const tempToken = typeof req.body?.temp_token === 'string' ? req.body.temp_token.trim() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
  if (!tempToken || !code) {
    res.status(400).json({ error: 'Bad Request', message: 'Temp token and verification code are required' });
    return;
  }
  const sessionToken = auth.consumeFirstLoginVerSession(tempToken, code);
  if (!sessionToken) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired verification code' });
    return;
  }
  res.cookie('auth_token', sessionToken, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: config.sessionHours * 60 * 60 * 1000,
    path: '/',
  });
  setCsrfCookie(res);
  res.json({ success: true });
});

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
  const result = auth.resendFirstLoginCode(tempToken);
  if (!result) {
    res.status(400).json({ error: 'Bad Request', message: 'Too many requests. Please wait 60 seconds before requesting a new code, or the verification session has expired.' });
    return;
  }
  const sendResult = await sendVerificationEmail(result.email, result.emailCode);
  console.log(`[login] EMAIL-VERIFICATION code (resent) for ${result.email}: ${result.emailCode}`);
  res.json({
    success: true,
    email_hint: maskEmail(result.email),
    message: sendResult.ok
      ? `A new verification code has been sent to ${maskEmail(result.email)}.`
      : `SMTP unavailable. Check console for the new verification code.`,
  });
});

router.post('/logout', requireApiAuth, (req: Request, res: Response): void => {
  const session = readSession(req);
  if (session) auth.deleteSession(session.sessionId);
  if (req.authUser) auth.writeAuditLog(req.authUser.id, 'logout', 'user', String(req.authUser.id), req.ip ?? '', {});
  res.clearCookie('auth_token', { path: '/', secure: config.cookieSecure, sameSite: 'strict' });
  res.clearCookie('csrf_token', { path: '/', secure: config.cookieSecure, sameSite: 'strict' });
  res.json({ success: true });
});

router.get('/me', requireApiAuth, (req: Request, res: Response): void => {
  const u = req.authUser!;
  const full = auth.getUserById(u.id);
  res.json({ user: { id: u.id, username: u.username, role: u.role, totp_enabled: full?.totp_enabled ?? 0 } });
});

router.get('/users', requireApiAuth, requireRole('admin'), (_req: Request, res: Response): void => {
  res.json({ items: auth.listUsers() });
});

router.post('/users', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  try {
    const role = req.body?.role ?? 'viewer';
    const requestedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
    const generatedPassword = role === 'viewer' && !requestedPassword ? auth.generateInitialPassword() : '';
    const user = auth.createUser(String(req.body?.username ?? ''), requestedPassword || generatedPassword, role);
    auth.writeAuditLog(req.authUser!.id, 'user.created', 'user', String(user.id), req.ip ?? '', { role: user.role, generated_password: Boolean(generatedPassword) });
    res.status(201).json({ user, ...(generatedPassword ? { initial_password: generatedPassword } : {}) });
  } catch (error: any) {
    const duplicate = error?.code === 'SQLITE_CONSTRAINT_UNIQUE';
    const status = duplicate ? 409 : 400;
    res.status(status).json({ error: duplicate ? 'Conflict' : 'Bad Request', message: duplicate ? 'Username already exists' : error.message });
  }
});

router.patch('/users/:id', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid user ID' });
    return;
  }
  const requestedActive = req.body?.is_active;
  if (requestedActive !== undefined && typeof requestedActive !== 'boolean') {
    res.status(400).json({ error: 'Bad Request', message: 'is_active must be a boolean' });
    return;
  }
  if (id === req.authUser!.id && requestedActive === false) {
    res.status(403).json({ error: 'Forbidden', message: 'You cannot disable your own account' });
    return;
  }
  try {
    if (!auth.updateUser(id, { role: req.body?.role, is_active: requestedActive }, req.authUser!.id)) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' });
      return;
    }
    auth.writeAuditLog(req.authUser!.id, 'user.updated', 'user', String(id), req.ip ?? '', { role: req.body?.role, is_active: requestedActive });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

router.put('/users/:id/password', requireApiAuth, requireRole('admin', 'operator'), requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid user ID' });
    return;
  }
  if (req.authUser!.role === 'operator' && id !== req.authUser!.id) {
    res.status(403).json({ error: 'Forbidden', message: 'Operators may only change their own password' });
    return;
  }
  const target = auth.getUserById(id);
  if (target && target.role === 'admin') {
    res.status(403).json({ error: 'Forbidden', message: 'Admin passwords cannot be changed directly. Use the forgot-password flow to reset your password.' });
    return;
  }
  try {
    if (!auth.changePassword(req.authUser!, id, req.body?.current_password, String(req.body?.new_password ?? ''))) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' });
      return;
    }
    auth.writeAuditLog(req.authUser!.id, 'user.password_changed', 'user', String(id), req.ip ?? '', {});
    res.json({ success: true, relogin_required: true });
  } catch (error: any) {
    const forbidden = error.message === 'Insufficient permissions';
    const status = forbidden ? 403 : 400;
    res.status(status).json({ error: forbidden ? 'Forbidden' : 'Bad Request', message: error.message });
  }
});

router.get('/api-keys', requireApiAuth, requireRole('admin', 'operator'), (req: Request, res: Response): void => {
  res.json({ items: auth.listApiKeysForUser(req.authUser!) });
});

router.post('/api-keys', requireApiAuth, requireRole('admin', 'operator'), requireCsrf, (req: Request, res: Response): void => {
  try {
    const userId = req.authUser!.role === 'admin' && req.body?.user_id ? Number(req.body.user_id) : req.authUser!.id;
    const tier = req.body?.tier ?? 'operator';
    // Operator-created keys are always operator tier; admin can set any tier
    const effectiveTier = req.authUser!.role === 'admin' ? tier : 'operator';
    const limits = req.authUser!.role === 'admin'
      ? { minute_limit: req.body?.minute_limit, daily_limit: req.body?.daily_limit }
      : {};
    const key = auth.createApiKey(userId, String(req.body?.name ?? ''), effectiveTier, req.body?.expires_at, limits);
    auth.writeAuditLog(req.authUser!.id, 'api_key.created', 'api_key', String(key.id), req.ip ?? '', {
      user_id: userId,
      name: key.name,
      tier: effectiveTier,
      ...limits,
    });
    res.status(201).json(key);
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

router.delete('/api-keys/:id', requireApiAuth, requireRole('admin', 'operator'), requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid API key ID' });
    return;
  }
  if (!auth.revokeApiKey(id, req.authUser!)) {
    res.status(404).json({ error: 'Not Found', message: 'API key not found or already revoked' });
    return;
  }
  auth.writeAuditLog(req.authUser!.id, 'api_key.revoked', 'api_key', String(id), req.ip ?? '', {});
  res.json({ success: true });
});

// ── Email Management Routes ──

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
      res.json({ success: true, method: 'smtp', message: `Verification code sent to ${result.email}.` });
    } else {
      res.json({ success: true, method: 'console', message: `SMTP unavailable: ${sendResult.error || 'not configured'}. Verification code logged to console.` });
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

router.post('/me/emails/:id/primary', requireApiAuth, requireCsrf, (req: Request, res: Response): void => {
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

router.delete('/me/emails/:id', requireApiAuth, requireCsrf, (req: Request, res: Response): void => {
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

// ── TOTP Routes ──

router.get('/me/totp/setup', requireApiAuth, (req: Request, res: Response): void => {
  const full = auth.getUserById(req.authUser!.id);
  if (full?.totp_enabled) {
    res.status(400).json({ error: 'Bad Request', message: '2FA is already enabled. Disable it first to set up a new one.' });
    return;
  }
  const data = auth.generateTotpSecret(req.authUser!.username);
  const [secret, qrUri] = data.split('\n');
  res.json({ secret, qr_uri: qrUri });
});

router.post('/me/totp/enable', requireApiAuth, requireCsrf, (req: Request, res: Response): void => {
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

router.post('/me/totp/disable', requireApiAuth, requireCsrf, (req: Request, res: Response): void => {
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

router.patch('/api-keys/:id/limits', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid API key ID' });
    return;
  }
  try {
    const limits = { minute_limit: req.body?.minute_limit, daily_limit: req.body?.daily_limit };
    if (!auth.updateApiKeyLimits(id, limits, req.authUser!)) {
      res.status(404).json({ error: 'Not Found', message: 'API key not found or already revoked' });
      return;
    }
    auth.writeAuditLog(req.authUser!.id, 'api_key.limits_updated', 'api_key', String(id), req.ip ?? '', limits);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

/**
 * PATCH /api/v1/auth/api-keys/:id/tier
 * Admin updates the tier of an API key.
 */
router.patch('/api-keys/:id/tier', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid API key ID' });
    return;
  }
  try {
    const tier = req.body?.tier ?? 'operator';
    if (!auth.updateApiKeyTier(id, tier, req.authUser!)) {
      res.status(404).json({ error: 'Not Found', message: 'API key not found or already revoked' });
      return;
    }
    auth.writeAuditLog(req.authUser!.id, 'api_key.tier_updated', 'api_key', String(id), req.ip ?? '', { tier });
    res.json({ success: true });
  } catch (error: any) {
    const forbidden = error.message === 'Insufficient permissions';
    const status = forbidden ? 403 : 400;
    res.status(status).json({ error: forbidden ? 'Forbidden' : 'Bad Request', message: error.message });
  }
});

export default router;
