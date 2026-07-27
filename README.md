# 💥 Crash Report Server

轻量级 Unity 错误上报服务器 — 接收 Unity 游戏客户端提交的崩溃/异常报告，自动去重分组，提供 Web 管理后台用于查看、搜索和管理崩溃。

---

## 目录

- [快速开始](#快速开始)
- [架构设计](#架构设计)
- [去重策略](#去重策略)
- [API 参考](#api-参考)
  - [提交崩溃报告](#1-提交崩溃报告)
  - [查询崩溃分组列表](#2-查询崩溃分组列表)
  - [查询崩溃分组详情](#3-查询崩溃分组详情)
  - [更新崩溃分组状态](#4-更新崩溃分组状态)
  - [查询单条报告列表](#5-查询单条报告列表)
  - [查询单条报告详情](#6-查询单条报告详情)
  - [仪表盘统计](#7-仪表盘统计)
  - [获取平台列表](#8-获取平台列表)
  - [获取版本列表](#9-获取版本列表)
  - [上传符号文件](#10-上传符号文件)
  - [查询符号文件列表](#11-查询符号文件列表)
  - [删除符号文件](#12-删除符号文件)
  - [健康检查](#13-健康检查)
- [Unity 客户端集成](#unity-客户端集成)
- [Web 管理后台](#web-管理后台)
- [配置参考](#配置参考)
- [部署指南](#部署指南)
- [项目结构](#项目结构)

---

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- npm >= 9

### 本地开发

```bash
# 1. 进入项目目录
cd e:/Server

# 2. 安装依赖
npm install

# 3. 启动开发服务器（tsx 热重载）
npm run dev
```

启动后输出：

```
📁 Database: E:\Server\data\crash_reports.db
🔑 Auth token: <随机生成的32位hex>

  🚀 Crash Report Server is running!
  📡 API:  http://localhost:8080/api/v1/
  🌐 Web:  http://localhost:8080/web/
  ❤️  Health: http://localhost:8080/health

  Unity client usage:
    POST http://your-server:8080/api/v1/crash-report
```

### Docker 部署

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

数据通过 Docker volume `crash_data` 持久化，重启不会丢失。

---

## 架构设计

```
Unity Game Client ──HTTP POST──▶  Express Server (port 8080)
                                      │
                          ┌───────────┼───────────┐
                          ▼                       ▼
                    /api/v1/*  REST API      /web/*  管理后台
                          │                 (内嵌 HTML 模板)
                          ▼
                     SQLite (WAL 模式)
                   crash_reports.db
                          │
                    ┌─────┴──────┐
                    ▼            ▼
              crash_reports   symbols/
              crash_groups    attachments/
```

- **后端**: Express 5 + TypeScript，编译为 ES Module
- **数据库**: SQLite（WAL 模式，支持并发读），零配置，单文件存储
- **前端**: 服务端渲染 HTML 模板 + Alpine.js + Chart.js + Tailwind CSS CDN
- **部署**: 多阶段 Docker 构建，最终镜像约 200MB

---

## 去重策略

服务器使用 **SHA256 前 16 位 hex** 作为崩溃分组的 hash，计算逻辑如下：

```
crash_hash = SHA256(exception_type + "|" + first_stack_frame + "|" + platform)[0:16]
```

**提取第一帧堆栈**的规则（`service.ts`）：

| 堆栈格式 | 提取结果 | 示例 |
|----------|----------|------|
| `at Class.Method () [0x…]` | `Class.Method` | Unity IL2CPP / Mono |
| `#00 pc 0x… libunity.so (Class::Method)` | `Class::Method` | Android Native |
| 无法匹配任何模式 | 堆栈第一行前 120 个字符 | 兜底策略 |
| 空堆栈 | `no-stack` | 无堆栈信息 |

相同 hash 的崩溃会自动归入同一 `crash_group`，新报告到达时：
- 该 group 的 `last_seen` 更新为当前时间
- `total_count` 自增 1
- 设备型号、内存大小等差异字段不影响分组

---

## API 参考

### 基础信息

- **Base URL**: `http://<host>:8080/api/v1`
- **Content-Type**: `application/json`（上传文件时使用 `multipart/form-data`）
- **响应格式**: 所有成功响应为 JSON；错误响应格式为 `{ "error": "...", "message": "..." }`

---

### 1. 提交崩溃报告

```
POST /api/v1/crash-report
```

接收 Unity 客户端上报的崩溃/异常报告。支持三种提交方式。

#### 方式一：纯 JSON（推荐）

```bash
curl -X POST http://localhost:8080/api/v1/crash-report \
  -H "Content-Type: application/json" \
  -d '{
    "exception_type": "NullReferenceException",
    "exception_message": "Object reference not set to an instance of an object",
    "stack_trace": "at PlayerController.Update () [0x00000] in <game>:0\n  at UnityEngine.MonoBehaviour.Update () [0x00000]",
    "log_text": "Unity Player.log full content here...",
    "unity_version": "2022.3.10f1",
    "platform": "Android",
    "device_model": "Samsung Galaxy S23",
    "os_version": "Android 14",
    "gpu_name": "Adreno 740",
    "cpu_name": "Snapdragon 8 Gen 2",
    "memory_mb": 8192,
    "app_version": "1.2.3",
    "bundle_id": "com.example.game",
    "scene_name": "Level_01",
    "custom_data": {"user_id": "abc123", "session_id": "sess-001"},
    "client_timestamp": "2026-07-27T12:00:00Z"
  }'
```

#### 方式二：Multipart 表单字段

适用于不需要上传附件的表单提交：

```bash
curl -X POST http://localhost:8080/api/v1/crash-report \
  -F "exception_type=NullReferenceException" \
  -F "exception_message=Something went wrong" \
  -F "stack_trace=at EnemyAI.Update () [0x00000]" \
  -F "platform=Windows" \
  -F "app_version=1.0.0"
```

#### 方式三：Multipart + JSON + 附件

适用于需要附带截图、日志文件等附件的场景：

```bash
curl -X POST http://localhost:8080/api/v1/crash-report \
  -F 'report={"exception_type":"NullReferenceException","stack_trace":"at Foo ()","platform":"Android"};type=application/json' \
  -F 'attachments=@screenshot.png' \
  -F 'attachments=@player.log'
```

**表单字段说明**：`report` 为 JSON 字符串，`attachments` 为文件字段（可重复最多 10 个）。

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `exception_type` | string | **是** | 异常类型，如 `NullReferenceException` |
| `exception_message` | string | 否 | 异常消息 |
| `stack_trace` | string | 否 | 完整堆栈跟踪（超过 10MB 自动截断） |
| `log_text` | string | 否 | Unity Player.log 完整日志内容（超过 10MB 自动截断） |
| `unity_version` | string | 否 | Unity 版本号，如 `2022.3.10f1` |
| `platform` | string | 否 | 运行平台：`Android` / `iOS` / `Windows` / `Mac` / `WebGL` / `Linux` |
| `device_model` | string | 否 | 设备型号，如 `Samsung Galaxy S23` |
| `os_version` | string | 否 | 操作系统版本，如 `Android 14` |
| `gpu_name` | string | 否 | GPU 名称 |
| `cpu_name` | string | 否 | CPU 名称 |
| `memory_mb` | number | 否 | 设备内存（MB） |
| `app_version` | string | 否 | 应用版本号，如 `1.2.3` |
| `bundle_id` | string | 否 | 包名，如 `com.example.game` |
| `scene_name` | string | 否 | 发生崩溃的场景名称 |
| `custom_data` | object/string | 否 | 自定义数据（JSON 对象或字符串） |
| `client_timestamp` | string | 否 | 客户端崩溃时间（ISO 8601 格式） |

#### 成功响应 — `201 Created`

```json
{
  "id": 42,
  "group_id": 7,
  "is_new_group": true
}
```

| 字段 | 说明 |
|------|------|
| `id` | 本条崩溃报告的 ID |
| `group_id` | 所属崩溃分组的 ID |
| `is_new_group` | `true` 表示新建了分组（首次出现），`false` 表示归入已有分组 |

#### 错误响应

```json
// 400 — 缺少必填字段
{ "error": "Bad Request", "message": "exception_type is required and must be a string" }

// 400 — JSON 解析失败
{ "error": "Bad Request", "message": "Invalid JSON in request body" }

// 500 — 服务器内部错误
{ "error": "Internal Server Error", "message": "..." }
```

---

### 2. 查询崩溃分组列表

```
GET /api/v1/crash-groups
```

分页查询所有崩溃分组，支持多条件筛选和排序。

#### 查询参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | 1 | 页码 |
| `page_size` | number | 20（最大 100） | 每页条数 |
| `status` | string | — | 筛选状态：`open` / `resolved` / `ignored` |
| `search` | string | — | 搜索异常类型或异常消息（模糊匹配） |
| `platform` | string | — | 筛选平台（通过 group 关联的 report 间接筛选） |
| `app_version` | string | — | 筛选应用版本 |
| `start_date` | string | — | 起始日期（`last_seen >=`），格式 `YYYY-MM-DD` |
| `end_date` | string | — | 截止日期（`last_seen <=`），格式 `YYYY-MM-DD` |
| `sort_by` | string | `last_seen` | 排序字段：`last_seen` / `first_seen` / `total_count` / `created_at` / `id` |
| `sort_order` | string | `desc` | 排序方向：`asc` / `desc` |

> **注意**: `platform` 和 `app_version` 参数当前作用于 group 级别筛选（通过 `crash_groups` 表直接查询），如需按报告的 platform/version 精确筛选，请使用 `/crash-reports` 接口。

#### 示例

```bash
# 查询所有 open 状态的崩溃，按发生次数降序
curl "http://localhost:8080/api/v1/crash-groups?status=open&sort_by=total_count&sort_order=desc&page=1&page_size=20"

# 搜索包含 "Null" 的崩溃
curl "http://localhost:8080/api/v1/crash-groups?search=Null"
```

#### 响应

```json
{
  "items": [
    {
      "id": 1,
      "crash_hash": "a8002ef4f65bcd40",
      "exception_type": "NullReferenceException",
      "exception_message": "Object reference not set to an instance of an object",
      "first_seen": "2026-07-27T03:41:55.549Z",
      "last_seen": "2026-07-27T03:42:11.180Z",
      "total_count": 2,
      "status": "open",
      "resolved_version": "",
      "created_at": "2026-07-27 03:41:55"
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 20,
  "total_pages": 1
}
```

---

### 3. 查询崩溃分组详情

```
GET /api/v1/crash-groups/:id
```

返回单个分组的完整信息，并附带最近 20 条报告。

```bash
curl http://localhost:8080/api/v1/crash-groups/1
```

#### 响应

```json
{
  "id": 1,
  "crash_hash": "a8002ef4f65bcd40",
  "exception_type": "NullReferenceException",
  "exception_message": "Object reference not set to an instance of an object",
  "first_seen": "2026-07-27T03:41:55.549Z",
  "last_seen": "2026-07-27T03:42:11.180Z",
  "total_count": 2,
  "status": "open",
  "resolved_version": "",
  "created_at": "2026-07-27 03:41:55",
  "recent_reports": [
    {
      "id": 2,
      "group_id": 1,
      "exception_type": "NullReferenceException",
      "exception_message": "Same crash",
      "stack_trace": "at PlayerController.Update () [0x00000]",
      "platform": "Android",
      "device_model": "",
      "app_version": "1.2.3",
      "created_at": "2026-07-27T03:42:11.180Z"
    }
  ]
}
```

#### 错误响应

```json
// 400
{ "error": "Invalid ID" }

// 404
{ "error": "Not found" }
```

---

### 4. 更新崩溃分组状态

```
PUT /api/v1/crash-groups/:id/status
```

将崩溃标记为已解决、忽略或重新打开。

```bash
# 标记为已解决
curl -X PUT http://localhost:8080/api/v1/crash-groups/1/status \
  -H "Content-Type: application/json" \
  -d '{"status": "resolved", "resolved_version": "1.2.4"}'

# 标记为忽略
curl -X PUT http://localhost:8080/api/v1/crash-groups/1/status \
  -H "Content-Type: application/json" \
  -d '{"status": "ignored"}'

# 重新打开
curl -X PUT http://localhost:8080/api/v1/crash-groups/1/status \
  -H "Content-Type: application/json" \
  -d '{"status": "open"}'
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `status` | string | **是** | `open` / `resolved` / `ignored` |
| `resolved_version` | string | 否 | 修复版本号（仅在 status=resolved 时有意义） |

#### 成功响应

```json
{ "success": true }
```

#### 错误响应

```json
// 400
{ "error": "Invalid status", "message": "Status must be one of: open, resolved, ignored" }

// 404
{ "error": "Group not found" }
```

---

### 5. 查询单条报告列表

```
GET /api/v1/crash-reports
```

查询所有单独的崩溃报告（不分组），支持筛选。

#### 查询参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | 1 | 页码 |
| `page_size` | number | 20（最大 100） | 每页条数 |
| `group_id` | number | — | 筛选指定分组的报告 |
| `platform` | string | — | 筛选平台 |
| `app_version` | string | — | 筛选应用版本 |
| `start_date` | string | — | 起始日期（`created_at >=`） |
| `end_date` | string | — | 截止日期（`created_at <=`） |

```bash
# 查某分组的全部报告
curl "http://localhost:8080/api/v1/crash-reports?group_id=1"

# 查 iOS 平台的报告
curl "http://localhost:8080/api/v1/crash-reports?platform=iOS&page_size=50"
```

#### 响应格式

与 [查询崩溃分组列表](#2-查询崩溃分组列表) 相同的分页结构，`items` 为 `CrashReport` 对象数组。

---

### 6. 查询单条报告详情

```
GET /api/v1/crash-reports/:id
```

返回完整的报告信息，包含附件列表。

```bash
curl http://localhost:8080/api/v1/crash-reports/1
```

#### 响应

```json
{
  "id": 1,
  "group_id": 1,
  "exception_type": "NullReferenceException",
  "exception_message": "Object reference not set...",
  "stack_trace": "at PlayerController.Update () [0x00000]...",
  "log_text": "Unity Player.log content...",
  "unity_version": "2022.3.10f1",
  "platform": "Android",
  "device_model": "Samsung Galaxy S23",
  "os_version": "Android 14",
  "gpu_name": "Adreno 740",
  "cpu_name": "Snapdragon 8 Gen 2",
  "memory_mb": 8192,
  "app_version": "1.2.3",
  "bundle_id": "com.example.game",
  "scene_name": "Level_01",
  "custom_data": "{\"user_id\":\"abc123\"}",
  "client_ip": "::1",
  "client_timestamp": "2026-07-27T12:00:00Z",
  "created_at": "2026-07-27T03:41:55.549Z",
  "attachments": [
    {
      "id": 1,
      "crash_report_id": 1,
      "filename": "screenshot.png",
      "content_type": "image/png",
      "file_size": 245760,
      "file_path": "/app/data/attachments/a1b2c3d4e5f6.png",
      "created_at": "2026-07-27 03:41:55"
    }
  ]
}
```

> **注意**: 附件仅返回元数据，不返回文件内容。附件文件存储在服务器的 `data/attachments/` 目录中。

---

### 7. 仪表盘统计

```
GET /api/v1/stats/dashboard
```

返回 Web 管理后台仪表盘所需的所有统计数据。

```bash
curl http://localhost:8080/api/v1/stats/dashboard
```

#### 响应

```json
{
  "total_crashes": 156,
  "total_groups": 23,
  "open_groups": 18,
  "resolved_groups": 5,
  "crashes_today": 12,
  "crashes_week": 89,
  "top_crashes": [
    {
      "group_id": 3,
      "exception_type": "NullReferenceException",
      "exception_message": "Object reference not set...",
      "count": 45,
      "last_seen": "2026-07-27T10:30:00Z"
    }
  ],
  "platform_distribution": [
    { "platform": "Android", "count": 98 },
    { "platform": "iOS", "count": 42 },
    { "platform": "Windows", "count": 16 }
  ],
  "version_distribution": [
    { "app_version": "1.2.3", "count": 120 },
    { "app_version": "1.2.2", "count": 36 }
  ],
  "daily_trend": [
    { "date": "2026-07-01", "count": 5 },
    { "date": "2026-07-02", "count": 8 }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `total_crashes` | 报告总数 |
| `total_groups` | 崩溃分组总数 |
| `open_groups` | 未解决的分组数 |
| `resolved_groups` | 已解决的分组数 |
| `crashes_today` | 今日报告数 |
| `crashes_week` | 近 7 天报告数 |
| `top_crashes` | Top 10 未解决崩溃（按发生次数降序） |
| `platform_distribution` | 平台分布（按报告数降序） |
| `version_distribution` | 版本分布 Top 20（按报告数降序） |
| `daily_trend` | 近 30 天每日崩溃趋势 |

---

### 8. 获取平台列表

```
GET /api/v1/platforms
```

返回所有已上报的不同平台名称。

```bash
curl http://localhost:8080/api/v1/platforms
```

#### 响应

```json
["Android", "iOS", "WebGL", "Windows"]
```

---

### 9. 获取版本列表

```
GET /api/v1/versions
```

返回最近上报的 50 个不同应用版本号。

```bash
curl http://localhost:8080/api/v1/versions
```

#### 响应

```json
["1.2.3", "1.2.2", "1.2.1", "1.1.0"]
```

---

### 10. 上传符号文件

```
POST /api/v1/symbols
```

上传 Unity 符号文件（如 Android 的 `libil2cpp.so.sym` 或 iOS 的 dSYM），用于后续崩溃堆栈符号化。

```bash
curl -X POST http://localhost:8080/api/v1/symbols \
  -F "file=@libil2cpp.so.sym" \
  -F "platform=Android" \
  -F "build_guid=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
```

#### 请求参数（multipart/form-data）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | **是** | 符号文件（最大 500MB） |
| `platform` | string | 否（默认 `unknown`） | 平台：`Android` / `iOS` / `Windows` / `Mac` / `WebGL` / `Linux` |
| `build_guid` | string | **是** | Unity Build GUID（可在 `Player Settings` 或构建日志中找到） |

#### 成功响应 — `201 Created`

```json
{
  "id": 1,
  "platform": "Android",
  "build_guid": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  "filename": "libil2cpp.so.sym",
  "file_size": 52428800,
  "file_path": "/app/data/symbols/abc123def456.sym",
  "uploaded_at": "2026-07-27 03:41:55"
}
```

#### 错误响应

```json
// 400
{ "error": "Bad Request", "message": "No file uploaded. Use field name \"file\"." }
{ "error": "Bad Request", "message": "build_guid is required" }
```

---

### 11. 查询符号文件列表

```
GET /api/v1/symbols
```

分页查询已上传的符号文件。

#### 查询参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | number | 1 | 页码 |
| `page_size` | number | 50（最大 200） | 每页条数 |
| `platform` | string | — | 筛选平台 |
| `build_guid` | string | — | 筛选 Build GUID |

```bash
curl "http://localhost:8080/api/v1/symbols?platform=Android"
```

#### 响应

```json
{
  "items": [
    {
      "id": 1,
      "platform": "Android",
      "build_guid": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      "filename": "libil2cpp.so.sym",
      "file_size": 52428800,
      "file_path": "/app/data/symbols/abc123def456.sym",
      "uploaded_at": "2026-07-27 03:41:55"
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 50,
  "total_pages": 1
}
```

---

### 12. 删除符号文件

```
DELETE /api/v1/symbols/:id
```

删除指定符号文件（同时删除磁盘上的文件和数据库记录）。

```bash
curl -X DELETE http://localhost:8080/api/v1/symbols/1
```

#### 成功响应

```json
{ "success": true }
```

#### 错误响应

```json
// 400
{ "error": "Invalid ID" }

// 404
{ "error": "Not found" }
```

---

### 13. 健康检查

```
GET /health
```

用于 Docker healthcheck 或负载均衡器探活。

```bash
curl http://localhost:8080/health
```

#### 响应

```json
{ "status": "ok", "uptime": 3600.123 }
```

---

## Unity 客户端集成

### C# 代码示例

以下是一个完整的 Unity `MonoBehaviour` 崩溃上报组件：

```csharp
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

/// <summary>
/// 自动捕获未处理异常并上报到 Crash Report Server。
/// 挂载到场景中的任意 GameObject 即可工作。
/// </summary>
public class CrashReporter : MonoBehaviour
{
    [Header("Server")]
    [Tooltip("服务器地址，不含路径尾斜杠")]
    public string serverUrl = "http://localhost:8080";

    [Header("Behavior")]
    [Tooltip("是否在启动时自动初始化")]
    public bool initOnStart = true;

    [Tooltip("是否同时将异常输出到 Unity 日志")]
    public bool logToConsole = true;

    private bool _initialized;

    private void Start()
    {
        if (initOnStart) Initialize();
    }

    /// <summary>
    /// 初始化崩溃上报。调用后会自动订阅 Application.logMessageReceived 和 AppDomain.UnhandledException。
    /// </summary>
    public void Initialize()
    {
        if (_initialized) return;
        _initialized = true;

        Application.logMessageReceived += OnLogMessageReceived;
        AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;

        // 发送启动事件（可选）
        StartCoroutine(SendEvent("session_start", new Dictionary<string, object>
        {
            ["unity_version"] = Application.unityVersion,
            ["platform"] = Application.platform.ToString(),
            ["device_model"] = SystemInfo.deviceModel,
            ["os_version"] = SystemInfo.operatingSystem,
            ["gpu_name"] = SystemInfo.graphicsDeviceName,
            ["cpu_name"] = SystemInfo.processorType,
            ["memory_mb"] = SystemInfo.systemMemorySize,
            ["app_version"] = Application.version,
            ["bundle_id"] = Application.identifier
        }));
    }

    private void OnDestroy()
    {
        Application.logMessageReceived -= OnLogMessageReceived;
        AppDomain.CurrentDomain.UnhandledException -= OnUnhandledException;
    }

    /// <summary>
    /// 捕获 Unity 日志中的 Exception。
    /// </summary>
    private void OnLogMessageReceived(string condition, string stackTrace, LogType type)
    {
        if (type != LogType.Exception && type != LogType.Error) return;

        var exceptionType = type == LogType.Exception
            ? ExtractExceptionType(condition)
            : "UnityError";

        var payload = new CrashReportPayload
        {
            exception_type = exceptionType,
            exception_message = condition,
            stack_trace = stackTrace,
            platform = Application.platform.ToString(),
            unity_version = Application.unityVersion,
            device_model = SystemInfo.deviceModel,
            os_version = SystemInfo.operatingSystem,
            gpu_name = SystemInfo.graphicsDeviceName,
            cpu_name = SystemInfo.processorType,
            memory_mb = SystemInfo.systemMemorySize,
            app_version = Application.version,
            bundle_id = Application.identifier
        };

        StartCoroutine(SendCrashReport(payload));
    }

    /// <summary>
    /// 捕获 .NET 未处理异常。
    /// </summary>
    private void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        var ex = e.ExceptionObject as Exception;
        if (ex == null) return;

        var payload = new CrashReportPayload
        {
            exception_type = ex.GetType().Name,
            exception_message = ex.Message,
            stack_trace = ex.StackTrace ?? "",
            platform = Application.platform.ToString(),
            unity_version = Application.unityVersion,
            device_model = SystemInfo.deviceModel,
            os_version = SystemInfo.operatingSystem,
            app_version = Application.version,
            bundle_id = Application.identifier
        };

        StartCoroutine(SendCrashReport(payload, isFatal: true));
    }

    /// <summary>
    /// 发送崩溃报告到服务器。
    /// </summary>
    private IEnumerator SendCrashReport(CrashReportPayload payload, bool isFatal = false)
    {
        if (logToConsole)
        {
            Debug.Log($"[CrashReporter] Sending crash report: {payload.exception_type} (fatal={isFatal})");
        }

        var json = JsonUtility.ToJson(payload);

        using var request = new UnityWebRequest(
            $"{serverUrl}/api/v1/crash-report", "POST");

        var bodyRaw = Encoding.UTF8.GetBytes(json);
        request.uploadHandler = new UploadHandlerRaw(bodyRaw);
        request.downloadHandler = new DownloadHandlerBuffer();
        request.SetRequestHeader("Content-Type", "application/json");

        yield return request.SendWebRequest();

        if (request.result == UnityWebRequest.Result.Success)
        {
            var response = JsonUtility.FromJson<CrashReportResponse>(
                request.downloadHandler.text);
            if (logToConsole)
            {
                Debug.Log($"[CrashReporter] Reported: id={response.id}, " +
                          $"group_id={response.group_id}, " +
                          $"new_group={response.is_new_group}");
            }
        }
        else
        {
            Debug.LogError($"[CrashReporter] Failed to send crash report: " +
                           request.error);
        }
    }

    /// <summary>
    /// 发送自定义事件（如 session_start、custom_event 等）。
    /// </summary>
    public IEnumerator SendEvent(string eventType,
        Dictionary<string, object> data)
    {
        var payload = new CrashReportPayload
        {
            exception_type = eventType,
            custom_data = JsonUtility.ToJson(
                new CustomDataWrapper { data = data })
        };

        return SendCrashReport(payload);
    }

    /// <summary>
    /// 从 condition 字符串中提取异常类型名。
    /// 形如 "NullReferenceException: Object reference..." → "NullReferenceException"
    /// </summary>
    private static string ExtractExceptionType(string condition)
    {
        if (string.IsNullOrEmpty(condition)) return "Unknown";
        var colonIndex = condition.IndexOf(':');
        return colonIndex > 0
            ? condition.Substring(0, colonIndex).Trim()
            : condition;
    }

    // ----- 内部数据结构 -----

    [Serializable]
    private class CrashReportPayload
    {
        public string exception_type;
        public string exception_message;
        public string stack_trace;
        public string log_text;
        public string unity_version;
        public string platform;
        public string device_model;
        public string os_version;
        public string gpu_name;
        public string cpu_name;
        public int memory_mb;
        public string app_version;
        public string bundle_id;
        public string scene_name;
        public string custom_data;
        public string client_timestamp;
    }

    [Serializable]
    private class CrashReportResponse
    {
        public int id;
        public int group_id;
        public bool is_new_group;
    }

    [Serializable]
    private class CustomDataWrapper
    {
        public Dictionary<string, object> data;
    }
}
```

### 使用方法

1. 将上述 `CrashReporter.cs` 放入项目的 `Assets/Scripts/` 目录。
2. 在场景中创建一个空 GameObject，挂载 `CrashReporter` 组件。
3. 在 Inspector 中设置 `Server URL` 为你的服务器地址。
4. 运行游戏 — 任何未捕获异常都会自动上报。

### 手动上报

你也可以在任何代码位置手动发送崩溃报告：

```csharp
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;

public IEnumerator ReportManualCrash(string exceptionType, string message,
    string stackTrace)
{
    var json = $@"{{
        ""exception_type"": ""{EscapeJson(exceptionType)}"",
        ""exception_message"": ""{EscapeJson(message)}"",
        ""stack_trace"": ""{EscapeJson(stackTrace)}"",
        ""platform"": ""{Application.platform}"",
        ""app_version"": ""{Application.version}"",
        ""unity_version"": ""{Application.unityVersion}""
    }}";

    using var request = new UnityWebRequest(
        "http://your-server:8080/api/v1/crash-report", "POST");
    var body = System.Text.Encoding.UTF8.GetBytes(json);
    request.uploadHandler = new UploadHandlerRaw(body);
    request.downloadHandler = new DownloadHandlerBuffer();
    request.SetRequestHeader("Content-Type", "application/json");

    yield return request.SendWebRequest();

    if (request.result == UnityWebRequest.Result.Success)
    {
        Debug.Log("Crash reported: " + request.downloadHandler.text);
    }
}

private string EscapeJson(string s) => s?.Replace("\\", "\\\\")
    .Replace("\"", "\\\"")
    .Replace("\n", "\\n")
    .Replace("\r", "\\r")
    .Replace("\t", "\\t");
```

> **推荐**: 在生产环境中使用 `JsonUtility.ToJson()` 或 Newtonsoft.Json 来序列化，避免手动拼接 JSON。

### 附带自定义数据

`custom_data` 字段可以传入任意 JSON 对象：

```csharp
var customData = new Dictionary<string, object>
{
    ["user_id"] = PlayerPrefs.GetString("user_id"),
    ["session_id"] = currentSessionId,
    ["level"] = currentLevel,
    ["game_time_seconds"] = Time.time
};
// 序列化后放入 custom_data 字段
```

---

## Web 管理后台

服务器内嵌了一个完整的 Web 管理后台，支持深色主题和移动端响应式布局。

### 访问地址

```
http://<host>:8080/web/
```

### 功能页面

| 页面 | 路径 | 功能 |
|------|------|------|
| **仪表盘** | `/web/` | 崩溃趋势折线图、平台分布饼图、版本分布柱状图、Top 崩溃列表、实时统计卡片 |
| **崩溃列表** | `/web/crashes` | 分页列表、搜索（异常类型/消息模糊匹配）、按状态/平台/版本筛选、多种排序 |
| **崩溃详情** | `/web/crashes/:id` | 完整堆栈、Player.log 日志、设备信息、历史发生记录表、状态变更操作（标记已解决/忽略/重新打开） |
| **符号管理** | `/web/symbols` | 符号文件列表、上传、删除 |
| **API 文档** | `/web/api-doc` | 内置 API 参考文档页面 |

### 技术栈

- **Alpine.js** — 轻量响应式框架（约 15KB）
- **Chart.js** — Canvas 图表库
- **Tailwind CSS** — CDN 加载的工具类 CSS

---

## 配置参考

所有配置通过环境变量设置。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | HTTP 监听端口 |
| `DATA_DIR` | `<项目根>/data` | 数据存储根目录 |
| `DB_PATH` | `<DATA_DIR>/crash_reports.db` | SQLite 数据库文件路径 |
| `SYMBOLS_DIR` | `<DATA_DIR>/symbols` | 符号文件存储目录 |
| `ATTACHMENTS_DIR` | `<DATA_DIR>/attachments` | 附件存储目录 |
| `MAX_LOG_SIZE` | `10485760` (10MB) | stack_trace / log_text 字段最大字节数，超出自动截断 |
| `MAX_ATTACHMENT_SIZE` | `20971520` (20MB) | 单个附件文件最大字节数 |
| `CORS_ORIGINS` | `*` | CORS 允许的来源，多个用逗号分隔，如 `https://a.com,https://b.com` |
| `AUTH_TOKEN` | `<随机生成>` | API 鉴权令牌（当前版本预留，未强制校验） |

### Docker Compose 示例

```yaml
services:
  crash-report-server:
    build: .
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - DATA_DIR=/app/data
      - AUTH_TOKEN=my-secret-token
      - CORS_ORIGINS=https://my-dashboard.example.com
      - MAX_LOG_SIZE=52428800     # 50MB
    volumes:
      - ./server_data:/app/data   # 挂载到宿主机目录
    restart: unless-stopped
```

---

## 部署指南

### 开发环境

```bash
git clone <repo>
cd Server
npm install
npm run dev
```

### 生产环境（Docker）

```bash
# 构建镜像
docker build -t crash-report-server .

# 运行容器
docker run -d \
  --name crash-report-server \
  -p 8080:8080 \
  -v $(pwd)/server_data:/app/data \
  -e AUTH_TOKEN=your-secret-token \
  crash-report-server
```

### 生产环境（Docker Compose）

```bash
docker-compose up -d
```

### 反向代理（Nginx 示例）

```nginx
server {
    listen 80;
    server_name crash.example.com;

    client_max_body_size 500M;  # 符号文件可能很大

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 数据持久化

- **SQLite 数据库**: 所有崩溃报告、分组、附件元数据、符号文件记录均存储在 `data/crash_reports.db` 中
- **附件文件**: 存储在 `data/attachments/` 目录
- **符号文件**: 存储在 `data/symbols/` 目录

Docker 部署时，通过挂载 volume 或 bind mount 到 `/app/data` 实现持久化：

```bash
# Volume（推荐）
docker run -v crash_data:/app/data ...

# Bind mount
docker run -v /host/path/data:/app/data ...
```

### 备份

```bash
# 备份整个数据目录
tar -czf backup-$(date +%Y%m%d).tar.gz data/

# 仅备份数据库
cp data/crash_reports.db data/crash_reports.db.bak
```

---

## 项目结构

```
e:/Server/
├── src/
│   ├── main.ts                  # 入口文件：Express 应用初始化、路由注册、服务启动
│   ├── config.ts                # 配置加载：环境变量读取、默认值、目录初始化
│   ├── database.ts              # 数据库：SQLite 连接、WAL 模式、Schema 自动迁移
│   ├── model.ts                 # 类型定义：所有数据模型和接口的 TypeScript 类型
│   ├── store.ts                 # 数据访问层：所有数据库 CRUD 操作
│   ├── service.ts               # 业务逻辑层：崩溃 hash 计算、去重分组、报告注入
│   ├── middleware.ts             # 中间件：请求日志、全局错误处理、404 处理
│   └── handler/
│       ├── crash_report.ts      # 崩溃上报 API：提交、查询分组、查询报告、统计
│       ├── symbol.ts            # 符号文件 API：上传、列表、删除
│       └── web.ts               # Web 管理后台：模板渲染、路由分发
├── web/
│   └── templates/
│       ├── layout.html          # 基础布局模板（深色主题侧边栏 + 顶栏）
│       ├── dashboard.html       # 仪表盘页面（统计卡片 + Chart.js 图表）
│       ├── crash_list.html      # 崩溃列表页面（搜索、筛选、分页表格）
│       ├── crash_detail.html    # 崩溃详情页面（堆栈、日志、设备信息、操作面板）
│       └── symbol_list.html     # 符号管理页面（上传、列表、删除）
├── data/                        # 运行时数据目录（Git 忽略）
│   ├── crash_reports.db         # SQLite 数据库文件
│   ├── symbols/                 # 上传的符号文件
│   └── attachments/             # 上传的附件文件
├── Dockerfile                   # 多阶段构建：TypeScript 编译 → 精简运行时镜像
├── docker-compose.yml           # Docker Compose 编排
├── package.json                 # Node.js 项目配置
├── tsconfig.json                # TypeScript 编译配置
└── README.md                    # 本文件
```
