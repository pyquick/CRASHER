# 项目架构规范 (Project Architecture Standards)

> 版本: 1.0.0 | 生效日期: 2026-08-11 | 最后修订: 2026-08-11

---

## 目录

1. [项目哲学与架构原则](#1-项目哲学与架构原则)
2. [目录结构标准](#2-目录结构标准)
3. [模块组织与文件标准](#3-模块组织与文件标准)
4. [单一职责原则 (SRP)](#4-单一职责原则-srp)
5. [共享代码标准 (src/shared)](#5-共享代码标准-srcshared)
6. [数据库层标准 (src/database)](#6-数据库层标准-srcdatabase)
7. [认证模块标准 (src/auth)](#7-认证模块标准-srcauth)
8. [API 设计与路由处理器标准 (src/handler)](#8-api-设计与路由处理器标准-srchandler)
9. [中间件标准](#9-中间件标准)
10. [限流标准](#10-限流标准)
11. [错误处理标准](#11-错误处理标准)
12. [日志与审计标准](#12-日志与审计标准)
13. [安全标准](#13-安全标准)
14. [UI 与模板标准](#14-ui-与模板标准)
15. [配置管理标准](#15-配置管理标准)
16. [容器与多租户标准](#16-容器与多租户标准)
17. [类型系统与数据模型标准](#17-类型系统与数据模型标准)
18. [测试标准](#18-测试标准)
19. [文档标准](#19-文档标准)
20. [迁移与变更管理标准](#20-迁移与变更管理标准)

---

## 1. 项目哲学与架构原则

### 1.1 核心原则

| 原则 | 说明 |
|------|------|
| **架构优先** | 任何功能实现前，先确定其在架构中的位置。目录结构决定代码归属。 |
| **功能其次** | 架构正确后，功能实现是自然结果。不在错误的位置实现正确的功能。 |
| **单一职责** | 每个函数只做一件事，每个模块只负责一个领域。违反 SRP 的代码必须拆分。 |
| **DRY (Don't Repeat Yourself)** | 相同逻辑出现 2 次以上，必须提取到 shared/ 或对应模块。 |
| **约定优于配置** | 遵循项目既定命名、目录、代码风格。不引入新的约定除非有明确理由。 |
| **安全默认** | 所有输入验证、输出编码、访问控制默认为最严格策略，显式放宽。 |

### 1.2 决策层级

当发生冲突时，按以下优先级解决：

1. 安全性 (Security)
2. 架构一致性 (Architecture consistency)
3. 性能 (Performance)
4. 开发效率 (Development speed)

### 1.3 代码审查清单

每个 PR / 提交必须通过以下检查：

- [ ] 代码是否放在正确的目录？
- [ ] 是否存在重复代码未提取？
- [ ] 每个函数是否只做一件事？
- [ ] SQL 是否仅在 src/database/ 中？
- [ ] Auth 逻辑是否仅在 src/auth/ 中？
- [ ] 错误是否统一格式返回？
- [ ] 输入是否经过验证？
- [ ] 敏感操作是否记录审计日志？

---

## 2. 目录结构标准

### 2.1 标准目录树

```
src/
├── main.ts                    # 应用入口：初始化、中间件注册、路由挂载、优雅关闭
├── config.ts                  # 配置加载：读取环境变量，返回配置对象
├── model.ts                   # 类型定义：所有 interface/type/enum
├── middleware.ts              # 全局中间件：日志、错误处理、404、CORS、安全头
│
├── shared/                    # 零业务依赖的基础功能（可被任意模块引用）
│   ├── cookie.ts              #   Cookie 解析/设置
│   ├── upload.ts              #   Multer 配置、文件清理
│   ├── form.ts                #   表单/请求体提取
│   ├── string.ts              #   字符串处理（转义、截断、正则）
│   ├── file.ts                #   文件类型检测（文本/二进制）
│   ├── date.ts                #   日期格式化（SQL 日期时间）
│   ├── response.ts            #   统一 API 响应格式
│   ├── rate-limit.ts          #   统一限流接口
│   └── symbol.ts              #   符号类型检测
│
├── database/                  # 数据库层（所有 SQL 语句的唯一位置）
│   ├── index.ts               #   公开导出：getDb, initDb, closeDb
│   ├── connection.ts          #   连接管理：单例、WAL、外键
│   ├── schema.ts              #   建表 DDL
│   ├── migrations.ts          #   版本化迁移
│   ├── store.ts               #   崩溃数据 CRUD
│   ├── auth-store.ts          #   认证数据 CRUD（用户/密钥/会话/容器）
│   └── quota.ts               #   配额消费
│
├── auth/                      # 认证模块（认证/授权逻辑的唯一位置）
│   ├── index.ts               #   公开导出
│   ├── password.ts            #   密码哈希与验证
│   ├── session.ts             #   会话管理
│   ├── email/                 #   邮箱管理 + 登录邮箱验证
│   │   ├── index.ts
│   │   ├── manage.ts          #     邮箱添加/验证/重发/设为主要/删除 + 登录验证开关
│   │   └── login-verification.ts  # 登录邮箱验证会话（身份校验，admin 可选）
│   ├── 2fa/                   #   两步验证
│   │   ├── index.ts
│   │   ├── totp.ts            #     TOTP 引擎（RFC 6238）+ 登录临时令牌
│   │   ├── operation.ts       #     账户操作 2FA 会话（TOTP/邮箱/短信）
│   │   ├── mfa.ts             #     MFA 会话 + 可用方法
│   │   └── phone.ts           #     手机管理（SMS 2FA）
│   ├── api-key.ts             #   API 密钥管理
│   ├── user.ts                #   用户 CRUD
│   ├── password-reset.ts      #   密码重置流程
│   ├── container.ts           #   容器 CRUD、存储统计
│   ├── audit.ts               #   审计日志写入
│   └── middleware.ts           #   Auth 中间件（会话认证、API 密钥认证、角色检查）
│
├── handler/                   # 路由处理器（仅处理 HTTP 请求/响应）
│   ├── auth.ts                #   认证核心路由（初始化/登录/登出/me）
│   ├── auth-common.ts         #   登录步骤链 + 操作 2FA 挑战共享逻辑
│   ├── auth-email.ts          #   邮箱管理路由
│   ├── auth-2fa.ts            #   2FA/TOTP/手机路由
│   ├── auth-password.ts       #   密码重置路由
│   ├── auth-admin.ts          #   用户/API 密钥/容器管理路由
│   ├── crash-report.ts        #   崩溃报告接收
│   ├── unity.ts               #   Unity 专用崩溃接收
│   ├── feedback.ts            #   玩家反馈接收
│   ├── query.ts               #   查询/导出/导入
│   ├── source.ts              #   源码上传
│   ├── symbol.ts              #   符号管理
│   └── web.ts                 #   HTML 页面路由
│
├── service/                   # 业务逻辑
│   ├── ingest.ts              #   崩溃接收编排
│   ├── notification.ts        #   邮件/短信/Webhook 通知
│   └── import.ts              #   崩溃包导入
│
├── analysis/                  # 崩溃分析(按语言拆分,通用逻辑在 common/)
│   ├── index.ts               #   公开导出
│   ├── types.ts               #   共享类型 + LanguageProfile 分析表接口
│   ├── parser.ts              #   薄入口:语言检测 + 解析分发
│   ├── registry.ts            #   语言 profile + parser 注册表
│   ├── analyzer.ts            #   analyzeCrash 编排
│   ├── README.md              #   语言汇总分析表
│   ├── common/                #   通用逻辑(语言无关)
│   │   ├── paths.ts           #     路径归一化 / 模块名提取
│   │   ├── severity.ts        #     严重度分类
│   │   ├── tree.ts            #     崩溃文件树
│   │   ├── summary.ts         #     触发点 / 摘要 / 建议
│   │   ├── source.ts          #     源码快照关联分析
│   │   ├── generic.ts         #     通用回退解析
│   │   └── __tests__/         #     单元测试
│   └── languages/             # 每语言一个文件夹(13 个)
│       └── <lang>/            #   parser.ts + profile.ts(分析表)
│                              #   + samples/ + parser.test.ts + README.md
│
├── dump/                      # 原生 dump 解析
│   ├── parser.ts
│   ├── types.ts
│   ├── android.ts
│   ├── ios.ts
│   ├── minidump.ts
│   └── unity-log.ts
│
├── symbolication/             # Unity IL2CPP 符号化
│   ├── service.ts
│   ├── types.ts
│   ├── symbol-map.ts
│   ├── dsym.ts
│   └── elf.ts
│
├── archive/                   # tar.gz 打包/解包
│   └── tar.ts
│
├── source/                    # 源码处理
│   └── validator.ts
│
└── cli/                       # 命令行工具
    └── reset-admin-password.ts
```

### 2.2 Web 模板目录

```
web/
├── static/
│   ├── css/
│   │   └── app.css            #   全局 CSS
│   └── js/
│       ├── app.js             #   全局 JS：fetch 封装、CSRF、导航、模态框
│       ├── table.js           #   数据表格分页/筛选组件
│       └── chart.js           #   图表初始化
├── templates/
│   ├── layout.html            #   主布局（侧边栏、模态框）
│   ├── pages/
│   │   ├── auth/              #   认证页面（独立布局）
│   │   │   ├── login.html
│   │   │   ├── forgot-password.html
│   │   │   └── approve-reset.html
│   │   └── app/               #   应用页面（layout 布局）
│   │       ├── dashboard.html
│   │       ├── crash-list.html
│   │       ├── crash-detail.html
│   │       ├── feedback-list.html
│   │       ├── symbol-list.html
│   │       ├── account-list.html
│   │       ├── container-list.html
│   │       └── api-doc.html
│   └── partials/              #   可复用 HTML 片段
│       ├── head.html
│       ├── auth.html          #     邮箱验证 + 2FA 浮层组件（登录页与 accounts 共用）
│       ├── sidebar.html
│       ├── modal.html
│       └── pagination.html
```

### 2.3 文档目录

```
docs/
├── STANDARDS.md               # 本文档：项目架构规范
├── ARCHITECTURE.md            # 架构总览
├── API.md                     # API 参考
├── AUTH.md                    # 认证系统
├── DATABASE.md                # 数据库设计
├── CONTAINER.md               # 多租户容器
├── UI_GUIDELINES.md           # UI 开发指南
├── RATE_LIMITING.md           # 限流系统
├── DEPLOYMENT.md              # 部署指南
└── CONTRIBUTING.md            # 贡献指南
```

### 2.4 文件命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| TypeScript 模块 | `kebab-case.ts` | `crash-report.ts`, `password-reset.ts` |
| 类型定义 | 功能名 + `types.ts` | `types.ts`（与模块同目录时） |
| HTML 模板 | `kebab-case.html` | `crash-detail.html` |
| CSS | `kebab-case.css` | `app.css` |
| 文档 | `UPPER_SNAKE_CASE.md` | `STANDARDS.md` |
| 测试文件 | `*.test.ts` | `password.test.ts` |
| 目录 | `kebab-case` 或功能名 | `symbolication/`, `src/shared/` |

---

## 3. 模块组织与文件标准

### 3.1 文件大小限制

| 文件类型 | 最大行数 | 说明 |
|----------|---------|------|
| 模块文件 | 500 行 | 超过则拆分 |
| 路由处理器 | 400 行 | 复杂路由拆分子路由 |
| HTML 模板 | 600 行 | 复杂页面使用 partials |
| 类型定义 | 200 行 | 按领域拆分 |
| 中间件 | 300 行 | 按功能拆分 |

### 3.2 模块导出规范

- 每个模块目录必须有 `index.ts`，只导出公开 API
- 内部实现函数不导出，除非被其他模块使用
- 禁止 `export default`，统一使用命名导出

```typescript
// ✅ 正确
export function hashPassword(password: string): Promise<string> { ... }
export function verifyPassword(password: string, hash: string): Promise<boolean> { ... }

// ❌ 错误
export default function hashPassword(password: string): Promise<string> { ... }
```

### 3.3 导入规范

- 模块间引用使用相对路径（`../auth/password`），不使用路径别名
- 禁止跨层级深层引用（如 handler 直接引用 database/connection）
- `shared/` 可被任意模块引用
- `database/` 仅被 `auth/`、`handler/`、`service/` 引用
- `auth/` 仅被 `handler/`、`middleware.ts` 引用

```
允许的依赖方向：
shared ← database ← auth ← handler
shared ← database ← service ← handler
shared ← analysis/dump/symbolication/archive/source ← handler
```

### 3.4 禁止的模式

- ❌ `require()` 在 ESM 文件中 — 统一使用 `import`
- ❌ 循环依赖
- ❌ `any` 类型（除非有充分理由并注释说明）
- ❌ 直接 `getDb()` 调用在 handler/ 中 — 必须通过 database/ 或 auth/ 的封装函数
- ❌ 在 handler/ 中编写 SQL 语句

---

## 4. 单一职责原则 (SRP)

### 4.1 判定标准

一个函数违反 SRP 的信号：

1. 函数名包含 "and" (如 `validateAndSave`)
2. 函数超过 80 行
3. 函数参数超过 4 个
4. 函数内有明显的 "段落" 分隔（多段逻辑用空行分开）
5. 函数操作了 2 种以上的数据实体

### 4.2 拆分方法

```
// ❌ 违反 SRP: ingestCrash 做了 7 件事
async function ingestCrash(input, files, containerId) {
  // 1. 自动检测运行时
  // 2. 查找或创建项目
  // 3. 符号化
  // 4. 计算哈希
  // 5. 查找或创建崩溃分组
  // 6. 插入崩溃报告
  // 7. 发送通知
}

// ✅ 符合 SRP: 每个函数一个职责
function detectRuntime(input) { ... }
function resolveProject(name) { ... }
function symbolicateIfNeeded(crash, runtime) { ... }
function computeGroupHash(crash) { ... }
function upsertCrashGroup(hash, crash) { ... }
function insertCrashReport(groupId, crash) { ... }
function notifyIfNeeded(group) { ... }

// 编排函数只负责调用
async function ingestCrash(input, files, containerId) {
  const runtime = detectRuntime(input);
  const project = await resolveProject(input.project);
  const symbolicated = await symbolicateIfNeeded(input, runtime);
  const hash = computeGroupHash(symbolicated);
  const group = await upsertCrashGroup(hash, symbolicated);
  const report = await insertCrashReport(group.id, symbolicated);
  await notifyIfNeeded(group);
}
```

### 4.3 需拆分函数清单

以下函数必须在 Phase 0 中拆分：

| 文件 | 函数 | 拆分目标 |
|------|------|---------|
| `src/service.ts` | `ingestCrash()` | 拆分为 6 个独立函数 + 1 个编排函数 |
| `src/auth.ts` | `deleteContainer()` | 分离磁盘操作 → `src/auth/container.ts` |
| `src/handler/query.ts` | POST `/import` 处理器 | 提取 → `src/service/import.ts` |
| `src/handler/crash-report.ts` | crash 处理流程 | 提取重复部分到 `src/shared/upload.ts` |
| `src/auth.ts` | `authenticateUser()` | 分离查询/验证/升级 |
| `src/database.ts` | `runMigrations()` | 版本化迁移系统 |
| `src/handler/web.ts` | `renderTemplate()` + `controllerToRoute()` | 分离渲染与映射 |

---

## 5. 共享代码标准 (src/shared)

### 5.1 shared/ 目录内容规则

**应该放入 shared/ 的：**
- 无业务逻辑的纯工具函数
- 被 2 个以上模块使用的代码
- 基础类型/常量
- 统一格式函数（响应、日期、字符串）

**不应放入 shared/ 的：**
- 任何数据库操作
- 任何认证/授权逻辑
- 业务规则（崩溃哈希计算、符号检测等应放对应模块）
- Express 中间件（放 `src/middleware.ts`）

### 5.2 shared/ 模块清单

| 文件 | 内容 | 来源 |
|------|------|------|
| `cookie.ts` | `parseCookies()`, `setSessionCookie()`, `clearSessionCookie()` | main.ts, handler/auth.ts 重复 |
| `upload.ts` | `createMulterStorage()`, `cleanupUploads()`, `extractFormFields()` | crash-report.ts, unity.ts, feedback.ts 重复 |
| `form.ts` | `extractMultipartFields()`, `truncateString()`, `validateSeverity()` | 三个 ingest handler 重复 |
| `string.ts` | `escapeRegex()`, `extractSection()`, `truncateString()` | dump/android.ts, dump/ios.ts 重复 |
| `file.ts` | `isTextBuffer()`, `sourceLanguage()`, `isTextSource()` | dump/parser.ts, source.ts 重复 |
| `date.ts` | `nowSqlDateTime()`, `nowSqlDateTimePlus()`, `nowSqlDateTimePlusHours()` | auth.ts 中 3 个近相同函数 |
| `response.ts` | `success()`, `error()`, `paginated()` | handler 中数十处重复 |
| `rate-limit.ts` | `createRateLimiter()`, `RateLimiter` 接口 | middleware.ts 双重限流系统 |
| `symbol.ts` | `detectSymbolType()` | symbol.ts, symbolication/service.ts 重复 |

### 5.3 shared/ 代码质量要求

- 零外部副作用（纯函数优先）
- 完整的 TypeScript 类型注解
- 每个导出函数必须有 JSDoc（一行说明即可，仅对非自明函数）
- 必须有对应的单元测试（`src/shared/__tests__/`）

---

## 6. 数据库层标准 (src/database)

### 6.1 核心规则

1. **所有 SQL 语句必须在 `src/database/` 目录中**
2. handler/ 中**禁止**直接调用 `getDb()`
3. handler/ 中**禁止**出现任何 SQL 字符串
4. 所有数据库操作通过 `store.ts` 或 `auth-store.ts` 的函数暴露
5. 所有参数使用参数化查询（`?` 占位符），禁止字符串拼接

### 6.2 文件职责

| 文件 | 职责 |
|------|------|
| `connection.ts` | 单例管理，WAL 模式，外键启用，优雅关闭 |
| `schema.ts` | CREATE TABLE DDL（纯定义，不带迁移逻辑） |
| `migrations.ts` | 版本化迁移：`{version, description, up(), down()?}` |
| `store.ts` | 崩溃数据 CRUD（crash_groups, crash_reports, feedback, symbols, projects） |
| `auth-store.ts` | 认证数据 CRUD（users, sessions, api_keys, emails, phones, containers, audit_logs） |
| `quota.ts` | API 密钥配额消费逻辑 |
| `index.ts` | re-export `getDb`, `initDb`, `closeDb` |

### 6.3 迁移系统规范

```typescript
// src/database/migrations.ts
interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
  // down: (db: Database) => void;  // 可选，简单迁移可不实现
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Add dump_info column to crash_reports',
    up: (db) => {
      db.exec(`ALTER TABLE crash_reports ADD COLUMN dump_info TEXT`);
    },
  },
  // ... 更多迁移
];
```

- 迁移版本号从 1 开始递增
- 每个迁移有明确的描述
- `up()` 用于升级，`down()` 用于降级（可选）
- 迁移通过 `schema_version` 表追踪
- 新迁移只能追加，不能修改已有迁移

### 6.4 查询函数命名规范

```
getXxx()        — 查询单个实体或列表（如 getUser, getCrashGroups）
insertXxx()    — 插入新实体（如 insertCrashReport）
updateXxx()    — 更新实体（如 updateCrashGroupStatus）
deleteXxx()    — 删除实体（如 deleteApiKey）
countXxx()     — 计数查询（如 countReportsInGroup）
existsXxx()    — 检查存在性（如 existsUserByUsername）
```

---

## 7. 认证模块标准 (src/auth)

### 7.1 模块边界

`src/auth/` 是认证和授权的**唯一位置**。

| 文件 | 职责 |
|------|------|
| `password.ts` | PBKDF2 哈希、scrypt 验证（兼容旧密码）、密码强度验证 |
| `session.ts` | 会话创建/验证/销毁/清理、会话 Cookie 管理 |
| `email/manage.ts` | 邮箱添加/验证/重发/设为主要/删除 + 登录邮箱验证开关 |
| `email/login-verification.ts` | 登录邮箱验证会话（身份校验，向主邮箱发码，仅 admin 且开启开关） |
| `2fa/totp.ts` | TOTP 设置/验证/禁用（RFC 6238）+ 登录临时令牌 |
| `2fa/operation.ts` | 账户操作 2FA 会话（TOTP/邮箱/短信验证码 + 待执行请求体） |
| `2fa/mfa.ts` | MFA 会话（2FA 验证后的短期 cookie）+ 可用方法列表 |
| `2fa/phone.ts` | 手机添加/验证/重发/设为主要/删除（SMS 2FA） |
| `api-key.ts` | API 密钥创建/列表/撤销/认证/层级/权限检查 |
| `user.ts` | 用户 CRUD、角色管理、激活管理员保护 |
| `password-reset.ts` | 忘记密码 → 审批 → 重置 完整流程 |
| `container.ts` | 容器 CRUD、封禁/解封、删除级联、存储使用统计 |
| `audit.ts` | 审计日志写入（统一接口，所有敏感操作调用） |
| `middleware.ts` | `authenticateSession`, `authenticateApiKey`, `requireAuth`, `requireRole`, `requireContainerAccess`, `requireCsrf` |
| `index.ts` | 公开导出 |

### 7.2 2FA 统一引擎规范

当前 6 个独立 2FA 存储必须合并为一个通用实现：

```typescript
// src/auth/two-factor.ts
interface TwoFactorSession {
  code: string;           // 6 位验证码
  codeHash: string;       // SHA-256 哈希
  expiresAt: number;      // 过期时间戳
  resendAvailableAt: number; // 可重发时间戳
  attempts: number;       // 已尝试次数
  maxAttempts: number;    // 最大尝试次数
  verified: boolean;      // 是否已验证通过
  data?: Record<string, unknown>; // 附加数据（如待执行的请求体）
}

function create2FASession(prefix: string, ttlMs: number, maxAttempts?: number): {
  init(data?: Record<string, unknown>): string;  // 返回 token
  verify(token: string, code: string): boolean;
  isVerified(token: string): boolean;
  getData<T>(token: string): T | null;
  canResend(token: string): boolean;
  markResent(token: string): void;
  cleanup(): void;
}
```

### 7.3 密码规范

- 新密码：PBKDF2-SHA512，100000 次迭代，32 字节 salt，64 字节 key
- 旧密码兼容：支持 scrypt 验证，验证通过后自动升级为 PBKDF2
- 最小长度：8 字符
- 禁止的用户名：`admin`, `root`, `system`, `administrator` 等
- 禁止弱密码：不额外检查（用户自担），仅检查最小长度

---

## 8. API 设计与路由处理器标准 (src/handler)

### 8.1 路由命名规范

```
GET    /api/v1/crash-groups       — 列表
GET    /api/v1/crash-groups/:id   — 详情
PUT    /api/v1/crash-groups/:id   — 更新
POST   /api/v1/crash-report       — 创建（动词在后）
DELETE /api/v1/symbols/:id        — 删除

页面路由：
GET    /web/dashboard             — HTML 页面
GET    /web/crash-groups          — HTML 页面
```

### 8.2 统一响应格式

```typescript
// 成功
{ "success": true, "data": { ... } }

// 成功（分页）
{ "success": true, "data": [...], "total": 100, "page": 1, "pageSize": 20 }

// 客户端错误
{ "success": false, "error": "描述信息", "code": "ERROR_CODE" }

// 服务器错误
{ "success": false, "error": "Internal server error", "code": "INTERNAL_ERROR" }
```

### 8.3 处理器规范

- 每个路由处理器函数应在 40 行以内
- 复杂逻辑提取到 `service/` 或对应模块
- 处理器只做：解析请求 → 调用服务 → 格式化响应
- 禁止在处理器中直接执行数据库查询
- 统一的 `try/catch` 模式，使用 `src/shared/response.ts` 生成响应

```typescript
// ✅ 正确：处理器薄层
router.post('/crash-report', async (req, res) => {
  try {
    const input = extractCrashInput(req);
    const result = await ingestCrash(input, req.files, req.containerId);
    res.json(success(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json(error(message, 'INGEST_FAILED'));
  }
});
```

### 8.4 中间件链复用

在 `main.ts` 中，重复的中间件数组必须提取为命名常量：

```typescript
// ✅ 正确
const INGEST_MIDDLEWARE = [
  ingestLimiter, requireApiKey, apiKeyMinuteLimiter,
  apiKeyDailyLimiter, requireApiKeyWriteAccess, enforceContainerSizeLimit
];

router.post('/crash-report', ...INGEST_MIDDLEWARE, crashHandler);
router.post('/unity/crash-report', ...INGEST_MIDDLEWARE, unityHandler);
```

---

## 9. 中间件标准

### 9.1 分类

| 类别 | 位置 | 示例 |
|------|------|------|
| 全局中间件 | `src/middleware.ts` | CORS, 安全头, 日志, 错误处理, 404 |
| Auth 中间件 | `src/auth/middleware.ts` | 会话认证, API 密钥认证, 角色检查 |
| 限流中间件 | `src/shared/rate-limit.ts` | IP 限流, API 密钥限流 |
| 功能中间件 | `src/middleware.ts` | CSRF, 容器大小限制 |

### 9.2 中间件编写规范

- 每个中间件一个函数，命名以动词开头
- 必须调用 `next()` 除非显式发送响应
- 错误传给 `next(error)` 而非直接响应（由 `errorHandler` 统一处理）
- 不要在中间件中静默吞掉错误

```typescript
// ✅ 正确
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json(error('Authentication required', 'UNAUTHORIZED'));
  }
  next();
}

// ❌ 错误：直接响应，绕过 errorHandler
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    res.status(401).json({message: 'auth required'});
    return; // 忘了调用 next() 或 return
  }
}
```

### 9.3 中间件顺序

在 `main.ts` 中，中间件按此顺序注册：

1. 安全头 (Helmet)
2. CORS
3. 压缩
4. Cookie 解析
5. 请求日志
6. 会话认证（全局，但仅标记，不放行/拒绝）
7. 静态文件
8. 路由（路由内部链式中间件）
9. 404 处理
10. 错误处理

---

## 10. 限流标准

### 10.1 统一接口

```typescript
// src/shared/rate-limit.ts
interface RateLimitConfig {
  windowMs: number;       // 时间窗口（毫秒）
  maxRequests: number;    // 最大请求数
  keyGenerator?: (req: Request) => string;  // 默认按 IP
}

interface RateLimiter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  consume: (key: string) => { allowed: boolean; remaining: number; resetAt: number };
  reset: (key: string) => void;
}

function createRateLimiter(config: RateLimitConfig): RateLimiter;
function createConsumableRateLimiter(config: RateLimitConfig): RateLimiter;
```

### 10.2 限流类型

| 限流器 | 后端 | 键 | 用途 |
|--------|------|-----|------|
| IP 限流 | 内存 Map | `req.ip` | 登录、密码重置、API 全局 |
| API 密钥限流 (分钟) | 数据库 | `api_key_id` | 每密钥每分钟配额 |
| API 密钥限流 (天) | 数据库 | `api_key_id` | 每密钥每日配额 |

### 10.3 限流响应头

所有限流响应必须包含：
- `X-RateLimit-Limit`: 窗口内最大请求数
- `X-RateLimit-Remaining`: 剩余请求数
- `X-RateLimit-Reset`: 窗口重置时间（Unix 时间戳）

---

## 11. 错误处理标准

### 11.1 错误分类

| 类型 | HTTP 状态码 | 示例 |
|------|-----------|------|
| 验证错误 | 400 | 缺少必填字段、格式错误 |
| 认证错误 | 401 | 未登录、密码错误 |
| 授权错误 | 403 | 无权限执行操作 |
| 资源不存在 | 404 | 崩溃组、用户不存在 |
| 冲突 | 409 | 重复用户名、重复邮箱 |
| 请求过多 | 429 | 超过限流阈值 |
| 负载过大 | 413 | 上传文件超限 |
| 服务器错误 | 500 | 数据库错误、未知异常 |

### 11.2 全局错误处理器

`errorHandler` 在 `src/middleware.ts` 中是**最后一道防线**：
- 记录完整错误堆栈
- 返回 `{ success: false, error: message, code: 'INTERNAL_ERROR' }`
- 不在响应中泄露堆栈信息
- 对 `multer` 文件大小错误返回 413
- 对 `SyntaxError` (JSON 解析失败) 返回 400

### 11.3 业务错误处理

- 可预见的业务错误在处理器中捕获，主动返回 4xx
- 不可预见的错误抛出异常，由 `errorHandler` 处理
- 禁止空的 `catch (error) {}` 或 `catch (error) { console.error(error) }`

---

## 12. 日志与审计标准

### 12.1 审计日志

所有以下操作必须通过 `src/auth/audit.ts` 记录审计日志：

- 用户登录/登出
- 密码修改
- 用户创建/删除/角色变更
- API 密钥创建/撤销
- 容器创建/删除/封禁
- 2FA 设置/验证
- 密码重置请求/审批
- 管理员操作（清空崩溃数据等）
- 邮箱/手机变更

审计日志字段：`user_id`, `action`, `details` (JSON), `ip_address`, `container_id`, `created_at`

### 12.2 应用日志

| 级别 | 用途 |
|------|------|
| `error` | 未捕获异常、数据库连接失败 |
| `warn` | 限流触发、可疑请求、配额用尽 |
| `info` | 服务启动/关闭、迁移执行 |
| `debug` | 仅在开发环境启用的详细信息 |

- 禁止在日志中输出密码、API 密钥、会话令牌等敏感信息
- 使用 `console.error` / `console.warn` / `console.log` 即可（不需要引入日志库）

---

## 13. 安全标准

### 13.1 密码安全

- 传输：必须通过 HTTPS（生产环境）
- 存储：PBKDF2-SHA512（100k 轮），永不存储明文或可逆加密
- 验证：恒定时间比较
- 重置：需要一个审批步骤（admin 审批 → 发邮件 → 设新密码）

### 13.2 会话安全

- Cookie 属性：`HttpOnly`, `Secure`（生产）, `SameSite=Strict`, `Path=/`
- 会话 ID：`crypto.randomBytes(32).toString('hex')`（256 位随机）
- 会话过期：最大 7 天
- 登出：立即从数据库删除会话
- 密码修改：立即使所有该用户会话无效

### 13.3 CSRF 保护

- 双重提交 Cookie 模式（cookie + header 比对）
- CSRF Token：`crypto.randomBytes(32).toString('hex')`
- 所有修改操作（POST/PUT/DELETE）必须验证 CSRF
- `GET` 请求不检查 CSRF

### 13.4 API 密钥安全

- 显示格式：`crash_xxxxxxxxxxxxxxxx`（前缀 + 随机 16 字符）
- 存储：SHA-256 哈希，仅显示时返回原始值（创建时）
- 权限：支持只读/只写/读写/完全访问 4 个层级
- 配额：每分钟 + 每日两层硬限制

### 13.5 输入验证

- 所有用户输入在接收端验证（不在客户端信任输入）
- 文件上传：检查文件大小、类型、内容 magic bytes
- 路径参数：防止路径遍历（`../` 等）
- SQL 注入：100% 参数化查询（已通过 better-sqlite3 保证）
- XSS：HTML 模板中对用户数据使用 `escapeHtml()`

### 13.6 安全头

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 0`（废弃但无害）
- `Referrer-Policy: strict-origin-when-cross-origin`

---

## 14. UI 与模板标准

### 14.1 统一模板引擎

使用 `src/shared/template.ts` 中的统一模板引擎：

```typescript
function renderTemplate(
  template: string,      // 模板内容
  variables: Record<string, string>, // 变量替换
  partials?: Record<string, string>  // 可复用片段
): string;
```

**规则：**
- 所有 HTML 页面使用同一模板引擎渲染
- 禁止在页面模板中重复 `<head>` 标签
- `{{VARIABLE}}` 使用双大括号占位符
- 自动 HTML 转义（默认），使用 `{{{VAR}}}` 三重大括号跳过转义

### 14.2 CSS 规范

统一使用 `web/static/css/app.css`：
- 所有输入框使用 `.form-control` 类
- 所有按钮使用 `.btn .btn-primary|.btn-danger|.btn-secondary` 类
- 所有徽章使用 `.badge .badge-info|.badge-warning|.badge-danger` 类
- 数据表格使用 `.data-table` 类
- 认证页面和使用布局的页面使用**同一套 CSS 类**（当前有两套风格）

### 14.3 JavaScript 规范

- 全局功能提取到 `web/static/js/app.js`：CSRF 令牌注入、`apiFetch()` 封装、模态框管理、侧边栏切换
- 数据表格逻辑提取到 `web/static/js/table.js`：分页、筛选、排序
- 页面特定逻辑保持内联，但不重复全局功能
- 禁止在 HTML 中重复定义 `tailwind.config`

### 14.4 页面分类

| 类别 | 布局 | 公共类 |
|------|------|--------|
| 认证页面 | 独立（居中卡片，无侧边栏） | `auth-page`, `auth-card` |
| 应用页面 | layout.html（侧边栏 + 内容区） | `app-page` |
| 文档页面 | layout.html | `doc-page` |

### 14.5 导航权限显示

- 侧边栏导航项根据用户角色显示/隐藏
- 必须在**服务器端**决定是否渲染导航项（不依赖客户端 JS 隐藏）
- 使用 `{{SHOW_ADMIN_NAV}}` 等模板变量控制

### 14.6 超长页面处理

- 超过 600 行的模板必须以下方式拆分：
  - 提取可复用的 UI 片段到 `web/templates/partials/`
  - 使用 `{{{INCLUDE_PARTIAL}}}` 语法引入

---

## 15. 配置管理标准

### 15.1 环境变量

所有配置通过环境变量传入，在 `src/config.ts` 中集中加载：

```typescript
interface AppConfig {
  port: number;
  dataDir: string;
  maxCrashReportSize: number;     // 默认 5MB
  maxAttachmentSize: number;      // 默认 20MB
  maxFeedbackAttachmentSize: number; // 默认 10MB
  maxSourceFileSize: number;      // 默认 2MB
  maxSourceArchiveSize: number;   // 默认 50MB
  maxSymbolSize: number;          // 默认 500MB
  corsOrigin: string;
  cookieSecure: boolean;
  sessionMaxAge: number;
  smtp: { host, port, user, pass, from };
  smsProvider?: string;           // 预留
  loginRateLimitWindow: number;
  loginRateLimitMax: number;
  apiRateLimitWindow: number;
  apiRateLimitMax: number;
}
```

### 15.2 配置规则

- 所有配置项必须有默认值
- 必填配置在缺失时必须抛错并退出
- 配置对象在下游代码中是只读的（类型层面保证）
- 不写回 `.env` 文件
- `.env.example` 必须与 `config.ts` 同步更新

---

## 16. 容器与多租户标准

### 16.1 容器隔离

- 每个容器有独立的存储配额（50MB ~ 1TB，按层级）
- 崩溃数据通过 `container_id` 隔离
- 用户属于一个容器（`user.container_id`）
- UltraAdmin 不属于任何容器，可查看所有数据

### 16.2 容器作用域函数

```typescript
// src/shared/container.ts
function resolveContainerScope(user: User): number | null {
  // UltraAdmin → null（全局）
  // 普通用户 → user.container_id（受限）
  return user.role !== 'ultraadmin' ? user.container_id ?? null : null;
}
```

- 所有查询处理器必须使用统一的 `resolveContainerScope()` 函数
- 禁止在处理器中重复 `user.role !== 'ultraadmin' ? ...` 三元表达式

### 16.3 容器删除级联

删除容器时，必须按顺序清理：
1. 磁盘文件（附件、符号、源码）
2. 数据库记录（按外键依赖顺序删除）
3. 审计日志（保留，标记 container_id 为 NULL）

---

## 17. 类型系统与数据模型标准

### 17.1 类型定义位置

| 类型 | 位置 |
|------|------|
| 数据库实体 | `src/model.ts` |
| 模块内部类型 | 模块目录下的 `types.ts` |
| 请求/响应 DTO | `src/model.ts` |
| 共享类型 | `src/shared/`（如 `PaginatedResult<T>`） |

### 17.2 类型命名

- 数据库实体：`CamelCase` 名词（如 `CrashReport`, `PlayerFeedback`）
- 输入 DTO：`XxxInput`（如 `CrashReportInput`）
- 枚举：`PascalCase`（如 `UserRole`, `ContainerTier`）
- 联合类型：`PascalCase`（如 `ReportStatus`）

### 17.3 类型安全要求

- 启用 `strict: true`
- 不使用 `as` 类型断言除非有运行时验证
- 使用 `zod` 或手动类型守卫验证外部输入
- 函数参数和返回值必须有显式类型注解（不依赖类型推断）

---

## 18. 测试标准

### 18.1 测试文件位置

```
src/shared/__tests__/           — 工具函数单元测试
src/auth/__tests__/             — 认证逻辑单元测试
src/database/__tests__/         — 数据库查询单元测试
test_api.py                     — API 集成测试（已有）
test_security.py                — 安全集成测试（已有）
```

### 18.2 测试要求

- shared/ 中的每个导出函数必须有单元测试
- 数据库查询函数必须有覆盖正常 + 边界情况的测试
- 认证关键路径（登录、2FA、密码重置）必须有测试
- 集成测试保持 Python（保护已有的投资）
- 单元测试使用 `node:test` + `node:assert`（无需额外依赖）

---

## 19. 文档标准

### 19.1 必写文档

| 文档 | 位置 | 用途 |
|------|------|------|
| 架构规范 | `docs/STANDARDS.md` | 本文档，项目宪法 |
| 架构总览 | `docs/ARCHITECTURE.md` | 系统设计、数据流、技术选型 |
| API 参考 | `docs/API.md` | 所有端点、请求/响应格式 |
| 认证系统 | `docs/AUTH.md` | 认证流程、2FA、API 密钥 |
| 数据库设计 | `docs/DATABASE.md` | ER 图、表结构、索引 |
| 容器多租户 | `docs/CONTAINER.md` | 容器模型、隔离、配额 |
| UI 开发指南 | `docs/UI_GUIDELINES.md` | 模板、CSS、JS 约定 |
| 限流系统 | `docs/RATE_LIMITING.md` | 限流架构、配置 |
| 部署指南 | `docs/DEPLOYMENT.md` | Docker、环境变量、运维 |
| 贡献指南 | `docs/CONTRIBUTING.md` | 如何提交代码 |

### 19.2 代码注释规则

- **不需要注释**：自明的函数名、简单的赋值、标准模式的代码
- **需要 JSDoc**：shared/ 中的导出函数（仅对非自明函数，一行即可）
- **需要行注释**：非显而易见的算法、临时解决方案、已知限制
- **禁止的注释**：`// 修复了 bug`、`// 新增功能`、`// TODO`（用 issue 代替）、已注释掉的代码块

---

## 20. 迁移与变更管理标准

### 20.1 架构变更流程

1. 检查变更是否符合本规范
2. 如规范未覆盖，先更新规范再执行变更
3. 执行变更
4. 运行审查程序，比对规范
5. 修复违规项
6. 提交（commit message 说明变更的架构层面原因）

### 20.2 数据库迁移流程

1. 在 `src/database/migrations.ts` 中添加新迁移
2. 递增版本号
3. 写清楚 `description`
4. 测试升级和降级（如实现了 down）
5. 部署时自动执行（`initDb` 中调用）

### 20.3 破坏性变更

- API 端点重命名：需要更新 `test_api.py`
- 数据库列重命名：需要迁移脚本
- 环境变量变更：需要更新 `.env.example`
- 文件移动：需要更新所有 import 路径

### 20.4 Git 规范

- 分支命名：`feature/xxx`, `fix/xxx`, `refactor/xxx`
- Commit：简洁说明动机，不描述 diff（`git diff` 已显示）
- 不提交：`.env`, `node_modules/`, `dist/`, `data/`
- PR：包含变更的架构层面说明

---

## 20.5 审查程序 (Audit Process)

每次架构变更完成后，执行以下审查：

```bash
# 1. 确认无 handler 直接调用 getDb()
grep -r "getDb()" src/handler/

# 2. 确认无 SQL 在 handler 中
grep -r "SELECT\|INSERT\|UPDATE\|DELETE\|CREATE TABLE\|ALTER TABLE" src/handler/

# 3. 确认无重复的 multer 配置
grep -r "multer\|diskStorage" src/handler/

# 4. 确认无重复的 cookie 设置
grep -r "Set-Cookie" src/handler/

# 5. 确认无 require() 在 ESM 中
grep -r "require(" src/ --include="*.ts"

# 6. 确认 shared/ 无数据库引用
grep -r "getDb\|database" src/shared/

# 7. 确认文件大小合规
find src/ -name "*.ts" | xargs wc -l | sort -rn | head -20

# 8. TypeScript 编译检查
npx tsc --noEmit

# 9. 运行集成测试（如有服务器运行）
python test_api.py
```

---

## 附录 A：实例代码 (Code Examples)

### A.1 单一职责原则 (SRP)

#### ✅ 正确

```typescript
// 每个函数只做一件事
function detectRuntime(input: CrashInput): void { /* 运行时检测 */ }
function resolveProject(name: string): Project { /* 项目查找/创建 */ }
function computeGroupHash(input: CrashInput): string { /* 哈希计算 */ }
function upsertCrashGroup(hash: string): CrashGroup { /* 分组更新/创建 */ }
function insertCrashReport(input: CrashInput, groupId: number): CrashReport { /* 报告写入 */ }
function maybeAlert(group: CrashGroup): void { /* 告警通知 */ }

// 编排函数只负责调用
async function ingestCrash(input: CrashInput): Promise<Result> {
  detectRuntime(input);
  const project = resolveProject(input.project_name);
  const hash = computeGroupHash(input);
  const group = upsertCrashGroup(hash, input);
  const report = insertCrashReport(input, group.id);
  maybeAlert(group);
  return { report, group };
}
```

#### ❌ 严禁：一个函数做多件事

```typescript
// ❌ 禁止 —— 7 个职责混在一个函数中
async function ingestCrash(input, clientIp, now, dumpInfo, containerId) {
  // 自动检测运行时
  if (!input.runtime) {
    if (input.unity_version) input.runtime = 'unity';
    else if (input.runtime_version?.includes('node')) input.runtime = 'node';
  }
  // 查找/创建项目
  const project = input.project_name ? getOrCreateProject(input.project_name) : undefined;
  // 符号化
  const symbolication = await symbolicateUnityCrash(input);
  // 计算哈希
  const hash = computeCrashHash(input);
  // 查找/创建分组
  let group = findGroupByHash(hash);
  if (group) { updateGroupOnNewReport(group.id); }
  else { group = createGroup(hash, ...); }
  // 插入报告
  const report = createReport(input, group.id, ...);
  // 发送告警
  if (isNewGroup && config.alertOnNewGroup) { notifyAlert(...); }
  return { report, group };
}
```

---

### A.2 数据库层

#### ✅ 正确：SQL 仅在 database/ 中

```typescript
// src/database/auth-store.ts
export function findUserByUsername(username: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username) as User | undefined;
}

// src/auth/user.ts —— 业务逻辑，调用 store
import * as store from '../database/auth-store.js';

export function authenticateUser(username: string, password: string): AuthenticatedUser | null {
  const user = store.findUserByUsername(username.trim());  // ✅ 调用 store
  if (!user) return null;
  const valid = verifyPassword(password, user.password_hash);
  return valid ? publicUser(user) : null;
}
```

#### ❌ 严禁：Handler 中直接操作数据库

```typescript
// ❌ 禁止 —— handler 中直接调用 getDb() 和写 SQL
router.get('/platforms', (req, res) => {
  const db = getDb();  // ❌
  res.json(db.prepare("SELECT DISTINCT platform FROM crash_reports WHERE platform != ''")
    .all().map(r => r.platform));  // ❌ SQL 在 handler 中
});

// ❌ 禁止 —— handler 中直接使用 require()
const { getDb } = require('../database.js');  // ❌ CJS 在 ESM 中
```

#### ✅ 正确：Handler 薄层

```typescript
// src/handler/query.ts
import * as store from '../store.js';

router.get('/platforms', (req, res) => {
  res.json(store.listDistinctPlatforms(getContainerScope(req)));  // ✅ 调用 store
});

router.get('/versions', (req, res) => {
  res.json(store.listDistinctVersions(getContainerScope(req)));  // ✅ 调用 store
});
```

---

### A.3 认证模块

#### ✅ 正确：通过 auth/ 间接使用

```typescript
// src/auth/audit.ts
import { insertAuditLog } from '../database/auth-store.js';

export function writeAuditLog(actorUserId, action, targetType, targetId, ip, details) {
  insertAuditLog(actorUserId, action, targetType, targetId, ip, JSON.stringify(details));
}
```

#### ❌ 严禁：业务逻辑中混入 SQL

```typescript
// ❌ 禁止 —— 在业务逻辑文件中直接写 SQL
export function writeAuditLog(userId, action) {
  getDb().prepare('INSERT INTO audit_logs (...) VALUES (...)').run(...);  // ❌ SQL 不应在此
}
```

---

### A.4 路由处理器

#### ✅ 正确

```typescript
// src/handler/crash_report.ts
router.post('/crash-report', upload.array('attachments', 10), async (req, res) => {
  try {
    const input = parseInput(req);
    const error = validateInput(input);
    if (error) {
      cleanupUploads(req);
      return sendError(res, 400, error);
    }
    const result = await ingestCrash(input, getClientIp(req), new Date().toISOString(),
      parseAttachedDumps(req), getContainerId(req));
    // 保存附件
    for (const file of getUploadedFiles(req)) {
      store.createAttachment(result.report.id, file.originalname, file.mimetype, file.size, file.path);
    }
    sendSuccess(res, result, 201);
  } catch (err) {
    cleanupUploads(req);
    sendError(res, 500, 'Could not ingest crash report');
  }
});
```

#### ❌ 严禁：处理器中混杂业务逻辑

```typescript
// ❌ 禁止 —— 250 行业务逻辑内联在路由处理器中
router.post('/import', (req, res) => {
  // 解析 package buffer（5 种格式尝试）
  // 提取 tar.gz
  // 解析 manifest.json
  // 检查冲突
  // 创建 group
  // 循环创建 reports
  // 循环恢复 attachments
  // ... 150+ 行逻辑 ...
  // ❌ 这些应该提取到 service/import.ts
});
```

---

### A.5 中间件

#### ✅ 正确：清晰的责任分离

```typescript
// ✅ 正确 —— 全局中间件在 middleware.ts
export function errorHandler(err, req, res, next) { /* 统一错误响应 */ }
export function notFoundHandler(req, res) { /* 404 响应 */ }

// ✅ 正确 —— 限流在 shared/rate-limit.ts
export function createMemoryRateLimiter(config) { /* 统一限流接口 */ }
```

#### ❌ 严禁：中间件逻辑分散

```typescript
// ❌ 禁止 —— 限流逻辑内联在多个文件中
// middleware.ts: rateLimit()  // 一套实现
// auth.ts: 多个 2FA 存储    // 6 套重复的 Map 存储
// handler/auth.ts: 内联限流  // 又一套
```

---

### A.6 安全

#### ✅ 正确

```typescript
// ✅ 正确 —— 参数化查询（better-sqlite3 默认）
getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);

// ✅ 正确 —— Session cookie 属性
setSessionCookie(res, 'auth_token', token, config.sessionHours * 60 * 60 * 1000);
// → httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/'
```

#### ❌ 严禁

```typescript
// ❌ 禁止 —— 字符串拼接 SQL（SQL 注入风险）
const query = `SELECT * FROM users WHERE username = '${username}'`;
db.exec(query);

// ❌ 禁止 —— Cookie 缺少安全属性
res.cookie('auth_token', token);  // 缺少 httpOnly, secure, sameSite

// ❌ 禁止 —— 密码明文存储
getDb().prepare('INSERT INTO users (password) VALUES (?)').run(password);

// ❌ 禁止 —— 在日志中输出敏感信息
console.log('User logged in with password:', password);  // ❌ 泄露密码
console.log('API key:', apiKey);  // ❌ 泄露密钥
console.log('Session token:', sessionToken);  // ❌ 泄露令牌
```

---

### A.7 导入规范

#### ✅ 正确

```typescript
// ✅ 正确 —— ESM import
import * as auth from '../auth.js';
import { getDb } from '../database/index.js';
import { setSessionCookie } from '../shared/cookie.js';
```

#### ❌ 严禁

```typescript
// ❌ 禁止 —— CJS require 在 ESM 中
const auth = require('../auth.js');

// ❌ 禁止 —— handler 直接引用 database 内部连接
import { getDb } from '../database/connection.js';  // handler 不应直接获取连接

// ❌ 禁止 —— 循环依赖
// a.ts → b.ts → a.ts
```

---

## 附录 B：禁止模式汇总 (Forbidden Patterns)

| # | 禁止模式 | 严重度 | 说明 |
|---|---------|--------|------|
| 1 | handler/ 中直接调用 `getDb()` | **阻断** | 所有 DB 操作必须通过 store |
| 2 | handler/ 中写 SQL 字符串 | **阻断** | 所有 SQL 必须在 database/ |
| 3 | `require()` 在 ESM 文件中 | **阻断** | 统一使用 `import` |
| 4 | 一个函数做超过 3 件事 | **阻断** | 违反 SRP |
| 5 | 同一逻辑出现 3 次以上未提取 | **阻断** | 违反 DRY |
| 6 | `${var}` 拼接 SQL | **阻断** | SQL 注入风险 |
| 7 | 密码/令牌/密钥出现在日志中 | **阻断** | 安全违规 |
| 8 | Cookie 缺少 `httpOnly`/`secure`/`sameSite` | **阻断** | 安全违规 |
| 9 | 页面复制 `tailwind.config` | **阻断** | UI 不一致 |
| 10 | HTML 内联在 web.ts 中 | **阻断** | 架构违规 |
| 11 | `var` 声明变量 | **阻断** | ES6+ 标准 |
| 12 | `innerHTML` 插入未转义用户数据 | **阻断** | XSS 风险 |
| 13 | 同步 I/O 阻塞操作 | **严重** | 性能 |
| 14 | 无防抖的搜索 @keyup | **严重** | 性能 |
| 15 | 空 catch 块 `catch {}` | **严重** | 静默失败 |
| 16 | 空列表/加载中/出错无 UI 反馈 | **严重** | 用户体验 |
| 17 | 手写Tailwind样式组合替代 `.fc`/`.btn` | **一般** | 不一致 |
| 18 | 页面中重复定义 `formatDate`/`formatSize` | **一般** | 重复代码 |
| 19 | 裸 `fetch()` 绕过 CSRF wrapper | **一般** | 安全 |
| 20 | `!important` 在 CSS 中 | **一般** | 维护性 |

---

*本规范由项目架构审查委员会制定，自 2026-08-11 起生效。所有新增功能必须通过附录 B 的禁止模式检查。*
