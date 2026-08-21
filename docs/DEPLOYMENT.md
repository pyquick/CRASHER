# 部署指南 (Deployment)

> Docker · 环境变量 · 健康检查 · 数据持久化

---

## Docker 部署

### 构建

```bash
docker build -t crash-report-server .
```

### 运行

```bash
docker compose up -d
```

或手动：

```bash
docker run -d \
  -p 8080:8080 \
  -v crash_data:/app/data \
  --env-file .env \
  crash-report-server
```

---

## Dockerfile 说明

两阶段构建 (node:24-alpine)：
1. **构建阶段**: `npm ci`, `npm run build` (tsc)
2. **运行阶段**: 仅复制 `dist/` + `web/` + `node_modules` (生产依赖), 删除 dev 依赖

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:8080/health || exit 1
EXPOSE 8080
CMD ["node", "dist/main.js"]
```

---

## 环境变量

### 必需

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8080 | 服务端口 |
| `DATA_DIR` | ./data | 数据目录 (DB + 附件 + 符号 + 源码) |

### 文件大小限制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_REPORT_SIZE` | 5 MB | JSON 请求体最大 |
| `MAX_ATTACHMENT_SIZE` | 20 MB | 崩溃附件单文件最大 |
| `MAX_FEEDBACK_ATTACH_SIZE` | 10 MB | 反馈附件单文件最大 |
| `MAX_SOURCE_FILE_SIZE` | 2 MB | 源码单文件最大 |
| `MAX_SOURCE_ARCHIVE_SIZE` | 5 GB | 源码归档最大（T4/T5 及无 Tier 容器的硬上限） |
| `MAX_SOURCE_FILES` | 50000 | 单快照源码文件数（T4/T5 及无 Tier 容器的硬上限） |
| `MAX_SYMBOL_SIZE` | 500 MB | 符号文件最大 |

### 安全

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_REQUIRE_KEY` | true | 写入是否需要 API 密钥 |
| `SESSION_HOURS` | 168 | 会话有效期（小时，7天） |
| `TRUST_PROXY` | false | 代理信任（HTTPS 反向代理时启用） |
| `CORS_ORIGINS` | http://localhost:8080 | CORS 白名单 |
| `COOKIE_SECURE` | auto | Cookie Secure 属性（HTTPS 时自动启用） |

### 限流

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LOGIN_RATE_LIMIT` | 150 | 5 分钟内最大登录次数 |
| `INGEST_RATE_LIMIT` | 120 | 1 分钟内最大崩溃接收 |
| `API_RATE_LIMIT` | 600 | 1 分钟内最大 API 查询 |

### 通知

| 变量 | 说明 |
|------|------|
| `SMTP_HOST` | SMTP 服务器 |
| `SMTP_PORT` | SMTP 端口 (默认 587) |
| `SMTP_USER` | SMTP 用户名 |
| `SMTP_PASS` | SMTP 密码 |
| `SMTP_FROM` | 发件人地址 |
| `ALERT_ON_NEW_GROUP` | 新崩溃组时发送通知 |
| `ALERT_THRESHOLD_COUNT` | 崩溃达到此数量时告警 |

### AI 助手

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_ENCRYPTION_KEY` | 空 | 32 字节十六进制主密钥；用于加密 DeepSeek Key 和聊天正文。未配置时 AI 不可用；必须稳定备份，轮换会使旧数据无法解密 |
| `AI_DEEPSEEK_MODEL` | `deepseek-chat` | 服务端固定使用的 DeepSeek 模型 |
| `AI_REQUEST_TIMEOUT_MS` | 60000 | 单次上游请求超时 |
| `AI_RATE_LIMIT` | 20 | 每用户每分钟 AI 请求数 |
| `AI_RETENTION_DAYS` | 30 | 聊天会话默认保留天数，仅创建者可见 |

AI 只读取授权崩溃和已通过 API 上传的源码快照，不执行命令、不修改文件、不访问远程仓库。配置 DeepSeek 后，相关崩溃/源码内容会发送给 DeepSeek，请按组织的数据处理要求配置。


参见 `.env.example`

---

## 数据持久化

```
DATA_DIR/
├── crash_reports.db       # SQLite 数据库
├── attachments/           # 崩溃附件
├── feedback_attachments/  # (共享 attachments/)
├── symbols/               # 符号文件
├── sources/               # 源码快照
└── tmp/                   # 临时文件（导入/导出用）
```

---

## 健康检查

```bash
GET /health → { "status": "ok" }
```

Docker 健康检查每 30 秒调用一次。

---

## 首次启动

1. 访问 `http://localhost:8080/web/login`
2. 设置 UltraAdmin 账户（15+ 字符, 含字母+数字+符号）
3. 创建容器（可选）
4. 创建容器内的 admin 用户
5. 创建 API 密钥用于崩溃接收

---

## 运维命令

```bash
# 重置管理员密码
npx tsx src/cli/reset-admin-password.ts
```
