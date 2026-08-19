// Email management
export {
  listEmails, addEmail, resendVerificationCode, verifyEmailCode, setPrimaryEmail,
  deleteEmail, getPrimaryEmail, getAnyEmail, hasVerifiedEmail,
  isVerifyEmailOnLogin, setVerifyEmailOnLogin,
} from './manage.js';

// Login email verification (identity check)
export {
  createLoginEmailVerificationSession, consumeLoginEmailVerificationSession,
  resendLoginEmailVerificationCode,
} from './login-verification.js';
