> Base URL: `http://localhost:8080/api/v1` | 完整文档: `/web/api-doc`

> 账户、登录、2FA 与 API Key 管理端点不属于本文档，见 `docs/AUTH.md`。

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

**源码匹配**：崩溃分析（`GET /crash-reports/:id/analysis`）总是读取项目的「当前状态」——每个路径跨快照的最新一行，因此变更文件按新内容匹配、未变文件不丢失、新增文件立即参与。`match_type`（`exact`/`latest`）仍描述匹配到的快照（按 release 精确优先，否则最新）。

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

### 崩溃分析中的学习知识

`GET /crash-reports/:id/analysis` 会将同一异常类型、同一语言且属于当前项目（或全局项目）的已验证知识合并到响应的 `learned` 数组。`suggestion` 才会进入修复建议，`root_cause` 仅在存在源码分析时进入根因候选；`hint` 和 `quote` 只作为知识展示，不会伪造修复或根因。引用条目包含 `quote`、`meaning`、`source`，且只有三者均有内容时才会保存。知识按标题去重并可由后续证据更新；冲突或未经源码/数据流验证的结论不会追加。


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
curl -X PUT http://localhost:8080/api/v1/crash-groups/7/status \
  -H "Content-Type: application/json" \    # ❌ 缺少 X-CSRF-Token 头
  -d '{"status":"resolved"}'
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
