// Password
export { hashPassword, verifyPassword, passwordIsCurrent, validatePassword, validateUsername, generateInitialPassword } from './password.js';

// User
export { hasUsers, createUser, authenticateUser, listUsers, getUserById, getUserByUsernameInContainer, lookupUserByUsername, updateUser, changePassword, createUserInContainer, countActiveAdmins } from './user.js';

// Session
export { createSession, getValidSession, deleteSession, purgeExpiredSessions } from './session.js';

// API Key
export { createApiKey, listApiKeysForUser, authenticateApiKey, touchApiKey, revokeApiKey, updateApiKeyTier, updateApiKeyLimits, consumeApiKeyQuota } from './api-key.js';
export type { ApiKeyLimits } from './api-key.js';

// Container
export { createContainer, getContainerById, getContainerByName, listContainers, listActiveContainers, banContainer, unbanContainer, deleteContainer, isContainerBanned, getContainerAdminsForNotification, markBanNotificationSent, getContainerStorageSize, getContainerStatus, listContainerStatuses, isContainerOverLimit, getUserContainerId } from './container.js';

// Email
export { listEmails, addEmail, resendVerificationCode, verifyEmailCode, setPrimaryEmail, deleteEmail, getPrimaryEmail, getAnyEmail, hasVerifiedEmail, isVerifyEmailOnLogin, setVerifyEmailOnLogin, createLoginEmailVerificationSession, consumeLoginEmailVerificationSession, resendLoginEmailVerificationCode } from './email/index.js';

// 2FA
export { generateTotpSecret, enableTotp, disableTotp, verifyTotp, createTotpTempToken, consumeTotpTempToken, createOperation2FASession, consumeOperation2FASession, resendOperation2FACode, sendOperation2FACode, createMfaSession, validateMfaSession, getAvailable2FAMethods, listPhones, addPhone, resendPhoneVerificationCode, verifyPhoneCode, setPrimaryPhone, deletePhone, getPrimaryPhone, hasVerifiedPhone, maskPhone } from './2fa/index.js';

// Password Reset
export { createResetRequest, getResetRequest, approveResetRequest, purgeExpiredResetTokens, createAdminResetSession, consumeAdminResetSession, verifyAdminResetEmailCode } from './password-reset.js';
export type { ResetRequest } from './password-reset.js';

// Audit
export { writeAuditLog } from './audit.js';
