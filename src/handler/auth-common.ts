import { type Request, type Response } from 'express';
import { config } from '../config.js';
import * as auth from '../auth.js';
import { sendSmsCode, sendVerificationEmail } from '../notification/service.js';
import type { TwoFactorMethod } from '../model.js';
import { readMfaToken, setCsrfCookie, setMfaCookie } from '../middleware.js';
import { setSessionCookie } from '../shared/cookie.js';

export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!name || !domain) return email;
  const dn = domain.split('.');
  return `${name[0]}***@${dn[0][0]}***.${dn.slice(1).join('.')}`;
}

export function maskPhone(phone: string): string {
  return auth.maskPhone(phone);
}

function loginUser(userId: number) {
  const full = auth.getUserById(userId);
  return { id: userId, username: full?.username ?? '', role: full?.role, totp_enabled: full?.totp_enabled ?? 0 };
}

export function completeLogin(req: Request, res: Response, userId: number, audit: Record<string, unknown>): void {
  const token = auth.createSession(userId);
  setSessionCookie(res, 'auth_token', token, config.sessionHours * 60 * 60 * 1000);
  setCsrfCookie(res);
  auth.writeAuditLog(userId, 'login.succeeded', 'user', String(userId), req.ip ?? '', audit);
  res.json({ success: true, user: loginUser(userId) });
}

/**
 * Continue the login chain after the password check (and after each completed
 * verification step). Admin-only two-step verification:
 *   1. Email identity verification (opt-in via verify_email_on_login)
 *   2. TOTP (authenticator app)
 * Non-admin users are logged in directly.
 */
export async function continueLogin(
  req: Request,
  res: Response,
  userId: number,
  skipEmailVerification = false,
): Promise<void> {
  const full = auth.getUserById(userId);
  if (!full || !full.is_active) {
    res.status(401).json({ success: false, message: 'Account is disabled' });
    return;
  }

  if (full.role === 'admin') {
    if (!skipEmailVerification && config.emailEnabled && full.verify_email_on_login === 1 && auth.hasVerifiedEmail(userId)) {
      const session = auth.createLoginEmailVerificationSession(userId);
      if (session) {
        const sendResult = await sendVerificationEmail(session.email, session.code);
        console.log(`[login] EMAIL-VERIFICATION code for ${full.username} (${session.email}): ${session.code}`);
        auth.writeAuditLog(userId, 'login.email_verification_required', 'user', String(userId), req.ip ?? '', {});
        res.json({
          success: true,
          email_verification: {
            temp_token: session.tempToken,
            email_hint: maskEmail(session.email),
            message: sendResult.ok
              ? `A verification code has been sent to ${maskEmail(session.email)}.`
              : 'SMTP unavailable. Check console for the verification code.',
          },
        });
        return;
      }
    }

    if (full.totp_enabled) {
      const tempToken = auth.createTotpTempToken(userId);
      res.json({ success: true, two_factor: { method: 'totp', temp_token: tempToken } });
      return;
    }
  }

  completeLogin(req, res, userId, {});
}

/**
 * Resolve 2FA for account operations.
 * If the user has 2FA methods available and hasn't provided a valid MFA token,
 * initiates a 2FA challenge and returns 403.
 */
export async function resolve2FA(
  req: Request,
  res: Response,
  actionName: string,
  execute: () => Promise<void> | void,
): Promise<void> {
  // API key auth skips 2FA
  if (req.authType === 'api_key') {
    execute();
    return;
  }

  const user = req.authUser!;
  const methods = auth.getAvailable2FAMethods(user.id);

  // No 2FA methods available — allow the operation
  if (methods.length === 0) {
    execute();
    return;
  }

  // Check for existing valid MFA session (via cookie)
  const mfaToken = readMfaToken(req);
  if (mfaToken && auth.validateMfaSession(mfaToken, user.id)) {
    execute();
    return;
  }

  // Need 2FA: choose the default method based on user preference
  const full = auth.getUserById(user.id);
  const prefMethod = full?.two_factor_method ?? 'totp';
  const method: TwoFactorMethod =
    (prefMethod !== 'none' && (methods as string[]).includes(prefMethod))
      ? prefMethod as TwoFactorMethod
      : methods[0];

  // Strip _2fa_token from body before storing payload
  const { _2fa_token, ...cleanBody } = req.body || {};
  const session = auth.createOperation2FASession(user.id, method, actionName, cleanBody);
  if (!session) {
    res.status(400).json({ error: 'Bad Request', message: 'Could not create 2FA challenge. Set up a verified email or phone number first.' });
    return;
  }

  // Send code for email/sms methods
  let emailHint: string | undefined;
  let phoneHint: string | undefined;
  if (method === 'email' && session.email && session.code) {
    await sendVerificationEmail(session.email!, session.code!);
    console.log(`[2fa] EMAIL code for ${user.username} (${session.email}): ${session.code}`);
    emailHint = maskEmail(session.email!);
  } else if (method === 'sms' && session.phone && session.code) {
    await sendSmsCode(session.phone!, session.code!);
    console.log(`[2fa] SMS code for ${user.username} (${session.phone}): ${session.code}`);
    phoneHint = maskPhone(session.phone!);
  }

  auth.writeAuditLog(user.id, '2fa.challenged', 'user', String(user.id), req.ip ?? '', {
    method,
    action: actionName,
  });

  res.status(403).json({
    success: true,
    requires_2fa: true,
    temp_token: session.tempToken,
    method,
    available_methods: methods,
    email_hint: emailHint,
    phone_hint: phoneHint,
    message: method === 'totp'
      ? 'Enter your authenticator code to continue.'
      : `A verification code has been sent to your ${method}.`,
  });
}

/** Mark a 2FA challenge as verified and set the MFA session cookie. */
export function markMfaVerified(req: Request, res: Response, action: string): void {
  const mfaToken = auth.createMfaSession(req.authUser!.id);
  setMfaCookie(res, mfaToken);
  auth.writeAuditLog(req.authUser!.id, '2fa.verified', 'user', String(req.authUser!.id), req.ip ?? '', { action });
}
