# Crash Report Server

基于 Express 5、TypeScript 和 SQLite 的跨平台崩溃收集服务。支持项目分类、崩溃去重、源码快照分析、Unity 符号化、Dump 解析、玩家反馈和 Web 管理后台。

## 功能

- JSON 或 multipart 崩溃上报，支持最多 10 个附件
- 按 `project_name` 分类崩溃；未传项目名的旧客户端显示为 `Unassigned`
- 相同崩溃在不同项目中独立分组
- 上传散装源码或 `.tar.gz`/`.tgz` 项目快照；相同内容自动去重，小改动只存补丁
- Crash Analysis 定位真实崩溃代码、函数定义和可能的调用位置
- 分析读取项目「当前状态」源码；release 精确匹配，没有对应版本时回退项目最新快照
- Python 崩溃根因分析：根因候选、修复建议、调用链（crash path）流程图
- C#、C/C++、Go、Python、JavaScript/TypeScript、Java/Kotlin、Rust、Ruby、PHP、Swift、Dart、Elixir/Erlang、Lua 堆栈解析
- Unity SymbolMap、ELF 和 dSYM 符号化
- Android tombstone、iOS crash、Windows minidump、Unity log 解析
- AI 崩溃助手：DeepSeek Agent 循环，可读源码、抓取官方文档、复现问题
- 用户角色、Session、CSRF、分级 API Key、2FA/邮箱/手机验证、容器多租户和审计日志

## 快速开始

要求 Node.js 24（Dockerfile 使用 Node 24）和 npm。

```bash
npm install

# 启动开发服务器
npm run dev
```

首次启动后，在浏览器中打开 `http://localhost:8080` 创建管理员账户。

开发服务器默认监听 `http://localhost:8080`：

- Web 后台：`/web/`
- HTML API 文档：`/web/api-doc`
- API：`/api/v1`
- 健康检查：`/health`

构建与运行：

```bash
npm run build
npm start
```

Docker Compose：

```bash
docker compose up -d --build
```

运行数据默认保存在 `data/`；SQLite 自动迁移，不需要单独运行 migration 命令。

## 鉴权和权限

### 上报 API Key

默认 `API_REQUIRE_KEY=true`。以下端点需要 operator 或 admin API Key：

- `POST /api/v1/crash-report`
- `POST /api/v1/unity/crash-report`
- `POST /api/v1/player-feedback`
- `POST /api/v1/project-sources`

支持两种请求头：

```http
Authorization: Bearer <api-key>
```

或：

```http
X-API-Key: <api-key>
```

API Key 由登录用户通过账户页面或 `/api/v1/auth/api-keys` 创建，明文只在创建响应中返回一次。管理员可为每把 Key 配置每分钟和每日调用上限，`0` 表示不限量。额度按 Key 在 SQLite 中持久化，服务重启后仍生效。viewer key 不能写入；operator/admin key 可以调用上报端点。

### 管理 API Session

查询、分析、下载、符号和管理 API 使用登录 Session Cookie。登录：

```bash
curl -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}' \
  http://localhost:8080/api/v1/auth/login
```

Cookie 认证的 `POST`、`PUT`、`PATCH`、`DELETE` 请求还需要 CSRF。登录响应已经设置 `csrf_token` Cookie，也可调用：

```bash
curl -b cookies.txt -c cookies.txt \
  http://localhost:8080/api/v1/auth/csrf
```

写请求需发送 Cookie 值对应的请求头：

```http
X-CSRF-Token: <csrf_token>
```

主要权限：

- `admin`：完整管理权限；可删除符号/反馈、管理用户、清空崩溃
- `operator`：查看崩溃详情、更新状态、管理自己的 API Key、上传符号
- `viewer`：受限只读页面与列表

## 项目分类与分组规则

当前分组 hash：

```text
SHA256(exception_type | stack_trace | runtime [| normalized_project_name])[0:16]
```

- `stack_trace` 为完整堆栈（trim 后参与 hash；缺失时用 `no-stack`），只共享异常类型或首帧不足以归入同一组。
- 提供 `project_name` 时，项目名参与 hash；不同项目不会混组。
- `project_name` 大小写不敏感，最大 100 字符。

## API 参考

Base URL：`http://localhost:8080/api/v1`

错误响应通常为：

```json
{ "error": "Bad Request", "message": "..." }
```

### 1. 提交崩溃

```http
POST /crash-report
```

支持 `application/json`，也支持 `multipart/form-data`。multipart 可以使用普通字段，或将完整 JSON 放在 `report` 字段；附件字段名为 `attachments`，最多 10 个，单文件默认最大 20 MiB。

只有 `exception_type` 必填。常用字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `exception_type` | string | 必填，异常类型 |
| `project_name` | string | 可选，项目名称；未传时为 Unassigned |
| `exception_message` | string | 异常消息 |
| `stack_trace` | string | 堆栈；超过 `MAX_LOG_SIZE` 时截断 |
| `log_text` | string | 日志；超过 `MAX_LOG_SIZE` 时截断 |
| `runtime` | string | 如 `node`、`typescript`、`python`、`go`、`unity` |
| `runtime_version` | string | 运行时版本 |
| `framework` | string | 框架/引擎 |
| `environment` | string | `production`、`staging`、`development` 等 |
| `server_name` | string | 服务或应用实例名 |
| `release` | string | 发布版本、构建版本或 Git commit；用于匹配源码快照 |
| `error_severity` | string | `warning`、`error`、`fatal`、`crash` |
| `platform` | string | 操作系统或运行平台 |
| `app_version` | string | 应用版本 |
| `build_guid` | string | Unity 符号匹配标识 |
| `custom_data` | object/string | 自定义上下文 |
| `client_timestamp` | string | ISO 8601 客户端时间 |

JSON 示例：

```bash
curl -X POST http://localhost:8080/api/v1/crash-report \
  -H "X-API-Key: <key>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_name": "api-gateway",
    "exception_type": "TypeError",
    "exception_message": "Cannot read properties of undefined",
    "stack_trace": "at loadUser (/app/src/service.ts:42:15)",
    "runtime": "typescript",
    "runtime_version": "5.9",
    "framework": "express",
    "environment": "production",
    "release": "abc1234",
    "error_severity": "error"
  }'
```

multipart 示例：

```bash
curl -X POST http://localhost:8080/api/v1/crash-report \
  -H "X-API-Key: <key>" \
  -F "project_name=my-game" \
  -F "exception_type=NullReferenceException" \
  -F "runtime=unity" \
  -F "release=build-1024" \
  -F "stack_trace=at Player.Update () in Assets/Scripts/Player.cs:42" \
  -F "attachments=@crash.dmp"
```

成功响应：

```json
{ "id": 42, "group_id": 7, "is_new_group": true }
```

### 2. 上传项目源码快照

```http
POST /project-sources
```

multipart 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `project_name` | 是 | 1–100 字符，与崩溃上报使用相同名称 |
| `release` | 否 | 最多 200 字符；建议与崩溃报告完全一致 |
| `files` | 二选一 | 可重复提交的散装源码文件，数量受 Tier 限制 |
| `archive` | 二选一 | 一个 `.tar.gz` 或 `.tgz` 项目包 |

散装文件与压缩包可以同时上传。每次成功请求创建一个不可变快照。按容器 Tier 限制：

| Tier | 文件数上限 | 总大小上限 |
|------|-----------|-----------|
| T1 | 10 | 2 MB |
| T2 | 500 | 200 MB |
| T3 | 50000 | 5 GB |
| T4 / T5 | 无 Tier 限制 | 无 Tier 限制 |

T4/T5 仅受服务器全局配置上限约束（`MAX_SOURCE_FILES`、`MAX_SOURCE_ARCHIVE_SIZE`）。通用限制：

- 任意文本文件均可上传（不限扩展名、不限语言；非 Unity 项目同样支持），未知扩展名标记为 `text`
- 单源码文件最大 2 MiB（`MAX_SOURCE_FILE_SIZE`）
- 拒绝绝对路径、`..` 路径、NUL 和二进制内容
- 只读取源码文本，不执行或编译上传代码

**上传去重**：同一项目、同一路径下内容与最新版本完全一致的文件跳过处理（响应 `deduplicated` 列出跳过的路径）；内容有改动则写入新行（小改动只存补丁 `accepted[].storage` 为 `patch`，大改动完整存储 `full`），旧行保留作历史备份；新增路径直接入库。全部文件都被去重时不再创建快照，响应 `snapshot_id` 为 `null`。

**源码匹配**：崩溃分析（`GET /crash-reports/:id/analysis` 与 AI 助手）总是读取项目的「当前状态」——每个路径跨快照的最新一行，因此变更文件按新内容匹配、未变文件不丢失、新增文件立即参与。`match_type`（`exact`/`latest`）仍描述匹配到的快照（按 release 精确优先，否则最新）。

压缩包示例：

```bash
curl -X POST http://localhost:8080/api/v1/project-sources \
  -H "X-API-Key: <key>" \
  -F "project_name=api-gateway" \
  -F "release=abc1234" \
  -F "archive=@api-gateway.tar.gz"
```

散装源码示例；使用 `filename=` 保留项目相对路径：

```bash
curl -X POST http://localhost:8080/api/v1/project-sources \
  -H "X-API-Key: <key>" \
  -F "project_name=api-gateway" \
  -F "release=abc1234" \
  -F "files=@src/app.ts;filename=src/app.ts" \
  -F "files=@src/service.ts;filename=src/service.ts"
```

响应：

```json
{
  "project": { "id": 3, "name": "api-gateway" },
  "release": "abc1234",
  "snapshot_id": 9,
  "accepted": [
    { "path": "src/service.ts", "file_size": 2048, "language": "typescript", "storage": "full" },
    { "path": "src/config.ts", "file_size": 96, "language": "typescript", "storage": "patch" }
  ],
  "deduplicated": ["src/unchanged.ts"],
  "skipped": [
    { "path": "assets/logo.png", "reason": "binary content" }
  ]
}
```

去重扫荡 `POST /source-dedup`（admin，Session + CSRF）：服务器启动时自动执行一次，也可手动调用。回填旧数据哈希、删除 (项目, 路径, 内容) 完全重复的行（保留最新，删除前先物化引用它的补丁行）、清理孤儿磁盘文件。响应：`{ success, hashes_backfilled, duplicates_removed, disk_files_removed, orphans_removed }`。

### 3. Unity 专属上报

```http
POST /unity/crash-report
```

请求字段与通用上报一致。服务自动设置 `runtime=unity`；没有 `runtime_version` 时使用 `unity_version`。请求头必须包含 Unity User-Agent，或：

```http
X-Client-Type: unity
```

同样支持 `project_name`、`release` 和 `attachments`。

### 4. 玩家反馈上报

```http
POST /player-feedback
```

JSON 必填字段为 `title` 和 `description`。可选字段：`category`、`severity`、`player_id`、`player_name`、`contact`、`app_version`、`platform`、`device_model`、`scene_name`、`custom_data`、`client_timestamp`。

- `category`：`bug`、`suggestion`、`other`
- `severity`：`low`、`normal`、`high`、`critical`
- multipart 时可将 JSON 放入 `feedback`，附件字段为 `attachments`，最多 10 个

### 5. 崩溃分组

```http
GET /crash-groups
GET /crash-groups/:id
PUT /crash-groups/:id/status
```

`GET /crash-groups` 查询参数：

| 参数 | 说明 |
|---|---|
| `page`、`page_size` | 默认 1/20；`page_size` 最大 100 |
| `project_id` | 项目 ID；`0` 只查询 Unassigned |
| `status` | `open`、`resolved`、`ignored` |
| `platform`、`app_version`、`runtime`、`environment`、`error_severity` | 通过组内报告筛选 |
| `search` | 模糊匹配异常类型或消息 |
| `start_date`、`end_date` | 按 `last_seen` 筛选 |
| `sort_by` | `last_seen`、`first_seen`、`total_count`、`created_at`、`id` |
| `sort_order` | `asc` 或 `desc` |

状态更新请求：

```json
{ "status": "resolved", "resolved_version": "1.2.5" }
```

### 6. 崩溃报告和分析

```http
GET /crash-reports
GET /crash-reports/:id
GET /crash-reports/:id/analysis
GET /crash-reports/:id/symbolication
```

`GET /crash-reports` 支持 `page`、`page_size`、`group_id`、`project_id`（`0` 为 Unassigned）、`platform`、`app_version`、`start_date`、`end_date`。

Crash Analysis 返回：

- `report_id`、`exception_type`、`exception_message`
- `detected_language`
- `file_tree`
- `trigger_point`
- `stack_chain`
- `summary`
- `crash_path`：Python 崩溃的调用链流程图（入口 → 崩溃点 → 根因节点）
- `suggestions`：Python 崩溃的修复建议（无源码时也始终返回）
- 有匹配源码时的 `source_analysis`

`source_analysis` 包含：

```json
{
  "project_name": "api-gateway",
  "requested_release": "abc1234",
  "snapshot_release": "abc1234",
  "snapshot_id": 9,
  "match_type": "exact",
  "files_scanned": 24,
  "crash_source": {
    "file_path": "src/service.ts",
    "line_number": 42,
    "function_name": "loadUser",
    "snippet": "   42 | ..."
  },
  "function_definition": {
    "file_path": "src/service.ts",
    "line_number": 35,
    "function_name": "loadUser",
    "snippet": "   35 | ..."
  },
  "references": [],
  "related_functions": [],
  "related_files": [],
  "warnings": [],
  "root_cause_candidates": [],
  "fixes": [],
  "crash_path": []
}
```

- `related_functions` / `related_files`：调用者/被调用者等关联函数与文件（启发式文本匹配，最多 20 个引用）。
- `root_cause_candidates` / `fixes` / `dependency_summary`：仅当崩溃语言为 Python 且快照含 Python 源码时返回（根因候选带 `confidence`、`evidence` 和 `is_conclusive` 确定性标记）。
- `match_type=latest` 表示没有与报告 `release` 精确匹配的快照，分析使用了该项目最新源码（当前状态）。

### 7. 项目和统计

```http
GET /projects
GET /platforms
GET /versions
GET /stats/dashboard
```

`GET /projects` 返回项目和每个项目的崩溃报告数：

```json
[
  {
    "id": 3,
    "name": "api-gateway",
    "crash_count": 42,
    "created_at": "2026-07-31 10:00:00",
    "updated_at": "2026-07-31 10:00:00"
  }
]
```

Dashboard 统计包括总数、状态、今日/近七天计数、Top 崩溃、平台/版本/runtime/environment 分布和 30 天趋势。

### 8. 符号文件

```http
POST   /symbols
GET    /symbols
GET    /symbols/:id/download
DELETE /symbols/:id
```

上传字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `file` | 是 | 最大 500 MiB |
| `build_guid` | 是 | 与崩溃报告匹配 |
| `platform` | 否 | 默认 `unknown` |
| `symbol_type` | 否 | `symbol_map`、`elf`、`dsym`、`unknown`；默认按文件名识别 |
| `module_name` | 否 | 模块名称 |
| `architecture` | 否 | 如 `arm64`、`x86_64` |

列表支持 `page`、`page_size`（最大 200）、`platform`、`build_guid`。

### 9. 玩家反馈管理

```http
GET    /player-feedback
GET    /player-feedback/:id
PUT    /player-feedback/:id/status
DELETE /player-feedback/:id
```

列表支持 `page`、`page_size`、`status`、`category`、`search`。删除仅限 admin。

### 10. 下载、导出和导入

```http
GET  /download/report/:id
GET  /download/group/:id
GET  /download/dump/:reportId
GET  /download/attachment/:id
GET  /download/player-feedback/attachment/:id
GET  /export/group/:id
POST /import?confirm=false
POST /import?confirm=true
```

`.crashpkg` 是 tar.gz，包含 manifest、报告 JSON 和附件。导入时先使用 `confirm=false` 检查冲突，再用 `confirm=true` 写入。新格式携带项目名；旧数据包仍可导入。

### 11. 账户、安全验证和 API Key

前缀均为 `/api/v1/auth`：

```http
GET    /setup-status
POST   /setup
POST   /login
POST   /login/verify-email
POST   /login/resend-email
POST   /login/totp
POST   /logout
GET    /me
GET    /csrf
POST   /2fa/challenge
POST   /2fa/verify
POST   /2fa/resend
PATCH  /me/two-factor-method
PATCH  /me/verify-email-on-login
GET    /users
POST   /users
PATCH  /users/:id
PUT    /users/:id/password
GET    /me/emails
POST   /me/emails
POST   /me/emails/:id/verify
POST   /me/emails/:id/primary
POST   /me/emails/:id/resend
DELETE /me/emails/:id
GET    /me/phones
POST   /me/phones
POST   /me/phones/:id/verify
POST   /me/phones/:id/primary
POST   /me/phones/:id/resend
DELETE /me/phones/:id
GET    /me/totp/setup
POST   /me/totp/enable
POST   /me/totp/disable
POST   /forgot-password
POST   /forgot-password/totp
POST   /forgot-password/verify-email
GET    /reset-request/:token
POST   /reset-request/:token/approve
GET    /api-keys
POST   /api-keys
DELETE /api-keys/:id
PATCH  /api-keys/:id/tier
PATCH  /api-keys/:id/limits
GET    /containers
POST   /containers
GET    /containers/:id/status
POST   /containers/:id/ban
POST   /containers/:id/unban
DELETE /containers/:id
POST   /containers/:id/users
GET    /containers/active
```

具体可用操作由 admin/operator/viewer 角色限制；`/containers*` 仅 UltraAdmin。登录支持邮箱验证（`/login/verify-email`）和 TOTP（`/login/totp`）两步流程；账户敏感操作通过 `/2fa/*` 发起挑战。API Key tier 为 `admin`、`operator`、`viewer`。管理员创建时可传 `minute_limit` 和 `daily_limit`，或通过 `PATCH /api-keys/:id/limits` 更新二者；值必须是 0 到 1000000000 的整数，`0` 表示不限量。

### 12. AI 崩溃助手

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

```http
GET    /auth/ai-provider
PUT    /auth/ai-provider
DELETE /auth/ai-provider
GET    /auth/ai-provider/keys
POST   /auth/ai-provider/keys
PATCH  /auth/ai-provider/keys/:id
DELETE /auth/ai-provider/keys/:id
GET    /ai/status
GET    /ai/crashes
GET    /ai/crash-context/:groupId
GET    /ai/conversations
POST   /ai/conversations
POST   /ai/conversations/:id/attach
GET    /ai/conversations/:id
DELETE /ai/conversations/:id
POST   /ai/conversations/:id/messages
```

会话默认保留 30 天，仅创建者可见；消息正文与 Agent 事件（工具调用/结果、子 Agent 轨迹、任务更新）使用 AES-256-GCM 加密保存，并受每用户限流、消息长度和会话消息数量限制。

`POST /ai/conversations/:id/messages` 以 SSE 流式返回：`delta` / `reasoning`（最终答案与思考）、`tool_call` `{id, name, args, group}`、`tool_result` `{id, name, status, ok, summary, group}`、`subagent` `{id, status, prompt, summary, group}`、`tasks` `{tasks}`、`done` `{message, context, key_id, tasks}`、`error` `{error, message}`。

### 13. 数据清理和健康检查

```http
POST /clear-crashes
GET  /health
```

`POST /clear-crashes` 仅限 admin，会删除崩溃组、报告和崩溃附件，操作不可逆。

健康响应：

```json
{ "status": "ok" }
```

## 源码支持类型

源码快照接受以下文本扩展名：

- C#：`.cs`
- C/C++：`.c`、`.h`、`.cpp`、`.cc`、`.cxx`、`.hpp`、`.hh`
- Go：`.go`
- Python：`.py`
- JavaScript/TypeScript：`.js`、`.mjs`、`.cjs`、`.jsx`、`.ts`、`.tsx`
- Java/Kotlin：`.java`、`.kt`
- Rust：`.rs`
- Ruby：`.rb`
- PHP：`.php`
- Swift：`.swift`
- Dart：`.dart`
- Elixir/Erlang：`.ex`、`.exs`、`.erl`
- Lua：`.lua`

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` | `8080` | HTTP 端口 |
| `DATA_DIR` | `<repo>/data` | 数据根目录 |
| `DB_PATH` | `<DATA_DIR>/crash_reports.db` | SQLite 文件 |
| `SYMBOLS_DIR` | `<DATA_DIR>/symbols` | 符号文件目录 |
| `ATTACHMENTS_DIR` | `<DATA_DIR>/attachments` | 崩溃/反馈附件目录 |
| `SOURCES_DIR` | `<DATA_DIR>/sources` | 源码快照文件目录 |
| `MAX_LOG_SIZE` | `10485760` | stack/log 最大字符数，超出截断 |
| `MAX_ATTACHMENT_SIZE` | `20971520` | 单附件最大字节数 |
| `MAX_SOURCE_FILE_SIZE` | `2097152` | 单源码文件最大字节数 |
| `MAX_SOURCE_ARCHIVE_SIZE` | `5368709120` | 源码上传及解包总上限（T4/T5 及无 Tier 容器的硬上限） |
| `MAX_SOURCE_FILES` | `50000` | 单快照最大源码文件数（T4/T5 及无 Tier 容器的硬上限） |
| `MAX_JSON_BODY_SIZE` | `12582912` | JSON body 最大字节数 |
| `COOKIE_SECURE` | 生产环境 `true` | 认证 Cookie 是否仅 HTTPS |
| `SESSION_HOURS` | `12` | Session 有效期 |
| `API_REQUIRE_KEY` | `true` | 上报端点是否要求 API Key |
| `CORS_ORIGINS` | 空 | 允许的浏览器 Origin，逗号分隔 |
| `TRUST_PROXY` | `false` | Express trust proxy |
| `LOGIN_RATE_LIMIT` | `150` | 每 5 分钟、每 IP+用户名登录尝试数 |
| `INGEST_RATE_LIMIT` | `120` | 每 IP 每分钟上报请求数 |
| `API_RATE_LIMIT` | `600` | 每 IP 每分钟管理 API 请求数 |
| `WEBHOOK_URL` | 空 | Webhook 告警地址 |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Webhook 超时毫秒数 |
| `ALERT_ON_NEW_GROUP` | `true` | 新分组时告警 |
| `ALERT_THRESHOLD_COUNT` | `10` | 次数阈值告警 |
| `SMTP_HOST` 等 | 空 | SMTP 和邮件告警配置 |
| `AI_ENCRYPTION_KEY` | 空 | AI 数据加密密钥；未配置时 AI 功能不可用 |
| `AI_DEEPSEEK_MODEL` | `deepseek-chat` | AI 默认模型 |
| `AI_DEEPSEEK_ENDPOINT` | `https://api.deepseek.com/chat/completions` | DeepSeek API 地址 |
| `AI_RATE_LIMIT` | `20` | 每用户每分钟 AI 请求数 |
| `AI_MAX_TOOL_STEPS` | `12` | Agent 循环最大工具步数 |
| `AI_MAX_CONVERSATIONS` | `50` | 每用户最大会话数 |
| `AI_MAX_MESSAGES_PER_CONVERSATION` | `100` | 每会话最大消息数 |
| `AI_RETENTION_DAYS` | `30` | 会话保留天数 |
| `AI_BASH_ENABLED` | `false` | 是否启用 `run_bash` 工具 |
| `AI_BASH_TIMEOUT_MS` | `30000` | `run_bash` 超时毫秒数 |
| `AI_BASH_MAX_OUTPUT` | `65536` | `run_bash` 输出上限字节数 |
| `AI_SUBAGENT_MAX` | `4` | 每轮最大子 Agent 数 |
| `AI_SUBAGENT_MODEL` | 空 | 子 Agent 使用的模型（默认跟随主模型） |
| `AI_MESSAGE_MAX_LENGTH` | `10000` | 单条 AI 消息最大字符数 |
| `AI_HISTORY_MAX_CHARS` | `40000` | 发送给模型的历史消息字符上限 |
| `AI_CONTEXT_MAX_CHARS` | `120000` | 崩溃上下文字符上限 |
| `AI_SOURCE_MAX_FILES` | `20` | 提供给 AI 的源码文件数上限 |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | DeepSeek 请求超时毫秒数 |
| `AI_WEB_FETCH_TIMEOUT_MS` / `AI_WEB_FETCH_MAX_BYTES` | 空 | `web_fetch` 工具超时与响应体积上限 |
| `AI_TOOL_RESULT_MAX_CHARS` | 空 | 工具结果回传模型的字符上限 |

## 数据目录

```text
data/
├── crash_reports.db
├── attachments/
├── symbols/
└── sources/
```

数据库保存用户、Session、API Key、审计日志、项目、源码快照元数据、崩溃、反馈和符号记录；上传的二进制/源码文件保存在对应目录。备份时应同时备份整个 `DATA_DIR`。

## Web 页面

| 页面 | 路径 |
|---|---|
| Dashboard | `/web/` |
| Crashes（含项目筛选） | `/web/crashes` |
| Crash Detail（含源码分析、AI 助手） | `/web/crashes/:groupId` |
| Player Feedback | `/web/feedback` |
| Symbols | `/web/symbols` |
| Accounts/API Keys | `/web/accounts` |
| Containers（UltraAdmin） | `/web/containers` |
| HTML API 文档 | `/web/api-doc` |
