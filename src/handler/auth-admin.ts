import { Router, type Request, type Response } from 'express';
import * as auth from '../auth.js';
import { requireApiAuth, requireCsrf, requireRole, requireUltraAdmin } from '../middleware.js';
import { resolve2FA } from './auth-common.js';

const router = Router();

// ── User Management Routes ──

router.get('/users', requireApiAuth, requireRole('admin'), (req: Request, res: Response): void => {
  const actor = req.authUser!;
  const containerId = actor.role === 'ultraadmin' ? undefined : actor.container_id;
  res.json({ items: auth.listUsers(containerId) });
});

router.post('/users', requireApiAuth, requireRole('admin'), requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'user.create', () => {
    try {
      const actor = req.authUser!;
      const role = req.body?.role ?? 'viewer';
      const requestedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
      const generatedPassword = role === 'viewer' && !requestedPassword ? auth.generateInitialPassword() : '';

      let user;
      if (actor.role === 'ultraadmin') {
        // UltraAdmin creates users in a specified container
        const targetContainerId = req.body?.container_id ? parseInt(String(req.body.container_id), 10) : null;
        if (!targetContainerId) {
          res.status(400).json({ error: 'Bad Request', message: 'container_id is required for UltraAdmin user creation' });
          return;
        }
        user = auth.createUserInContainer(String(req.body?.username ?? ''), requestedPassword || generatedPassword, role, targetContainerId);
      } else {
        // Container admin creates users in their own container
        if (!actor.container_id) {
          res.status(400).json({ error: 'Bad Request', message: 'No container assigned' });
          return;
        }
        user = auth.createUserInContainer(String(req.body?.username ?? ''), requestedPassword || generatedPassword, role, actor.container_id);
      }
      auth.writeAuditLog(actor.id, 'user.created', 'user', String(user.id), req.ip ?? '', { role: user.role, generated_password: Boolean(generatedPassword), container_id: user.container_id });
      res.status(201).json({ user, ...(generatedPassword ? { initial_password: generatedPassword } : {}) });
    } catch (error: any) {
      const duplicate = error?.code === 'SQLITE_CONSTRAINT_UNIQUE';
      const status = duplicate ? 409 : 400;
      res.status(status).json({ error: duplicate ? 'Conflict' : 'Bad Request', message: duplicate ? 'Username already exists' : error.message });
    }
  });
});

router.patch('/users/:id', requireApiAuth, requireRole('admin'), requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'user.update', () => {
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
});

router.put('/users/:id/password', requireApiAuth, requireRole('admin', 'operator'), requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'user.password_change', () => {
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
});

// ── API Key Routes ──

router.get('/api-keys', requireApiAuth, requireRole('admin', 'operator'), (req: Request, res: Response): void => {
  res.json({ items: auth.listApiKeysForUser(req.authUser!) });
});

router.post('/api-keys', requireApiAuth, requireRole('admin', 'operator'), requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'apikey.create', () => {
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
});

router.delete('/api-keys/:id', requireApiAuth, requireRole('admin', 'operator'), requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'apikey.revoke', () => {
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
});

router.patch('/api-keys/:id/limits', requireApiAuth, requireRole('admin'), requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'apikey.limits_change', () => {
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
});

/**
 * PATCH /api/v1/auth/api-keys/:id/tier
 * Admin updates the tier of an API key.
 */
router.patch('/api-keys/:id/tier', requireApiAuth, requireRole('admin'), requireCsrf, async (req: Request, res: Response): Promise<void> => {
  await resolve2FA(req, res, 'apikey.tier_change', () => {
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
});

// ── Container Management Routes (UltraAdmin only) ──

router.get('/containers/active', (_req: Request, res: Response): void => {
  res.json({ items: auth.listActiveContainers() });
});

router.get('/containers', requireApiAuth, requireUltraAdmin, (_req: Request, res: Response): void => {
  res.json(auth.listContainerStatuses());
});

router.post('/containers', requireApiAuth, requireUltraAdmin, requireCsrf, (req: Request, res: Response): void => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const tier = parseInt(String(req.body?.tier ?? 3), 10);
    if (!name) {
      res.status(400).json({ error: 'Bad Request', message: 'Container name is required' });
      return;
    }
    const container = auth.createContainer(name, tier, req.authUser!.id);
    auth.writeAuditLog(req.authUser!.id, 'container.created', 'container', String(container.id), req.ip ?? '', { name, tier });
    res.status(201).json(container);
  } catch (error: any) {
    res.status(400).json({ error: 'Bad Request', message: error.message });
  }
});

router.get('/containers/:id/status', requireApiAuth, requireUltraAdmin, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const status = auth.getContainerStatus(id);
  if (!status) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(status);
});

router.post('/containers/:id/ban', requireApiAuth, requireUltraAdmin, requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const container = auth.banContainer(id, req.authUser!.id);
  if (!container) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ success: true, container });
});

router.post('/containers/:id/unban', requireApiAuth, requireUltraAdmin, requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return; }
  const container = auth.unbanContainer(id, req.authUser!.id);
  if (!container) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ success: true, container });
});

router.delete('/containers/:id', requireApiAuth, requireUltraAdmin, requireCsrf, (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return; }
  if (!auth.deleteContainer(id, req.authUser!.id)) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ success: true });
});

router.post('/containers/:id/users', requireApiAuth, requireUltraAdmin, requireCsrf, (req: Request, res: Response): void => {
  const containerId = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(containerId) || containerId <= 0) { res.status(400).json({ error: 'Invalid ID' }); return; }
  try {
    const role = req.body?.role ?? 'admin';
    const requestedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
    const generatedPassword = (role === 'viewer' && !requestedPassword) ? auth.generateInitialPassword() : '';
    const user = auth.createUserInContainer(String(req.body?.username ?? ''), requestedPassword || generatedPassword, role, containerId);
    auth.writeAuditLog(req.authUser!.id, 'user.created', 'user', String(user.id), req.ip ?? '', { role, container_id: containerId });
    res.status(201).json({ user, ...(generatedPassword ? { initial_password: generatedPassword } : {}) });
  } catch (error: any) {
    const duplicate = error?.code === 'SQLITE_CONSTRAINT_UNIQUE';
    const status = duplicate ? 409 : 400;
    res.status(status).json({ error: duplicate ? 'Conflict' : 'Bad Request', message: duplicate ? 'Username already exists' : error.message });
  }
});

export default router;
