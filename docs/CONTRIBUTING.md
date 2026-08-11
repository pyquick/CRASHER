# 贡献指南 (Contributing)

> 如何提交代码 · 架构规范 · PR 检查清单 · 实例代码

---

## 开发环境

```bash
npm install      # 安装依赖
npm run dev      # 开发模式（热重载）
npm run build    # 构建
npm start        # 启动
```

---

## 添加功能实例

### 1. 新增 API 端点

#### ✅ 正确流程

```typescript
// Step 1: 在 src/database/store.ts 中添加查询函数
export function listRecentCrashGroups(containerId: number | null, limit: number) {
  if (containerId) {
    return getDb().prepare(
      'SELECT * FROM crash_groups WHERE container_id = ? ORDER BY last_seen DESC LIMIT ?'
    ).all(containerId, limit) as CrashGroup[];
  }
  return getDb().prepare(
    'SELECT * FROM crash_groups ORDER BY last_seen DESC LIMIT ?'
  ).all(limit) as CrashGroup[];
}

// Step 2: 在 src/handler/query.ts 中添加路由（薄 handler）
router.get('/crash-groups/recent', (req, res) => {
  res.json(store.listRecentCrashGroups(getContainerScope(req), 10));
});

// Step 3: 在 src/main.ts 中无需额外操作（已挂载 queryHandler）
```

#### ❌ 严禁捷径

```typescript
// ❌ 禁止 —— 直接在 handler 中写 SQL
router.get('/crash-groups/recent', (req, res) => {
  const db = getDb();  // ❌ handler 中禁止 getDb()
  const containerId = req.authUser?.container_id;
  let result;
  if (containerId) {
    result = db.prepare('SELECT * FROM crash_groups WHERE container_id = ? LIMIT 10')
      .all(containerId);  // ❌ handler 中禁止 SQL
  }
  res.json(result);
});
```

### 2. 新增数据库迁移

#### ✅ 正确

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

#### ❌ 严禁

```typescript
// ❌ 禁止 —— 手动在生产数据库执行 SQL
// ❌ 禁止 —— 修改已有迁移的 up() 函数
// ❌ 禁止 —— 不递增版本号
```

### 3. 新增 HTML 页面

#### ✅ 正确

```html
<!-- web/templates/pages/app/my_page.html -->
<div x-data="myPage" x-init="load()">
  <!-- 错误状态 -->
  <div x-show="error" class="bg-red-900/20 border border-red-800 text-red-400 rounded-lg p-4 mb-4">
    <span x-text="error"></span>
    <button class="btn btn-gray btn-sm mt-3" @click="load()">Retry</button>
  </div>
  <!-- 加载状态 -->
  <div x-show="loading" class="text-center py-8 text-gray-400">Loading...</div>
  <!-- 空状态 -->
  <div x-show="!loading && items.length === 0" class="text-center py-12 text-gray-500">
    <p class="text-lg mb-2">No data yet</p>
  </div>
  <!-- 数据表格 -->
  <table class="data-table" x-show="items.length > 0">...</table>
</div>
```

#### ❌ 严禁

```html
<!-- ❌ 禁止 —— 无空状态、无加载状态、无错误处理的页面 -->
<div>
  <table>
    <tr x-for="item in items">...</tr>
  </table>
</div>
```

---

## PR 检查清单

提交前逐项确认：

### 架构检查 (阻断级)

- [ ] **代码在正确目录** (SQL→database/, 认证→auth/, HTTP→handler/, 工具→shared/)
- [ ] **无 SQL 在 handler/** — `grep -r "SELECT\|INSERT\|UPDATE\|DELETE" src/handler/` 返回空
- [ ] **无 getDb() 在 handler/** — `grep -r "getDb()" src/handler/` 返回空
- [ ] **无 require() 调用** — `grep -r "require(" src/ --include="*.ts"` 返回空
- [ ] **HTML 在模板文件不在 web.ts**

### 代码质量

- [ ] TypeScript 编译通过 — `npx tsc --noEmit` 无错误
- [ ] 每个函数只做一件事（不超过 80 行）
- [ ] 无重复代码（同样逻辑出现 3 次以上必须提取）

### 安全

- [ ] 修改操作有 CSRF 保护
- [ ] 敏感操作有审计日志 (`writeAuditLog()`)
- [ ] 无密码/令牌/密钥在日志中
- [ ] Cookie 设置使用 `setSessionCookie()` / `clearCookie()`

### UI (如有变更)

- [ ] 使用 `{{HEAD}}` partial（不复制 tailwind.config）
- [ ] 使用已有 CSS 类（不手写样式组合）
- [ ] 使用全局 JS 函数（不重复 `formatDate`/`readCookie` 等）
- [ ] 有空/加载/错误三种状态 UI
- [ ] 危险操作有确认对话框 (`Modal.confirm()`)
- [ ] 搜索有 300ms 防抖
- [ ] 小屏可用（侧边栏切换 + 表格横向滚动）

### 文档

- [ ] 新配置有默认值
- [ ] `.env.example` 已同步
- [ ] 相关 docs/*.md 已更新

---

## 常见违规与修复

| 违规 | grep 命令 | 修复 |
|------|----------|------|
| handler 中 SQL | `grep -r "SELECT\|INSERT" src/handler/` | 移至 `database/store.ts` |
| handler 中 getDb() | `grep -r "getDb()" src/handler/` | 调用 store 函数 |
| require() | `grep -r "require(" src/` | 改用 `import` |
| 重复 tailwind.config | `grep -r "tailwind.config" web/templates/` | 使用 `{{HEAD}}` partial |
| 内联 HTML | `grep -c "<html" src/handler/web.ts` | 移至模板文件 |
| 重复 formatDate | `grep -rn "function formatDate" web/templates/` | 使用 app.js 全局函数 |
