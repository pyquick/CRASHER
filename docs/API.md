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

### 认证 (在 `/api/v1/auth` 下)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/setup-status` | 检查是否已初始化 |
| POST | `/setup` | 初始化 UltraAdmin |
| POST | `/login` | 登录 (返回 auth_token cookie) |
| POST | `/login/totp` | TOTP 2FA 验证 |
| POST | `/login/verify-email` | 邮箱 2FA 验证 |
| POST | `/login/2fa/email` | 邮箱 2FA 登录 |
| POST | `/logout` | 登出 |
| GET | `/me` | 当前用户信息 |
| POST | `/2fa/challenge` | 发起 2FA 挑战 |
| POST | `/2fa/verify` | 验证 2FA |
| GET | `/me/two-factor-method` | 当前 2FA 方法 |
| PUT | `/me/two-factor-method` | 切换 2FA 方法 |
| GET | `/users` | 用户列表 (admin) |
| POST | `/users` | 创建用户 (admin) |
| PUT | `/users/:id` | 更新用户 (admin) |
| PUT | `/me/password` | 修改密码 |
| GET/POST/DELETE | `/me/emails*` | 邮箱管理 |
| GET/POST/DELETE | `/me/phones*` | 手机管理 |
| GET/POST/DELETE | `/me/totp*` | TOTP 管理 |
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
