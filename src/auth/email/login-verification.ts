import { createVerificationStore } from '../../shared/verification.js';
import { getPrimaryEmail } from './manage.js';

// ── Login email verification (identity check, admin only, opt-in) ──
//
// The code is sent to the user's primary VERIFIED email. Completing this step
// proves the login attempt is made by someone who controls the mailbox.
// Unlike account-level email verification, this step does not change any
// email's verified status.

const LOGIN_EMAIL_VERIFY_TTL = 10 * 60 * 1000;
const LOGIN_EMAIL_VERIFY_COOLDOWN = 60_000;
const LOGIN_EMAIL_VERIFY_MAX_ATTEMPTS = 5;

interface LoginEmailVerificationData {
  userId: number;
  email: string;
}

const store = createVerificationStore<LoginEmailVerificationData>(
  LOGIN_EMAIL_VERIFY_TTL,
  LOGIN_EMAIL_VERIFY_COOLDOWN,
  LOGIN_EMAIL_VERIFY_MAX_ATTEMPTS
);

export function createLoginEmailVerificationSession(userId: number): { tempToken: string; code: string; email: string } | null {
  const email = getPrimaryEmail(userId);
  if (!email) return null;
  const { token, code } = store.createWithCode({ userId, email });
  return { tempToken: token, code, email };
}

export function consumeLoginEmailVerificationSession(tempToken: string, code: string): number | null {
  if (!store.verify(tempToken, code)) return null;
  const data = store.consume<LoginEmailVerificationData>(tempToken);
  return data?.userId ?? null;
}

export function resendLoginEmailVerificationCode(tempToken: string): { code: string; email: string } | null {
  const data = store.get<LoginEmailVerificationData>(tempToken);
  if (!data) return null;
  // First send after the challenge is explicit (user clicks send); the code is
  // never sent automatically. Cooldown protection still applies to re-sends
  // once a code has been delivered.
  const code = store.resend(tempToken, true);
  if (!code) return null;
  return { code, email: data.email };
}
