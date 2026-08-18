# Crash Report Server

基于 Express 5、TypeScript 和 SQLite 的跨平台崩溃收集服务。支持项目分类、崩溃去重、源码快照分析、Unity 符号化、Dump 解析、玩家反馈和 Web 管理后台。

## 功能

- JSON 或 multipart 崩溃上报，支持最多 10 个附件
- 按 `project_name` 分类崩溃；未传项目名的旧客户端显示为 `Unassigned`
- 相同崩溃在不同项目中独立分组
- 上传散装源码或 `.tar.gz`/`.tgz` 项目快照
- Crash Analysis 定位真实崩溃代码、函数定义和可能的调用位置
- release 精确匹配源码；没有对应版本时回退项目最新快照
- C#、C/C++、Go、Python、JavaScript/TypeScript、Java/Kotlin、Rust、Ruby、PHP、Swift、Dart、Elixir/Erlang、Lua 堆栈解析
- Unity SymbolMap、ELF 和 dSYM 符号化
- Android tombstone、iOS crash、Windows minidump、Unity log 解析
- 用户角色、Session、CSRF、分级 API Key 和审计日志

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
SHA256(exception_type | first_stack_frame | runtime [| normalized_project_name])[0:16]
```

- 提供 `project_name` 时，项目名参与 hash；不同项目不会混组。
- 不提供 `project_name` 时，继续使用旧版 hash 公式，兼容已有客户端和历史分组。
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
    { "path": "src/service.ts", "file_size": 2048, "language": "typescript" }
  ],
  "skipped": [
    { "path": "assets/logo.png", "reason": "binary content" }
  ]
}
```

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

- `detected_language`
- `file_tree`
- `trigger_point`
- `stack_chain`
- `summary`
- 有匹配源码时的 `source_analysis`

`source_analysis` 包含：

```json
{
  "project_name": "api-gateway",
  "requested_release": "abc1234",
  "snapshot_release": "abc1234",
  "snapshot_id": 9,
  "match_type": "exact",
  "crash_source": {
    "file_path": "src/service.ts",
    "line_number": 42,
    "function_name": "loadUser",
    "snippet": "   42 | ..."
  },
  "function_definition": {},
  "references": [],
  "warnings": []
}
```

`match_type=latest` 表示没有与报告 `release` 精确匹配的快照，分析使用了该项目最新源码。函数定义和引用是启发式文本匹配结果，最多返回 20 个引用。

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

### 11. 账户和 API Key

前缀均为 `/api/v1/auth`：

```http
POST   /login
POST   /logout
GET    /me
GET    /csrf
POST   /forgot-password
POST   /reset-password
GET    /users
POST   /users
PATCH  /users/:id
PUT    /users/:id/password
POST   /admin-reset/:id
GET    /api-keys
POST   /api-keys
DELETE /api-keys/:id
PATCH  /api-keys/:id/tier
PATCH  /api-keys/:id/limits
```

具体可用操作由 admin/operator/viewer 角色限制。API Key tier 为 `admin`、`operator`、`viewer`。管理员创建时可传 `minute_limit` 和 `daily_limit`，或通过 `PATCH /api-keys/:id/limits` 更新二者；值必须是 0 到 1000000000 的整数，`0` 表示不限量。

### 12. 数据清理和健康检查

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
| Crash Detail（含源码分析） | `/web/crashes/:groupId` |
| Player Feedback | `/web/feedback` |
| Symbols | `/web/symbols` |
| Accounts/API Keys | `/web/accounts` |
| HTML API 文档 | `/web/api-doc` |
