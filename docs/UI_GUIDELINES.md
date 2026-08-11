# UI 开发指南 (UI Development Guidelines)

> 版本 1.0 | 约束 Phase 6 及所有后续 UI 变更

---

## 1. 模板系统

### 1.1 正确的页面创建

#### ✅ auth 页面（独立居中卡片）

```html
<!-- web/templates/pages/auth/my_login.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>{{HEAD}}</head>
<body class="bg-surface-950 text-gray-100 min-h-screen">
<div x-data="loginForm" class="auth-page">
  <div class="auth-card">
    <h2 class="text-xl font-bold mb-6 text-center">Sign In</h2>
    <input class="fc w-full mb-4" placeholder="Username" x-model="username">
    <input class="fc w-full mb-4" type="password" placeholder="Password" x-model="password">
    <button class="btn btn-blue w-full" @click="login">Sign In</button>
  </div>
</div>
</body>
</html>
```

#### ❌ 严禁：复制 `<head>` 内容

```html
<!-- ❌ 禁止 —— 不允许在页面中复制 tailwind.config 和 CDN 链接 -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Login</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { darkMode: 'class', theme: { extend: { colors: { ... } } } }
  </script>
  <!-- ❌ 这些内容属于 partials/head.html，此处不应重复 -->
</head>
```

#### ❌ 严禁：在 web.ts 中内联 HTML

```typescript
// ❌ 禁止 —— 所有 HTML 必须在模板文件中
router.get('/my-page', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html>...300 行内联 HTML...</html>`);
});
```

#### ✅ 正确：从文件加载

```typescript
// ✅ 正确 —— HTML 在模板文件中
router.get('/my-page', requireAuth, (req, res) => {
  res.type('html').send(renderTemplate('pages/app/my_page.html', 'My Page'));
});
```

---

### 1.2 目录结构

```
web/templates/
├── layout.html               # 主布局壳
├── partials/
│   └── head.html             # 唯一 <head> 定义
└── pages/
    ├── auth/                 # 独立页面，renderStandalone()
    └── app/                  # 带布局页面，renderTemplate()
```

---

## 2. CSS 规范

### 2.1 表单控件

#### ✅ 正确：使用 `.fc` 类

```html
<input class="fc w-full" type="text" placeholder="Search..." x-model="query">
<select class="fc fc-sm" x-model="filter">
  <option value="">All</option>
</select>
<textarea class="fc w-full" rows="4" x-model="description"></textarea>
```

#### ❌ 严禁：使用内联 Tailwind 拼出输入框样式

```html
<!-- ❌ 禁止 —— 手写 bg/border/rounded/padding/text 等 7+ 个 class -->
<!-- 这种做法导致样式不一致，且每次都要写 7 个类 -->
<input class="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-gray-200 text-sm focus:border-blue-500 focus:outline-none"
       type="text" placeholder="Search...">
```

#### ❌ 严禁：在 CSS 中使用 `!important`

```css
/* ❌ 禁止 !important */
.btn { background-color: red !important; }
```

### 2.2 按钮

#### ✅ 正确：使用 `.btn` + 颜色类

```html
<button class="btn btn-blue">Save</button>
<button class="btn btn-green">Submit</button>
<button class="btn btn-red">Delete</button>
<button class="btn btn-gray">Cancel</button>
<button class="btn btn-blue btn-sm">Small</button>
<button class="btn btn-blue" :disabled="loading">Processing...</button>
```

#### ❌ 严禁：手写按钮样式

```html
<!-- ❌ 禁止 —— 手写 inline-flex/items-center/rounded/padding/bg 等 -->
<button class="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700">
  Submit
</button>
```

### 2.3 徽章

#### ✅ 正确

```html
<span class="badge badge-open">Open</span>
<span class="badge badge-resolved">Resolved</span>
<span class="badge badge-ignored">Ignored</span>
```

#### ❌ 严禁：手写徽章

```html
<!-- ❌ 禁止 -->
<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/20 text-red-400">
  Open
</span>
```

### 2.4 表格

#### ✅ 正确

```html
<table class="data-table">
  <thead>
    <tr>
      <th>ID</th>
      <th>Type</th>
      <th>Message</th>
      <th class="hidden md:table-cell">Platform</th>
      <th>Date</th>
    </tr>
  </thead>
  <tbody>
    <template x-for="item in items" :key="item.id">
      <tr class="hover:bg-surface-800 cursor-pointer" @click="open(item.id)">
        <td x-text="item.id"></td>
        <td><span class="badge" :class="severityBadge(item)" x-text="item.exception_type"></span></td>
        <td class="max-w-xs truncate" x-text="item.exception_message"></td>
        <td class="hidden md:table-cell" x-text="item.platform || '-'"></td>
        <td class="text-gray-400 text-xs" x-text="formatDate(item.last_seen)"></td>
      </tr>
    </template>
  </tbody>
</table>
```

#### ❌ 严禁：手写 table 样式

```html
<!-- ❌ 禁止 —— 手写 w-full/border-collapse/th 样式/td 样式 -->
<table class="w-full border-collapse">
  <thead><tr><th class="text-left px-3 py-2 text-xs uppercase text-gray-500 border-b border-gray-800">...</th></tr></thead>
</table>
```

---

## 3. JavaScript 规范

### 3.1 全局 API 使用

#### ✅ 正确：使用全局函数

```html
<script>
document.addEventListener('alpine:init', () => {
  Alpine.data('myPage', () => ({
    items: [],
    async load() {
      const res = await fetch('/api/v1/crash-groups');  // ✅ CSRF 自动注入
      const data = await res.json();
      this.items = data.items || [];
    },
    async confirmThenDelete(id) {
      if (await Modal.confirm('Delete', 'Delete crash group #' + id + '?', 'Delete')) {
        await fetch('/api/v1/...', { method: 'DELETE' });
        await this.load();
      }
    },
    formatDate,  // ✅ 使用全局工具函数
    formatSize,  // ✅ 使用全局工具函数
  }));
});
</script>
```

#### ❌ 严禁：在页面中重复定义全局函数

```html
<!-- ❌ 禁止 —— 在页面中重复定义 formatDate -->
<script>
function formatDate(d) {  // ❌ 全局已有，此处重复
  if (!d) return '-';
  return new Date(d).toLocaleString();
}
</script>
```

#### ❌ 严禁：裸 fetch 不经过 CSRF

```html
<script>
// ❌ 禁止 —— 绕过全局 CSRF wrapper，POST 请求缺少 X-CSRF-Token
await fetch('/api/v1/...', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});
</script>
```

#### ❌ 严禁：使用 `var`

```html
<script>
var data = [];  // ❌ 禁止 var
var i = 0;      // ❌ 禁止 var
</script>
```

#### ❌ 严禁：超过 30 行的内联 `<script>`

```html
<!-- ❌ 禁止 —— 超过 30 行内联脚本应提取到 app.js 或页面级 JS -->
<script>
// ... 60 行逻辑 ...
</script>
```

### 3.2 数据表格模式

#### ✅ 正确：使用统一分页模式

```html
<div x-data="tablePage">
  <!-- 筛选栏 -->
  <div class="flex flex-wrap gap-3 mb-4">
    <input class="fc fc-sm w-48" placeholder="Search..." x-model="search"
           @keyup.enter="loadPage(1)">
    <select class="fc fc-sm" x-model="statusFilter" @change="loadPage(1)">
      <option value="">All Status</option>
      <option value="open">Open</option>
      <option value="resolved">Resolved</option>
    </select>
    <button class="btn btn-blue btn-sm" @click="loadPage(1)">Filter</button>
  </div>

  <!-- 表格 -->
  <table class="data-table">...</table>

  <!-- 分页 -->
  <div class="flex items-center justify-between mt-4">
    <span class="text-sm text-gray-500" x-text="'Total: ' + total"></span>
    <div class="flex gap-2">
      <button class="btn-page" :disabled="page <= 1" @click="loadPage(page - 1)">Prev</button>
      <span class="text-sm text-gray-400 py-1 px-2" x-text="page + ' / ' + totalPages"></span>
      <button class="btn-page" :disabled="page >= totalPages" @click="loadPage(page + 1)">Next</button>
    </div>
  </div>
</div>
```

#### ❌ 严禁：每页手写分页逻辑

```html
<script>
// ❌ 禁止 —— 每个列表页面重复实现分页/筛选
function paginate(items, page, size) { ... }
function renderPagination(total, page) { ... }
</script>
```

---

## 4. 状态处理规范

### 4.1 空状态

#### ✅ 正确

```html
<div x-show="items.length === 0 && !loading" class="text-center py-12 text-gray-500">
  <svg class="w-12 h-12 mx-auto mb-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
  </svg>
  <p class="text-lg mb-2">No crashes yet</p>
  <p class="text-sm">Crashes will appear here once your application starts reporting.</p>
</div>
```

#### ❌ 严禁：空列表无提示

```html
<!-- ❌ 禁止 —— 空列表时页面一片空白，用户不知发生了什么 -->
<div x-show="items.length === 0"></div>
```

### 4.2 加载状态

#### ✅ 正确

```html
<div x-show="loading" class="text-center py-8 text-gray-400">
  <div class="animate-spin inline-block w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full mr-2"></div>
  Loading...
</div>
```

#### ❌ 严禁：加载时无反馈

```html
<!-- ❌ 禁止 —— 用户不知道数据在加载中 -->
<div x-show="loading"></div>
```

### 4.3 错误状态

#### ✅ 正确

```html
<div x-show="error" class="bg-red-900/20 border border-red-800 text-red-400 rounded-lg p-4 mb-4">
  <div class="flex items-center gap-2">
    <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke-width="1.5"/><path d="M12 8v4m0 4h.01" stroke-width="1.5"/>
    </svg>
    <span x-text="error"></span>
  </div>
  <button class="btn btn-gray btn-sm mt-3" @click="loadPage(page)">Retry</button>
</div>
```

#### ❌ 严禁：吞掉错误

```html
<script>
// ❌ 禁止 —— 捕获错误但无用户反馈
try {
  await fetch('/api/v1/data');
} catch (e) {
  // 静默失败
}
</script>
```

### 4.4 成功消息

#### ✅ 正确

```html
<div x-show="success" class="bg-green-900/20 border border-green-800 text-green-400 rounded-lg p-4 mb-4"
     x-text="success" x-init="if(success) setTimeout(() => success = '', 3000)"></div>
```

---

## 5. 响应式设计

### 5.1 侧边栏

#### ✅ 正确

```html
<!-- 手机: 汉堡菜单按钮 (仅 <lg 可见) -->
<button class="lg:hidden p-1.5 rounded-lg hover:bg-gray-800" @click="sidebarOpen = !sidebarOpen">
  <svg class="w-5 h-5">...</svg>
</button>
```

#### ❌ 严禁：不考虑小屏

```html
<!-- ❌ 禁止 —— 手机端侧边栏永远可见，遮挡内容区 -->
<aside class="fixed top-0 left-0 h-full w-60 ...">  <!-- 缺少 lg:translate-x-0 和响应式切换 -->
```

### 5.2 表格列

#### ✅ 正确

```html
<th class="hidden md:table-cell">Platform</th>
<td class="hidden md:table-cell" x-text="item.platform"></td>
```

#### ❌ 严禁：小屏表格撑爆布局

```html
<!-- ❌ 禁止 —— 5+ 列在小屏挤成一团 -->
<table>
  <tr><td>ID</td><td>Type</td><td>Platform</td><td>Version</td><td>Date</td></tr>
</table>
<!-- 应该对次要列使用 hidden md:table-cell -->
```

---

## 6. 性能规范

### 6.1 ❌ 严禁：不必要的全量加载

```javascript
// ❌ 禁止 —— 一次性加载所有数据不设分页
async loadAll() {
  const res = await fetch('/api/v1/crash-groups?page_size=999999');
  this.items = data.items;  // 可能加载数千条
}
```

### 6.2 ❌ 严禁：缺少防抖的搜索

```html
<!-- ❌ 禁止 —— 每次按键都触发请求 -->
<input class="fc" @keyup="search()">
```

```html
<!-- ✅ 正确 —— 300ms 防抖 -->
<input class="fc" x-model="searchQuery"
       @keyup="clearTimeout(searchTimer); searchTimer = setTimeout(() => loadPage(1), 300)">
```

### 6.3 ❌ 严禁：在模板中拼接用户数据（XSS 风险）

```javascript
// ❌ 禁止 —— innerHTML 直接拼接用户数据
document.getElementById('output').innerHTML = '<div>' + userInput + '</div>';
```

```html
<!-- ✅ 正确 —— 使用 x-text（自动转义） -->
<span x-text="userInput"></span>
```

### 6.4 ❌ 严禁：同步阻塞操作

```javascript
// ❌ 禁止 —— 同步 XHR 阻塞 UI 线程
const xhr = new XMLHttpRequest();
xhr.open('GET', '/api/v1/data', false);  // false = 同步
xhr.send();
```

### 6.5 ❌ 严禁：在循环中频繁 DOM 操作

```javascript
// ❌ 禁止 —— 逐条插入 DOM
for (const item of items) {
  const el = document.createElement('tr');
  el.innerHTML = `<td>${item.id}</td>...`;
  tbody.appendChild(el);  // 每次触发 reflow
}
```

```html
<!-- ✅ 正确 —— Alpine.js 响应式渲染 -->
<template x-for="item in items" :key="item.id">
  <tr>...</tr>
</template>
```

---

## 7. 新增页面检查清单

1. [ ] 选择正确的分类（auth / app）
2. [ ] 放入正确的目录（`pages/auth/` 或 `pages/app/`）
3. [ ] 使用 `{{HEAD}}` partial — **不复制** head 内容
4. [ ] 使用已有 CSS 类（`.fc`, `.btn`, `.badge`, `.data-table`）— **不手写** 样式组合
5. [ ] 使用全局 JS 函数 (`Modal.*`, `formatDate`, `formatSize`, `secureLogout`) — **不重复** 定义
6. [ ] 数据表格使用统一分页/筛选模式 — **不手写** 分页逻辑
7. [ ] 在 `web.ts` 中注册路由，使用 `renderTemplate()` 或 `renderStandalone()`
8. [ ] 在 `template.ts` 的 `ROUTE_MAP` 中添加路由映射（app 页面）
9. [ ] 包含空状态 UI（无数据时）
10. [ ] 包含加载状态 UI（数据加载中时）
11. [ ] 包含错误状态 UI + 重试按钮（出错时）
12. [ ] 操作前使用 `Modal.confirm()` 确认（危险操作）
13. [ ] 搜索使用 300ms 防抖
14. [ ] 响应式设计：小屏可用（侧边栏切换 + 表格横向滚动 + 列隐藏）
15. [ ] 使用 `x-text` 而非 `innerHTML` 插入用户数据
16. [ ] 页面特定 `<script>` 不超过 30 行

---

*本指南约束所有 UI 相关的新增功能实现。Phase 6 必须逐条通过上述检查清单。*
