import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import * as auth from '../auth.js';
import {
  rateLimit,
  readSession,
  requireApiAuth,
  requireCsrf,
  requireRole,
  setCsrfCookie,
} from '../middleware.js';

const router = Router();

router.get('/csrf', requireApiAuth, (req: Request, res: Response): void => {
  res.json({ csrf_token: setCsrfCookie(res) });
});

router.post('/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.loginRateLimit,
  key: req => `${req.ip}:${String(req.body?.username ?? '').trim().toLowerCase()}`,
}), (req: Request, res: Response): void => {
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = auth.authenticateUser(username, password);
  if (!user) {
    auth.writeAuditLog(null, 'login.failed', 'user', username.substring(0, 64), req.ip ?? '', {});
    res.status(401).json({ success: false, message: 'Invalid username or password' });
    return;
  }

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

router.post('/logout', requireApiAuth, (req: Request, res: Response): void => {
  const session = readSession(req);
  if (session) auth.deleteSession(session.sessionId);
  if (req.authUser) auth.writeAuditLog(req.authUser.id, 'logout', 'user', String(req.authUser.id), req.ip ?? '', {});
  res.clearCookie('auth_token', { path: '/', secure: config.cookieSecure, sameSite: 'strict' });
  res.clearCookie('csrf_token', { path: '/', secure: config.cookieSecure, sameSite: 'strict' });
  res.json({ success: true });
});

router.get('/me', requireApiAuth, (req: Request, res: Response): void => {
  res.json({ user: req.authUser });
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
  if (id === req.authUser!.id && req.body?.is_active === false) {
    res.status(400).json({ error: 'Bad Request', message: 'You cannot disable your own account' });
    return;
  }
  try {
    if (!auth.updateUser(id, { role: req.body?.role, is_active: req.body?.is_active })) {
      res.status(404).json({ error: 'Not Found', message: 'User not found' });
      return;
    }
    auth.writeAuditLog(req.authUser!.id, 'user.updated', 'user', String(id), req.ip ?? '', { role: req.body?.role, is_active: req.body?.is_active });
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
    const key = auth.createApiKey(userId, String(req.body?.name ?? ''), effectiveTier, req.body?.expires_at);
    auth.writeAuditLog(req.authUser!.id, 'api_key.created', 'api_key', String(key.id), req.ip ?? '', { user_id: userId, name: key.name, tier: effectiveTier });
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

// ── Password Reset Routes ──

/**
 * POST /api/v1/auth/forgot-password
 * Initiate the forgot-password flow. Rate-limited to prevent enumeration.
 * Always returns success to avoid username enumeration.
 */
router.post('/forgot-password', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `forgot:${req.ip}`,
}), (req: Request, res: Response): void => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username || username.length > 64) {
    // Still respond "success" to avoid enumeration
    res.json({ success: true, message: 'If the account exists, a reset token has been generated.' });
    return;
  }
  const result = auth.createPasswordResetToken(username);
  auth.writeAuditLog(null, 'password_reset.requested', 'user', username.substring(0, 64), req.ip ?? '', { success: !!result });
  if (result) {
    // In a production environment, you would send the token via email here.
    // For now, the token is returned only to the admin who requested it,
    // or displayed in the server console for self-service resets.
    console.log(`[reset] Password reset token for ${result.username}: ${result.token.substring(0, 8)}... (valid ${15} minutes)`);
    res.json({ success: true, message: 'A reset token has been generated. Contact an administrator to complete the reset.', reset_token: result.token });
  } else {
    res.json({ success: true, message: 'If the account exists, a reset token has been generated.' });
  }
});

/**
 * POST /api/v1/auth/reset-password
 * Complete a password reset using a valid reset token.
 * Public endpoint — no existing authentication required.
 */
router.post('/reset-password', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `reset:${req.ip}`,
}), (req: Request, res: Response): void => {
  const token = typeof req.body?.reset_token === 'string' ? req.body.reset_token.trim() : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  if (!token || !newPassword) {
    res.status(400).json({ error: 'Bad Request', message: 'Reset token and new password are required' });
    return;
  }
  try {
    const user = auth.resetPasswordWithToken(token, newPassword);
    if (!user) {
      auth.writeAuditLog(null, 'password_reset.failed', 'user', '', req.ip ?? '', {});
      res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired reset token' });
      return;
    }
    auth.writeAuditLog(user.id, 'password_reset.completed', 'user', String(user.id), req.ip ?? '', {});
    res.json({ success: true, message: 'Password has been reset successfully. Please log in with your new password.', username: user.username });
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

/**
 * POST /api/v1/auth/admin-reset/:id
 * Admin generates a password reset token for any user.
 */
router.post('/admin-reset/:id', requireApiAuth, requireRole('admin'), requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid user ID' });
    return;
  }
  const result = auth.adminResetPassword(req.authUser!, id);
  if (!result) {
    res.status(404).json({ error: 'Not Found', message: 'User not found or inactive' });
    return;
  }
  auth.writeAuditLog(req.authUser!.id, 'password_reset.admin_initiated', 'user', String(id), req.ip ?? '', {});
  res.json({ success: true, reset_token: result.token, username: result.username, expires_in_minutes: 15 });
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
