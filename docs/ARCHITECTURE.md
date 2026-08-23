# 架构总览 (Architecture)

> 跨平台崩溃报告服务器 · Express 5 + TypeScript + SQLite

---

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 24+ |
| 语言 | TypeScript 5, ES2022, ESM |
| Web 框架 | Express 5 |
| 数据库 | better-sqlite3 (SQLite, WAL 模式) |
| 前端 | Tailwind CSS CDN, Alpine.js, Chart.js |
| 部署 | Docker (node:24-alpine, 两阶段构建) |
| 测试 | 内置 node:test (单元), Python pytest (集成) |

---

## 目录架构

```
src/
├── main.ts                         # 入口：初始化 → 中间件 → 路由挂载 → 启动
├── config.ts                       # 环境变量加载（40+ 配置项）
├── model.ts                        # TypeScript 类型定义
├── middleware.ts                    # 全局中间件（日志/错误/404/CORS/安全头/CSRF）
│
├── shared/                         # 共享基础设施（零业务依赖）
│   ├── cookie.ts                   #   Cookie 设置/清除
│   ├── container.ts                #   容器作用域解析
│   ├── date.ts                     #   SQL 日期时间格式化
│   ├── rate-limit.ts               #   统一限流（内存 + DB 后端）
│   ├── response.ts                 #   统一 API 响应格式
│   ├── string.ts                   #   字符串工具
│   ├── symbol.ts                   #   符号文件类型检测
│   ├── template.ts                 #   HTML 模板引擎
│   ├── upload.ts                   #   Multer 工厂 / 表单提取 / Dump 解析
│   └── verification.ts             #   通用 2FA 验证存储引擎
│
├── database/                       # 数据库层（所有 SQL 的唯一位置）
│   ├── connection.ts               #   连接管理 (WAL, FK)
│   ├── schema.ts                   #   建表 DDL
│   ├── migrations.ts               #   12 个版本化迁移
│   ├── store.ts                    #   崩溃/反馈/符号/项目 CRUD
│   ├── auth-store.ts               #   用户/会话/密钥/容器/邮箱/手机 CRUD
│   └── index.ts                    #   公开导出
│
├── auth/                           # 认证模块（业务逻辑，无 SQL）
│   ├── password.ts                 #   密码哈希/验证 (PBKDF2 + scrypt)
│   ├── user.ts                     #   用户 CRUD
│   ├── session.ts                  #   会话管理
│   ├── api-key.ts                  #   API 密钥管理
│   ├── container.ts                #   容器管理
│   ├── email.ts                    #   邮箱管理
│   ├── phone.ts                    #   手机管理
│   ├── two-factor.ts              #   TOTP + 邮件/SMS 2FA + MFA
│   ├── password-reset.ts          #   密码重置（审批流程）
│   ├── audit.ts                    #   审计日志
│   └── index.ts                    #   公开导出
│
├── handler/                        # 路由处理器（HTTP 层，薄）
│   ├── auth.ts                     #   认证 API
│   ├── crash_report.ts            #   POST 崩溃报告
│   ├── unity.ts                    #   POST Unity 崩溃
│   ├── feedback.ts                #   POST 玩家反馈
│   ├── query.ts                    #   GET/PUT 查询/导出/导入
│   ├── symbol.ts                   #   符号管理
│   ├── source.ts                   #   源码上传
│   └── web.ts                      #   HTML 页面
│
├── service/                        # 业务逻辑
│   ├── ingest.ts                   #   崩溃接收管道（7 阶段）
│   ├── import.ts                   #   崩溃包导入
│   └── notification.ts            #   邮件/Webhook 通知
│
├── analysis/                       # 崩溃分析引擎(按语言拆分)
│   ├── parser.ts / registry.ts     #   语言检测与解析分发(profile 注册表)
│   ├── analyzer.ts                 #   analyzeCrash 编排
│   ├── common/                     #   通用逻辑(路径/severity/树/摘要/源码分析)
│   └── languages/<lang>/           #   每语言:parser + profile 分析表 + samples
├── dump/                           # 原生 Dump 解析（Android/iOS/Windows/Unity）
├── symbolication/                  # Unity IL2CPP 符号化
├── archive/                        # tar.gz 打包/解包
├── source/                         # 源码处理
├── ai/                             # AI 助手（DeepSeek 客户端 + Agent 循环 + 工具）
│   ├── deepseek.ts                 #   provider 调用（支持 function calling）
│   ├── agent.ts                    #   Agent 循环编排（工具执行/子 Agent/预算）
│   ├── tools.ts                    #   5 个工具：read_source_file/web_fetch/run_bash/update_tasks/spawn_subagent
│   ├── ssrf.ts                     #   SSRF 安全抓取（undici 连接时 IP 校验）
│   ├── context.ts / crypto.ts      #   崩溃上下文装配 / AES-256-GCM
└── cli/                            # 命令行工具
```

---

## 数据流

```
客户端 POST /api/v1/crash-report
    │
    ▼
[中间件链]
  ingestLimiter         ← 内存 IP 限流
  requireApiKey         ← API 密钥认证
  apiKeyRateLimiter     ← DB 配额限流
  requireApiKeyWriteAccess ← 写入权限
  enforceContainerSizeLimit ← 存储配额
    │
    ▼
[ handler/crash_report.ts ]
  解析请求体 → 验证 → 调用 ingestCrash()
    │
    ▼
[ service/ingest.ts ] (管道)
  1. detectRuntime()       ← 自动检测语言 (Unity/Node/...)
  2. resolveProject()      ← 查找/创建项目
  3. applySymbolication()  ← Unity IL2CPP 符号化
  4. computeCrashHash()    ← SHA-256 分组哈希
  5. upsertCrashGroup()    ← 创建/更新崩溃组
  6. createCrashReport()   ← 写入数据库 + 附件
  7. maybeAlert()          ← 新崩溃/阈值通知
    │
    ▼
[ database/store.ts ] → SQLite
```

---

## AI Agent 循环

```
POST /api/v1/ai/conversations/:id/messages (SSE)
    │
    ▼
[密钥轮换] 首个 provider 调用在候选 DeepSeek Key 间轮换（失败即禁用重试）
    │
    ▼
[runAgentLoop] 循环（步数预算 AI_MAX_TOOL_STEPS）
  completeWithDeepSeek(tools) ── 返回 tool_calls? ──► 逐个执行工具
        │                                            ├─ read_source_file（仅 DB 内源码）
        │ 无 tool_calls（最终答案）                    ├─ web_fetch（SSRF 防护）
        ▼                                            ├─ run_bash（AI_BASH_ENABLED 门控 + 工作目录/超时/输出上限）
  SSE: delta + done + tasks                          ├─ update_tasks（任务列表持久化）
        │                                            └─ spawn_subagent（受限工具集，深度 1，计入父预算）
        ▼
[持久化] insertAiMessageExchange + ai_agent_events（工具活动加密入库，message_id 回填关联）
```

所有 Agent 事件（tool_call/tool_result/subagent/task_update）通过 SSE 实时推送到聊天面板并加密持久化（`ai_agent_events` 表），刷新页面后按 `message_id` 回放、任务列表按最新 `task_update` 恢复。

## 认证流

```
登录:     POST /login → verify password → TOTP/email 2FA → session cookie
API 密钥: Bearer xxx → authenticateApiKey → req.authUser + req.apiKeyId
会话:     auth_token cookie → getValidSession → req.authUser
2FA:      TOTP (RFC 6238) | email code | SMS code → 验证后设置 MFA cookie
```

---

## 安全边界

```
请求 → CORS → 安全头 → Cookie 解析 → 会话认证 → CSRF 验证 → 路由 → 响应
                                    ↓
                              req.authUser (全局可用)
```

- **CORS**: 白名单 origin 检查
- **安全头**: X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- **CSRF**: 双重提交 Cookie 模式
- **SQL 注入**: better-sqlite3 参数化查询 100% 覆盖
- **密码**: PBKDF2-SHA512 (310k 轮), 恒定时间比较
- **会话**: HttpOnly + Secure + SameSite=Strict Cookie
