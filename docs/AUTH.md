# 认证系统 (Authentication & Authorization)

> 会话登录 · API 密钥 · TOTP/邮件/SMS 2FA · 四级角色 · 密码重置审批

---

## 认证方式

### 1. 会话认证 (Session)

```bash
# ✅ 正确
curl -c cookies.txt -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}'
# → auth_token cookie (HttpOnly, Secure, SameSite=Strict)
# → csrf_token cookie
```

### 2. API 密钥认证

```bash
# ✅ 正确 —— 两种方式均可
curl -H "Authorization: Bearer crs_xxxxxxxxxxxxxxxx" ...
curl -H "X-API-Key: crs_xxxxxxxxxxxxxxxx" ...
```

```typescript
// ❌ 禁止 —— 明文传输 API 密钥在 URL 参数中
fetch('/api/v1/crash-report?api_key=crs_xxx')  // ❌ 密钥泄露在日志中
```

---

## 角色体系

| 角色 | 权限 |
|------|------|
| **ultraadmin** | 全局管理：容器 CRUD、所有数据可见、TOTP 强制 |
| **admin** | 容器管理：用户管理、崩溃清空、符号删除、API 密钥管理 |
| **operator** | 数据操作：查看崩溃详情、管理反馈、上传符号 |
| **viewer** | 只读：查看 Dashboard、崩溃列表、符号列表 |

---

## 两步验证 (2FA)

### 登录两步验证（仅 admin 角色）

登录链：密码校验 → （可选）邮箱身份验证 → （可选）TOTP → 创建会话。两个步骤均为**开关控制**，仅 `admin` 角色可用；其他角色（含 ultraadmin）为纯密码登录。

> `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASSWORD`、`ALERT_EMAIL_FROM`、`ALERT_EMAIL_TO`、`ALERT_ON_NEW_GROUP`、`ALERT_THRESHOLD_COUNT` 任一未设置时，邮箱验证整体禁用（邮箱管理、登录邮箱验证、邮箱 2FA、管理员自助重置均不可用，UI 中完全隐藏）。

| 步骤 | 开关（Accounts 页） | 开启条件 | 说明 |
|------|--------------------|----------|------|
| 邮箱验证 | Verify email on every login | 至少一个已验证邮箱 | 验证码发到主邮箱，证明登录者掌控邮箱 |
| 2FA | Authenticator app 开关 | — | 手机扫描 TOTP（RFC 6238），与原有实现一致 |

登录响应返回下一步骤：`{ email_verification: {...} }`、`{ two_factor: { method: 'totp', ... } }` 或直接创建会话。邮箱验证完成后继续走 2FA 步骤（`/login/verify-email` → 下一步响应）。

### 账户操作 2FA（所有角色）

敏感操作（创建用户、API 密钥管理、邮箱/手机变更等）通过 `resolve2FA` 包裹：有可用方法且无有效 MFA cookie 时返回 `403 { requires_2fa, temp_token, method, ... }`，前端弹出 2FA 浮层，验证通过后设置 MFA cookie 并重试原请求。

### 2FA 实现标准

#### ✅ 正确：使用统一的 2FA 存储引擎

```typescript
// src/shared/verification.ts —— createVerificationStore / createTokenStore
// src/auth/2fa/operation.ts
const store = createVerificationStore<Operation2FAData>(5 * 60 * 1000, 60_000, 5);

export function createOperation2FASession(userId, method, action, bodyPayload) {
  const { token, code } = store.createWithCode({ userId, method, action, bodyPayload: JSON.stringify(bodyPayload) });
  // code: 6 位数字, SHA-256 哈希存储, 10 分钟过期, 最多 5 次尝试, 60s 重发冷却
  return { tempToken: token, code, ... };
}

export function consumeOperation2FASession(tempToken, code) {
  const data = store.get(tempToken);
  if (!data) return null;                                 // ✅ 过期检查
  const valid = data.method === 'totp' ? verifyTotp(data.userId, code) : store.verify(tempToken, code);
  if (!valid) return null;
  store.consume(tempToken);
  return data;
}
```

#### ❌ 严禁

```typescript
// ❌ 禁止 —— 明文存储验证码
store.set(token, { code: '123456' });  // ❌ 应使用 SHA-256 哈希

// ❌ 禁止 —— 无过期时间
store.set(token, { codeHash: '...' });  // ❌ 缺少过期时间

// ❌ 禁止 —— 无限重试
// ❌ 禁止 —— 多个独立的 2FA 存储（应使用统一通用实现）
```

---

## 密码策略

```typescript
// ✅ 正确
export function hashPassword(password: string): string {
  const salt = randomBytes(16);                      // 128-bit salt
  const key = pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$${salt.base64url}$${key.base64url}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  // ✅ 恒定时间比较
  return timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
}
```

```typescript
// ❌ 严禁
// ❌ 禁止 —— SHA-256 单次哈希（无 salt、无迭代）
// ❌ 禁止 —— MD5
// ❌ 禁止 —— 可逆加密
// ❌ 禁止 —— 明文存储
// ❌ 禁止 —— 非恒定时间比较 (===)
```

---

## API 密钥管理

### 创建密钥

```typescript
// ✅ 正确
const { id, name, key } = createApiKey(userId, 'production-key', 'operator', '2027-01-01', {
  minute_limit: 100,
  daily_limit: 10000,
});
// key = "crs_xxxxxxxxxxxxxxxx"  ← 仅在此时返回原始值
// 数据库存储: SHA-256(key)
```

```typescript
// ❌ 严禁
// ❌ 禁止 —— 数据库存储原始密钥
// ❌ 禁止 —— 日志中打印密钥
console.log('Created key:', key);  // ❌
```

### AI Provider 凭据

Admin/Operator 可在 Accounts 配置自己的 DeepSeek API Key。服务端使用 `AI_ENCRYPTION_KEY` 以 AES-256-GCM 加密保存，浏览器、审计日志和 API 响应只显示配置状态，不显示 Key。聊天会话仅创建者可见，消息正文同样加密并默认保留 30 天。

AI 权限是授权数据范围内的只读权限：可以读取当前用户可见的崩溃、确定性分析和已上传源码快照；禁止命令执行、文件修改、远程仓库访问和跨容器/跨用户会话读取。


```typescript
// ✅ 正确 —— 设置 revoked_at 时间戳（软删除）
export function revokeApiKey(id: number, actor: AuthenticatedUser): boolean {
  return store.revokeApiKeyById(id, actor.role === 'admin' ? undefined : actor.id) > 0;
}
```

```typescript
// ❌ 严禁 —— 物理删除密钥记录（审计日志需要保留）
// ❌ 严禁 —— 非管理员撤销他人密钥
```

---

## 审计日志

### ✅ 正确：所有敏感操作记录

```typescript
// src/auth/audit.ts
export function writeAuditLog(actorUserId, action, targetType, targetId, ip, details) {
  insertAuditLog(actorUserId, action, targetType, targetId, ip, JSON.stringify(details));
}

// 使用
writeAuditLog(userId, 'user.password_changed', 'user', String(userId), req.ip, {});
writeAuditLog(adminId, 'container.banned', 'container', String(id), req.ip, { name });
writeAuditLog(userId, 'apikey.created', 'apikey', String(keyId), req.ip, { tier });
```

### ❌ 严禁：敏感操作无记录

```typescript
// ❌ 禁止
function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);  // ❌ 无审计日志
}
```

---

## Cookie 安全

```typescript
// ✅ 正确 —— 使用全局函数
setSessionCookie(res, 'auth_token', token, config.sessionHours * 60 * 60 * 1000);
// → httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/'

clearCookie(res, 'auth_token');
```

```typescript
// ❌ 严禁
res.cookie('auth_token', token);  // ❌ 缺少 security 属性
res.cookie('auth_token', token, {
  httpOnly: false,  // ❌ JS 可访问（XSS 风险）
  sameSite: 'none', // ❌ 跨站请求可携带（CSRF 风险）
});
```
