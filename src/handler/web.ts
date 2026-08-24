import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import * as auth from '../auth.js';
import { getAuthenticatedUser, rateLimit, requireAuth, requireRole, requireUltraAdmin } from '../middleware.js';
import { renderTemplate, renderStandalone } from '../shared/template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..', '..', 'web', 'templates');
const staticDir = resolve(__dirname, '..', '..', 'web', 'static');

const router = Router();

// Serve static assets (CSS, JS)
router.use('/static', express.static(staticDir));

// ── Public routes (no auth) ──

router.get('/login', (_req: Request, res: Response): void => {
  const user = getAuthenticatedUser(_req);
  if (user) { res.redirect('/web/'); return; }
  res.type('html').send(renderStandalone('pages/auth/login.html', 'Login - Crash Report Server'));
});

router.get('/forgot-password', (_req: Request, res: Response): void => {
  const user = getAuthenticatedUser(_req);
  if (user) { res.redirect('/web/'); return; }
  res.type('html').send(renderStandalone('pages/auth/forgot_password.html', 'Forgot Password - Crash Report Server'));
});

router.post('/reset-password', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  key: req => `web-reset:${req.ip}`,
}), (req: Request, res: Response): void => {
  const adminToken = typeof req.body?.admin_token === 'string' ? req.body.admin_token.trim() : '';
  const emailCode = typeof req.body?.email_code === 'string' ? req.body.email_code.replace(/\s/g, '') : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  if (!adminToken || !emailCode || !newPassword) {
    res.status(400).json({ error: 'Bad Request', message: 'Admin token, email code, and new password are required' });
    return;
  }
  try {
    const user = auth.consumeAdminResetSession(adminToken, emailCode, newPassword);
    if (!user) {
      auth.writeAuditLog(null, 'password_reset.failed', 'user', '', req.ip ?? '', { reason: 'admin_self_reset' });
      res.status(400).json({ error: 'Bad Request', message: 'Invalid or expired verification code' });
      return;
    }
    auth.writeAuditLog(user.id, 'password_reset.completed', 'user', String(user.id), req.ip ?? '', { self_reset: true });
    res.json({ success: true, message: 'Password has been reset successfully. Please log in with your new password.', username: user.username });
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

router.get('/approve-reset/:token', (_req: Request, res: Response): void => {
  res.type('html').send(renderStandalone('pages/auth/approve_reset.html', 'Approve Password Reset - Crash Report Server'));
});

// ── Protected page routes ──

router.get('/', requireAuth, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('pages/app/dashboard.html', 'Dashboard - Crash Report Server'));
});

router.get('/crashes', requireAuth, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('pages/app/crash_list.html', 'Crash List - Crash Report Server'));
});

router.get('/crashes/:id', requireAuth, requireRole('admin', 'operator'), (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('pages/app/crash_detail.html', 'Crash Detail - Crash Report Server'));
});

router.get('/feedback', requireAuth, requireRole('admin', 'operator'), (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('pages/app/feedback_list.html', 'Player Feedback - Crash Report Server'));
});

router.get('/symbols', requireAuth, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('pages/app/symbol_list.html', 'Symbols - Crash Report Server'));
});

router.get('/accounts', requireAuth, requireRole('admin', 'operator'), (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('pages/app/account_list.html', 'Account Security - Crash Report Server'));
});

router.get('/containers', requireAuth, requireUltraAdmin, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('pages/app/container_list.html', 'Container Management - Crash Report Server'));
});

router.get('/api-doc', (_req: Request, res: Response): void => {
  const html = readFileSync(resolve(templatesDir, 'pages', 'app', 'api-doc.html'), 'utf-8');
  res.type('html').send(html);
});

router.get('/api-doc-zh', (_req: Request, res: Response): void => {
  const html = readFileSync(resolve(templatesDir, 'pages', 'app', 'api-doc-zh.html'), 'utf-8');
  res.type('html').send(html);
});

export default router;
