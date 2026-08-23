# 数据库设计 (Database)

> SQLite · WAL 模式 · 外键级联 · 版本化迁移

---

## 实体关系

```
containers
    │ 1:N
    ├── users ──┬── sessions
    │           ├── api_keys ─── api_key_usage
    │           ├── user_emails
    │           ├── user_phones
    │           ├── audit_logs (actor_user_id)
    │           ├── password_reset_tokens
    │           └── password_reset_requests
    │
    ├── crash_groups ── crash_reports ── crash_attachments
    │       │
    │       └── projects ── source_snapshots ── source_files
    │
    ├── symbols
    └── ai_provider_configs ── ai_conversations ── ai_messages
                                        └── ai_agent_events
```

---

## 17 张表

### 核心数据

| 表 | 说明 | 关键列 |
|----|------|--------|
| `crash_reports` | 崩溃报告 | exception_type, stack_trace, runtime, build_guid, symbolicated_stack |
| `crash_groups` | 崩溃分组 (按 hash) | crash_hash (UNIQUE), status (open/resolved/ignored) |

分组键 (`crash_groups.crash_hash`)：`exception_type + 完整 stack_trace + runtime + 项目名`，只有 Latest Stack Trace 内容完全相同的报告才归入同一组。服务器启动时自动重排所有报告的分组（`regroupCrashReports`）：按当前规则重算 hash、合并相同 stack 的报告、拆开旧规则下误合并的报告并删除空组（幂等）。
| `crash_attachments` | 崩溃附件 | file_path, file_size |
| `player_feedback` | 玩家反馈 | title, description, category, severity, status |
| `feedback_attachments` | 反馈附件 | file_path, file_size |

### 项目与源码

| 表 | 说明 |
|----|------|
| `projects` | 项目 (name UNIQUE) |
| `source_snapshots` | 源码快照 (project_id + release) |
| `source_files` | 源码文件 (snapshot_id + relative_path UNIQUE) |

### 源码去重 (source_files)

| 列 | 说明 |
|----|------|
| `content_hash` | 文件内容 SHA-256（去重键） |
| `parent_file_id` | 同路径上一版本的 source_files.id（补丁链，NULL = 完整存储） |
| `patch` | 变化部分 JSON：`{prefix, suffix, lines}`（公共前缀/后缀行数 + 中间替换行），空 = 完整存储 |

- 上传时与同路径最新一行的 `content_hash` 相同 → 跳过处理；全部被去重时连快照都不创建
- 同路径内容变化 → 写入新行：小改动只存 `patch`（`storage_path` 为空），否则完整存储；旧行保留作历史备份
- 崩溃分析（source match）总是读取项目「当前状态」：每个 `relative_path` 跨快照的最新一行，读取时沿 `parent_file_id` 回溯到基础文件并依次应用补丁
- 扫荡删除补丁父行前会先物化子行（写出完整内容并清空补丁链）

### 符号

| 表 | 说明 |
|----|------|
| `symbols` | 符号文件 (build_guid, symbol_type, architecture) |

### 认证

| 表 | 说明 | 关键列 |
|----|------|--------|
| `users` | 用户 | role (ultraadmin/admin/operator/viewer), totp_secret, two_factor_method |
| `sessions` | 会话 | id_hash (SHA-256), expires_at |
| `api_keys` | API 密钥 | key_hash (SHA-256), tier, minute_limit, daily_limit |
| `api_key_usage` | API 密钥配额 | (api_key_id, period_start, period_seconds) PK |
| `user_emails` | 用户邮箱 | email_verified, is_primary |
| `user_phones` | 用户手机 | phone_verified, is_primary |

### AI 助手

| 表 | 说明 |
|----|------|
| `ai_provider_configs` | 每用户的 DeepSeek 配置；API Key 只保存 AES-256-GCM 密文 |
| `ai_conversations` | 仅创建者可见的崩溃绑定会话，默认 30 天过期 |
| `ai_messages` | 会话消息；正文使用 AES-256-GCM 密文保存，外键级联删除 |
| `ai_agent_events` | Agent 活动日志（tool_call/tool_result/subagent/task_update）；`payload` 使用 AES-256-GCM 密文保存，`message_id` 关联所属助手消息（轮次结束后回填），`group_id` 嵌套子 Agent 内的事件 |

聊天数据按 owner 查询，不按容器共享；启动时清理过期会话（Agent 事件随会话级联删除）。`AI_ENCRYPTION_KEY` 更换后旧 provider/chat/事件密文无法解密，部署时必须备份并稳定保存该密钥。

### 管理

| 表 | 说明 |
|----|------|
| `containers` | 多租户容器 (name UNIQUE, tier 1-5) |
| `audit_logs` | 审计日志 (actor_user_id → users) |
| `password_reset_tokens` | 密码重置令牌 |
| `password_reset_requests` | 密码重置请求 (审批流程) |

---

## 迁移系统

迁移在 `src/database/migrations.ts` 中，通过 `schema_version` 表追踪：

| 版本 | 说明 |
|------|------|
| v1 | 基础 schema（17 表） |
| v2 | crash_reports.dump_info |
| v3 | 通用运行时字段 (runtime, framework, environment, ...) |
| v4 | IL2CPP 符号化元数据 (build_guid, symbolicated_stack) |
| v5 | API 密钥 tier |
| v6 | project_id 关联 |
| v7 | TOTP 字段 |
| v8 | 每密钥配额 (minute_limit, daily_limit) |
| v9 | 2FA 方法选择 |
| v10 | 手机号表 |
| v11 | 容器系统 + ultraadmin 角色 |
| v12 | 扩展性能索引 |
| v13 | 登录邮箱验证开关 + 非 admin 重置 TOTP |
| v14 | 修复:幂等确保 verify_email_on_login 存在 |
| v15 | 源码去重列 (content_hash, parent_file_id, patch) |
| v16 | 加密 AI provider、owner-scoped 会话和消息 |
| v17 | provider 配置可选 DeepSeek 模型 |
| v18 | 加密多 Key AI provider 存储 + reasoning 消息 |
| v19 | AI Agent 事件日志 (ai_agent_events) |

### 添加新迁移

```typescript
{
  version: 13,
  description: '描述变更内容',
  up: (db) => { /* ALTER TABLE / CREATE TABLE / CREATE INDEX */ },
}
```

---

## 索引策略

### 查询性能索引
- `crash_groups.crash_hash` — 分组 hash 查找 (UNIQUE)
- `crash_reports.group_id` — 分组关联
- `crash_reports.created_at` — 时间范围查询
- `symbols.build_guid` — 符号匹配
- `symbols.symbol_type` — 符号类型筛选

### 容器隔离索引
- 所有数据表都有 `container_id` 索引
- 支持 UltraAdmin 全量查询和普通用户容器内查询

---

## 连接配置

```typescript
// WAL 模式 — 更好的并发读
PRAGMA journal_mode = WAL;
// 外键约束 — 数据完整性
PRAGMA foreign_keys = ON;
```

数据文件: `DATA_DIR/crash_reports.db`

---

## 查询规范

### ✅ 正确：参数化查询

```typescript
// src/database/auth-store.ts
export function findUserByUsername(username: string): User | undefined {
  return getDb().prepare(
    'SELECT * FROM users WHERE username = ? COLLATE NOCASE'
  ).get(username) as User | undefined;
}

// 所有参数通过 ? 占位符传入
export function listUsersByRole(role: string, containerId: number | null): User[] {
  return getDb().prepare(
    'SELECT * FROM users WHERE role = ? AND container_id = ?'
  ).all(role, containerId) as User[];
}
```

### ❌ 严禁：字符串拼接 SQL

```typescript
// ❌ 禁止 —— SQL 注入风险
const query = `SELECT * FROM users WHERE username = '${username}'`;
db.exec(query);

// ❌ 禁止 —— 字符串模板拼接表名/列名
const column = req.query.sort_by;
db.prepare(`SELECT * FROM users ORDER BY ${column}`).all();  // ❌
```

### ✅ 正确：列名白名单验证

```typescript
// ✅ 正确 —— 排序字段使用白名单
const ALLOWED_SORTS = ['last_seen', 'first_seen', 'total_count', 'id'];
const sortBy = ALLOWED_SORTS.includes(query.sort_by) ? query.sort_by : 'last_seen';
db.prepare(`SELECT * FROM crash_groups ORDER BY ${sortBy} DESC`).all();
```

---

## 迁移添加规范

### ✅ 正确

```typescript
// src/database/migrations.ts
{
  version: 13,
  description: 'Add resolved_by column to crash_groups',
  up: (db) => {
    db.exec("ALTER TABLE crash_groups ADD COLUMN resolved_by INTEGER REFERENCES users(id)");
  },
}
```

### ❌ 严禁

```typescript
// ❌ 禁止 —— 手动在生产数据库执行 SQL
// ❌ 禁止 —— 修改已有迁移的 up() 函数（已执行的迁移不可变）
// ❌ 禁止 —— 不递增版本号
// ❌ 禁止 —— 无 description
```
