# 限流系统 (Rate Limiting)

> 统一接口 · 双后端（内存 + 数据库） · 标准响应头

---

## 架构

```
src/shared/rate-limit.ts
├── createMemoryRateLimiter()    ← 内存限流（IP-based）
└── createApiKeyRateLimiter()    ← DB 限流（密钥配额）
```

---

## 内存限流 (IP-based)

```typescript
import { rateLimit } from './middleware.js';

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,    // 5 分钟窗口
  limit: 150,                  // 150 次请求
  key: req => `login:${req.ip}`,  // 自定义键（可选）
});
```

### 使用场景

| 限流器 | 窗口 | 限制 | 用途 |
|--------|------|------|------|
| `loginRateLimit` | 5 分钟 | 150 | 登录尝试 |
| `ingestRateLimit` | 1 分钟 | 120 | 崩溃接收 |
| `apiRateLimit` | 1 分钟 | 600 | 查询 API 全局 |
| `web-reset` | 15 分钟 | 5 | 密码重置请求 |

---

## API 密钥限流 (DB-backed)

每个 API 密钥有独立的分钟/日配额，0 表示无限制。

```typescript
const minuteLimiter = apiKeyRateLimit(60, 'minute_limit');
const dailyLimiter = apiKeyRateLimit(24 * 60 * 60, 'daily_limit');
```

配额通过 `api_key_usage` 表追踪。每个窗口期开始时计数重置。

### API 密钥层级

| 层级 | 写入 | 删除 | 查询 |
|------|------|------|------|
| admin | ✓ | ✓ | ✓ |
| operator | ✓ | ✗ | ✓ |
| viewer | ✗ | ✗ | ✓ |

---

## 响应头

所有限流响应包含标准头：

```
X-RateLimit-Limit: 150
X-RateLimit-Remaining: 143
X-RateLimit-Reset: 1691755200
```

超出限流时额外包含：
```
Retry-After: 45
```

HTTP 状态码：**429 Too Many Requests**

---

## 配置

```bash
LOGIN_RATE_LIMIT=150       # 5 分钟内最大登录尝试次数
INGEST_RATE_LIMIT=120      # 1 分钟内最大崩溃接收次数
API_RATE_LIMIT=600         # 1 分钟内最大 API 查询次数
```

---

## 添加新限流器

```typescript
// 在 main.ts 或 handler 中
const myLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  key: req => `custom:${req.authUser?.id ?? req.ip}`,
});
app.use('/path', myLimiter, handler);
```

---

## 实例代码

### ✅ 正确：统一接口

```typescript
// src/main.ts
import { rateLimit, apiKeyRateLimit } from './middleware.js';

const ingestLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.ingestRateLimit });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.apiRateLimit });
const apiKeyMinuteLimiter = apiKeyRateLimit(60, 'minute_limit');
const apiKeyDailyLimiter = apiKeyRateLimit(24 * 60 * 60, 'daily_limit');

// 按路由使用
app.use('/api/v1/crash-report', onIngestPost(ingestLimiter), ...);
app.use('/api/v1', apiLimiter, requireApiAuth, ...);
```

### ✅ 正确：自定义限流

```typescript
// src/handler/auth.ts
router.post('/login', rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: config.loginRateLimit,
  key: req => `login:${req.ip}`,  // ✅ 自定义键
}), loginHandler);
```

### ❌ 严禁：限流逻辑分散

```typescript
// ❌ 禁止 —— 在多个文件中重复实现限流逻辑
// middleware.ts: 一个 Map-based 限流
// auth.ts: 另一个 Map-based 限流（2FA 场景）
// handler/auth.ts: 又一个内联限流
// ❌ 应统一使用 src/shared/rate-limit.ts
```

### ❌ 严禁：缺少限流响应头

```typescript
// ❌ 禁止 —— 限流但不设置标准头
function rateLimit(req, res, next) {
  if (count > limit) {
    res.status(429).json({ error: 'Too many requests' });  // ❌ 缺少 X-RateLimit-* 头
    return;
  }
  next();
}
```

### ❌ 严禁：限流器共享存储

```typescript
// ❌ 禁止 —— 创建多个 rateLimit 实例但共享同一个 Map
const sharedMap = new Map();
function createLimiter(opts) {
  return (req, res, next) => {
    // 所有 limiter 使用同一个 Map → 互相干扰
    const entry = sharedMap.get(key);
  };
}
// ✅ 正确：每个 createMemoryRateLimiter 调用创建独立的 Map
```
