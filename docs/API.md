# API 参考 (API Reference)

> Base URL: `http://localhost:8080/api/v1` | 完整文档: `/web/api-doc`

---

## 鉴权

所有写入端点需要 API 密钥；查询/管理端点需要会话 Cookie。

```
# API 密钥认证
Authorization: Bearer crs_xxxxxxxxxxxxxxxx
X-API-Key: crs_xxxxxxxxxxxxxxxx

# 会话认证
Cookie: auth_token=xxx; csrf_token=yyy
X-CSRF-Token: yyy  (修改操作必须)
```

---

## 响应格式

```json
// 成功
{ "success": true, "data": { ... } }

// 成功（分页）
{ "success": true, "data": [...], "total": 100, "page": 1, "page_size": 20 }

// 错误
{ "success": false, "error": "描述", "code": "ERROR_CODE" }
```

---

## 端点索引

### 崩溃接收

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/crash-report` | API Key | 通用崩溃上报 (JSON/multipart) |
| POST | `/unity/crash-report` | API Key | Unity 专属 (自动设 runtime=unity) |

### 源码

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/project-sources` | API Key | 上传源码快照 (.tar.gz 或散文件) |
| POST | `/source-dedup` | Session + CSRF(admin) | 源码去重扫荡 |

按容器 Tier 限制：T1 10 文件 / 2 MB，T2 500 文件 / 200 MB，T3 50000 文件 / 5 GB，T4/T5 无 Tier 限制（仅受 `MAX_SOURCE_FILES` / `MAX_SOURCE_ARCHIVE_SIZE` 服务器全局上限约束）。

**上传去重**：同一项目、同一路径下内容与最新版本完全一致的文件跳过处理（响应 `deduplicated` 列出跳过的路径）；内容有改动则写入新行（小改动只存补丁 `accepted[].storage` 为 `patch`，大改动完整存储 `full`），旧行保留作历史备份；新增路径直接入库。全部文件都被去重时不再创建快照，响应 `snapshot_id` 为 `null`。

**源码匹配**：崩溃分析（`GET /crash-reports/:id/analysis` 与 AI 助手）总是读取项目的「当前状态」——每个路径跨快照的最新一行，因此变更文件按新内容匹配、未变文件不丢失、新增文件立即参与。`match_type`（`exact`/`latest`）仍描述匹配到的快照（按 release 精确优先，否则最新）。

**去重扫荡** `POST /source-dedup`：服务器启动时自动执行一次，也可手动调用。回填旧数据哈希、删除 (项目, 路径, 内容) 完全重复的行（保留最新，删除前先物化引用它的补丁行）、清理孤儿磁盘文件。响应：`{ success, hashes_backfilled, duplicates_removed, disk_files_removed, orphans_removed }`。

### 玩家反馈

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/player-feedback` | API Key | 提交反馈 |
| GET | `/player-feedback` | Session | 反馈列表 |
| GET | `/player-feedback/:id` | Session | 反馈详情 |
| PUT | `/player-feedback/:id/status` | Session + CSRF | 更新状态 |
| DELETE | `/player-feedback/:id` | Session + CSRF(admin) | 删除反馈 |
| GET | `/download/player-feedback/attachment/:id` | Session | 下载附件 |

### 崩溃查询

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/crash-groups` | Session | 崩溃分组列表 (分页+筛选) |
| GET | `/crash-groups/:id` | Session (admin/operator) | 分组详情 + 近期报告 |
| PUT | `/crash-groups/:id/status` | Session + CSRF | 更新状态 (open/resolved/ignored) |
| GET | `/crash-reports` | Session (admin/operator) | 报告列表 |
| GET | `/crash-reports/:id` | Session (admin/operator) | 报告详情 + 附件 |
| GET | `/crash-reports/:id/analysis` | Session (admin/operator) | 崩溃分析 |
| GET | `/crash-reports/:id/symbolication` | Session (admin/operator) | 符号化信息 |

### 导出/导入

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/export/group/:id` | Session (admin/operator) | 导出 .crashpkg |
| POST | `/import?confirm=true` | Session + CSRF | 导入 .crashpkg |

### 统计与工具

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/stats/dashboard` | Session | 仪表盘数据 |
| GET | `/projects` | Session | 项目列表 |
| GET | `/platforms` | Session | 平台列表 |
| GET | `/versions` | Session | 版本列表 |
| POST | `/clear-crashes` | Session + CSRF(admin) | 清空崩溃数据 |

### 符号

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/symbols` | Session (admin/operator) | 上传符号文件 |
| GET | `/symbols` | Session | 符号列表 |
| GET | `/symbols/:id/download` | Session (admin/operator) | 下载符号 |
| DELETE | `/symbols/:id` | Session + CSRF(admin) | 删除符号 |

### 下载

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/download/attachment/:id` | Session (admin/operator) | 下载附件 |
| GET | `/download/report/:id` | Session (admin/operator) | 下载报告 JSON |
| GET | `/download/group/:id` | Session (admin/operator) | 下载分组 JSON |
| GET | `/download/dump/:reportId` | Session (admin/operator) | 下载 dump 解析 JSON |

### AI 崩溃助手

AI 功能仅对 session 登录的 `admin` / `operator` 开放。每个用户在 Accounts 页面配置自己的 DeepSeek API Key；Key 不会返回给浏览器，服务端使用 `AI_ENCRYPTION_KEY` 加密保存。请求只读取当前用户有权访问的崩溃、确定性分析和通过 API 上传的源码快照；没有源码时只基于崩溃信息推断。

AI 以 **Agent 循环**运行：模型可调用工具逐步分析——

| 工具 | 说明 | 安全边界 |
|------|------|----------|
| `read_source_file` | 读取绑定项目已上传的源码（路径/行号范围/列表） | 仅限 DB 中的 `relative_path`，不接受文件系统路径 |
| `web_fetch` | 抓取公开网页（官方文档/规范） | SSRF 防护：连接时校验 IP，拦截私网/环回/链路本地/元数据地址，限制跳数与响应体积 |
| `run_bash` | 在每会话独立工作目录复现问题 | 默认关闭（`AI_BASH_ENABLED=true` 开启）；超时 30s、输出上限、最小环境变量、无网络隔离 |
| `update_tasks` | 维护自身任务列表 | 任务列表加密持久化，跨轮次可见 |
| `spawn_subagent` | 派子 Agent 调查子问题 | 每轮最多 4 个、无嵌套、无 bash，步数计入总预算 |

循环步数上限 `AI_MAX_TOOL_STEPS`（默认 12）。Agent 循环会倍增 provider 调用次数，受每用户 `AI_RATE_LIMIT`（20/分钟）约束。

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/auth/ai-provider` | Session + admin/operator | 返回 provider 状态，不返回 Key |
| PUT | `/auth/ai-provider` | Session + CSRF + admin/operator | 保存/替换 DeepSeek Key |
| DELETE | `/auth/ai-provider` | Session + CSRF + admin/operator | 删除当前用户 provider |
| GET | `/ai/status` | Session + admin/operator | 查询 AI 可用状态 |
| GET | `/ai/crash-context/:groupId` | Session + admin/operator | 查询授权崩溃摘要 |
| GET | `/ai/conversations` | Session + admin/operator | 列出当前用户未过期会话 |
| POST | `/ai/conversations` | Session + CSRF + admin/operator | 创建可选崩溃绑定会话 |
| GET | `/ai/conversations/:id` | Session + admin/operator | 读取自己的会话和消息 |
| DELETE | `/ai/conversations/:id` | Session + CSRF + admin/operator | 删除自己的会话 |
| POST | `/ai/conversations/:id/messages` | Session + CSRF + admin/operator | 发送消息并调用 DeepSeek |

会话默认保留 30 天，仅创建者可见；消息正文与 Agent 事件（工具调用/结果、子 Agent 轨迹、任务更新）使用 AES-256-GCM 加密保存，并受每用户限流、消息长度和会话消息数量限制。

`GET /ai/conversations/:id` 响应包含 `messages`、`events`（Agent 事件，`message_id` 关联到助手消息，`group_id` 嵌套子 Agent 内的事件）、`tasks`（最新任务列表）。`POST /ai/conversations/:id/messages` 以 SSE 流式返回：`delta` / `reasoning`（最终答案与思考）、`tool_call` `{id, name, args, group}`、`tool_result` `{id, name, status, ok, summary, group}`、`subagent` `{id, status, prompt, summary, group}`、`tasks` `{tasks}`、`done` `{message, context, key_id, tasks}`、`error` `{error, message}`。


| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/setup-status` | 检查是否已初始化 |
| POST | `/setup` | 初始化 UltraAdmin |
| POST | `/login` | 登录 (返回 auth_token cookie，或 `email_verification` / `two_factor` 下一步) |
| POST | `/login/verify-email` | 登录邮箱验证步骤（仅 admin，开启开关后） |
| POST | `/login/resend-email` | 重发登录邮箱验证码 |
| POST | `/login/totp` | TOTP 登录验证步骤（仅 admin） |
| POST | `/logout` | 登出 |
| GET | `/me` | 当前用户信息 (含 verify_email_on_login / has_verified_email) |
| POST | `/2fa/challenge` | 发起 2FA 挑战 (账户操作) |
| POST | `/2fa/verify` | 验证 2FA (设置 MFA cookie) |
| POST | `/2fa/resend` | 重发操作 2FA 验证码 |
| PATCH | `/me/two-factor-method` | 切换 2FA 方法 (账户操作) |
| PATCH | `/me/verify-email-on-login` | 开关「每次登录邮箱验证」(admin) |
| GET | `/users` | 用户列表 (admin) |
| POST | `/users` | 创建用户 (admin) |
| PATCH | `/users/:id` | 更新用户 (admin) |
| PUT | `/users/:id/password` | 修改密码 |
| GET/POST/DELETE | `/me/emails*` | 邮箱管理 |
| GET/POST/DELETE | `/me/phones*` | 手机管理 |
| GET/POST/DELETE | `/me/totp*` | TOTP 管理 (admin) |
| GET | `/api-keys` | API 密钥列表 |
| POST | `/api-keys` | 创建 API 密钥 |
| DELETE | `/api-keys/:id` | 撤销 API 密钥 |
| PUT | `/api-keys/:id/tier` | 修改密钥层级 (admin) |
| PUT | `/api-keys/:id/limits` | 修改密钥配额 (admin) |
| POST | `/forgot-password` | 发起密码重置 |
| GET | `/reset-request/:token` | 查看重置请求 (admin) |
| POST | `/reset-request/:token/approve` | 审批重置 (admin) |
| GET/POST | `/containers*` | 容器管理 (UltraAdmin) |
| GET | `/csrf` | 获取 CSRF token |

---

## 状态码

| 码 | 说明 |
|----|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求错误（验证失败） |
| 401 | 未认证 |
| 403 | 无权限 / CSRF 无效 / 容器封禁 / 存储超限 |
| 404 | 资源不存在 |
| 409 | 冲突（重复创建） |
| 413 | 文件太大 |
| 429 | 请求过多（限流） |
| 500 | 服务器错误 |

---

## 实例代码

### ✅ 正确：崩溃上报

```bash
curl -X POST http://localhost:8080/api/v1/crash-report \
  -H "X-API-Key: crs_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "exception_type": "NullReferenceException",
    "exception_message": "Object reference not set",
    "stack_trace": "at Game.Update () [0x00000] in /Assets/Game.cs:42",
    "runtime": "unity",
    "platform": "Android",
    "app_version": "1.2.3"
  }'
```

### ❌ 严禁

```bash
# ❌ 禁止 —— API 密钥暴露在 URL 参数中
curl "http://localhost:8080/api/v1/crash-report?api_key=crs_xxx"

# ❌ 禁止 —— 修改操作不带 CSRF token
curl -X POST http://localhost:8080/api/v1/auth/users \
  -H "Content-Type: application/json" \    # ❌ 缺少 X-CSRF-Token 头
  -d '{"username":"user"}'
```

### ✅ 正确：带 CSRF 的修改操作

```bash
# 1. 登录获取 token
curl -c cookies.txt -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}'

# 2. 获取 CSRF token
curl -b cookies.txt http://localhost:8080/api/v1/auth/csrf

# 3. 修改操作带 CSRF
curl -b cookies.txt -X PUT http://localhost:8080/api/v1/crash-groups/7/status \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <token_from_step_2>" \
  -d '{"status":"resolved"}'
```
