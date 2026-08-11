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

### 2FA 实现标准

#### ✅ 正确：使用统一的 2FA 存储引擎

```typescript
// src/auth/two-factor.ts
const store = new Map<string, { codeHash: string; expires: number; ... }>();

export function createChallenge(userId: number) {
  const code = generateCode();        // 6 位数字
  const token = randomBytes(32).toString('base64url');
  store.set(token, {
    codeHash: sha256(code),           // ✅ SHA-256 哈希存储
    expires: Date.now() + 10 * 60 * 1000,  // ✅ 10 分钟过期
    attempts: 0,
    maxAttempts: 5,                   // ✅ 最多 5 次尝试
  });
  return { token, code };
}

export function verifyChallenge(token: string, code: string): boolean {
  const session = store.get(token);
  if (!session || session.expires < Date.now()) return false;  // ✅ 过期检查
  session.attempts++;
  return sha256(code) === session.codeHash;  // ✅ 恒定时间比较
}
```

#### ❌ 严禁

```typescript
// ❌ 禁止 —— 明文存储验证码
store.set(token, { code: '123456' });  // ❌ 应使用 SHA-256 哈希

// ❌ 禁止 —— 无过期时间
store.set(token, { codeHash: '...' });  // ❌ 缺少过期时间

// ❌ 禁止 —— 无限重试
// ❌ 禁止 —— 6 个独立的 2FA 存储（应使用统一的通用实现）
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

### 撤销密钥

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
