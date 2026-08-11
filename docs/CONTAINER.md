# 容器与多租户 (Container & Multi-tenancy)

> 容器隔离 · 五级配额 · 封禁管理 · 数据级联删除

---

## 概念

容器是数据隔离单元。每个容器有独立的：
- 用户（除 UltraAdmin）
- 崩溃数据 / 玩家反馈
- 项目 / 符号文件 / 源码快照
- 存储配额

UltraAdmin 不属于任何容器，可查看和操作所有数据。

---

## 容器层级

| Tier | 名称 | 存储限制 | 说明 |
|------|------|---------|------|
| 1 | 基础 | 50 MB | 小型项目 / 测试 |
| 2 | 标准 | 500 MB | 中型项目 |
| 3 | 专业 | 2 GB | 大型游戏 |
| 4 | 企业 | 10 GB | 多平台部署 |
| 5 | 旗舰 | 1 TB | 最大支持 |

---

## 数据隔离

```
SELECT * FROM crash_reports WHERE container_id = :userContainerId
```

- **UltraAdmin**: `container_id = undefined` → 不过滤（全量查询）
- **普通用户**: `container_id = user.container_id` → 只查询本容器数据

容器作用域解析由 `src/shared/container.ts` 的 `resolveContainerScope()` 统一处理。

---

## 存储统计

```typescript
getContainerStorageSize(containerId):
  crash_reports 数据大小 (text fields)
  + crash_attachments 文件大小
  + feedback_attachments 文件大小
  + symbols 文件大小
```

超过限制时，新写入被拒绝（403 Forbidden）。

---

## 容器管理 API

| 操作 | 方法 | 权限 |
|------|------|------|
| 创建 | `POST /api/v1/auth/containers` | UltraAdmin |
| 列表 | `GET /api/v1/auth/containers` | UltraAdmin |
| 封禁 | `POST /api/v1/auth/containers/:id/ban` | UltraAdmin |
| 解封 | `POST /api/v1/auth/containers/:id/unban` | UltraAdmin |
| 删除 | `DELETE /api/v1/auth/containers/:id` | UltraAdmin |
| 添加用户 | `POST /api/v1/auth/containers/:id/users` | UltraAdmin |

---

## 封禁

封禁容器时：
1. 设置 `containers.is_banned = 1`
2. 立即使该容器所有用户会话失效
3. 所有 API 请求被拒绝
4. 记录审计日志

---

## 删除级联

删除容器时，按顺序清理：
1. **磁盘文件**: 附件 / 符号 / 源码文件
2. **数据库记录**: crash_attachments → crash_reports → crash_groups → feedback_attachments → player_feedback → source_files → source_snapshots → symbols → projects → api_key_usage → api_keys → sessions → emails → phones → password_reset → audit_logs → users
3. **容器记录**: containers

所有操作在一个事务中完成。

---

## 实例代码

### ✅ 正确：容器作用域

```typescript
// src/shared/container.ts —— 统一的作用域解析
export function getContainerScope(req: Request): number | null | undefined {
  const user = req.authUser;
  if (!user || user.role === 'ultraadmin') return undefined;  // 全量查询
  return user.container_id ?? null;  // 容器内查询
}

// 使用
import { getContainerScope } from '../shared/container.js';
const groups = store.listGroups({ container_id: getContainerScope(req) });
```

### ❌ 严禁：内联作用域判断

```typescript
// ❌ 禁止 —— 在多处重复相同的三元表达式
const cid = user?.role !== 'ultraadmin' ? user?.container_id ?? null : undefined;
const groups = store.listGroups({ container_id: cid });

// 应该在另一处又重复：
const containerId = req.authUser?.role !== 'ultraadmin' ? req.authUser?.container_id ?? null : null;
```

### ✅ 正确：存储超限检查

```typescript
// src/auth/container.ts
export function isContainerOverLimit(containerId: number): boolean {
  const tier = store.getContainerTier(containerId) ?? 1;
  const limitBytes = CONTAINER_TIER_LIMITS[tier as ContainerTier];
  return getContainerStorageSize(containerId) > limitBytes;
}
```

### ❌ 严禁：超限时不阻止写入

```typescript
// ❌ 禁止 —— 不检查容器存储限制就写入数据
router.post('/crash-report', (req, res) => {
  // 缺少 enforceContainerSizeLimit 中间件
  store.createReport(input, ...);
});
```
