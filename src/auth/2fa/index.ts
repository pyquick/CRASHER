// TOTP (authenticator app)
export { generateTotpSecret, enableTotp, disableTotp, verifyTotp, createTotpTempToken, consumeTotpTempToken } from './totp.js';

// Operation 2FA (account operations)
export { createOperation2FASession, consumeOperation2FASession, resendOperation2FACode, sendOperation2FACode } from './operation.js';

// MFA session + available methods
export { createMfaSession, validateMfaSession, getAvailable2FAMethods } from './mfa.js';

// Phone (SMS 2FA contact management)
export {
  listPhones, addPhone, resendPhoneVerificationCode, verifyPhoneCode, setPrimaryPhone,
  deletePhone, getPrimaryPhone, hasVerifiedPhone, maskPhone,
} from './phone.js';
