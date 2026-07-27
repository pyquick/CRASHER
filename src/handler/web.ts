import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { config } from '../config.js';
import { createSessionToken, readSession, requireAuth } from '../middleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..', '..', 'web', 'templates');
const staticDir = resolve(__dirname, '..', '..', 'web', 'static');

const router = Router();

function renderTemplate(name: string, title: string): string {
  try {
    const base = readFileSync(resolve(templatesDir, 'layout.html'), 'utf-8');
    const content = readFileSync(resolve(templatesDir, name), 'utf-8');
    return base
      .replace('{{TITLE}}', title)
      .replace('{{SUBTITLE}}', title)
      .replace('{{CONTENT}}', controllerToRoute(name))
      .replace('{{BODY}}', content);
  } catch {
    return `<!DOCTYPE html><html><body><h1>Error: Template not found: ${name}</h1></body></html>`;
  }
}

function controllerToRoute(name: string): string {
  const map: Record<string, string> = {
    'dashboard.html': '/web/',
    'crash_list.html': '/web/crashes',
    'crash_detail.html': '/web/crashes',
    'feedback_list.html': '/web/feedback',
    'symbol_list.html': '/web/symbols',
  };
  return map[name] ?? '/web/';
}

// ---------- Public routes (no auth) ----------

/**
 * GET /web/login
 * Login page — public.
 */
router.get('/login', (_req: Request, res: Response): void => {
  // Already logged in? Redirect to dashboard
  const session = readSession(_req);
  if (session) {
    res.redirect('/web/');
    return;
  }

  const html = readFileSync(resolve(templatesDir, 'login.html'), 'utf-8');
  res.type('html').send(html);
});

/**
 * POST /web/login
 * Authenticate and set session cookie.
 */
router.post('/login', (req: Request, res: Response): void => {
  const { username, password } = req.body || {};
  const passwordHash = createHash('sha256').update(password || '').digest('hex');

  if (username === config.adminUsername && passwordHash === config.adminPasswordHash) {
    const token = createSessionToken(username);
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24h
      path: '/',
    });
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid username or password' });
  }
});

/**
 * POST /web/logout
 * Clear session cookie.
 */
router.post('/logout', (_req: Request, res: Response): void => {
  res.clearCookie('auth_token', { path: '/' });
  res.json({ success: true });
});

// ---------- Protected page routes (require login) ----------

/**
 * GET /web/
 * Dashboard page.
 */
router.get('/', requireAuth, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('dashboard.html', 'Dashboard - Crash Report Server'));
});

/**
 * GET /web/crashes
 * Crash list page.
 */
router.get('/crashes', requireAuth, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('crash_list.html', 'Crash List - Crash Report Server'));
});

/**
 * GET /web/crashes/:id
 * Crash detail page.
 */
router.get('/crashes/:id', requireAuth, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('crash_detail.html', 'Crash Detail - Crash Report Server'));
});

/**
 * GET /web/feedback
 * Player-submitted feedback management page.
 */
router.get('/feedback', requireAuth, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('feedback_list.html', 'Player Feedback - Crash Report Server'));
});

/**
 * GET /web/symbols
 * Symbol management page.
 */
router.get('/symbols', requireAuth, (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('symbol_list.html', 'Symbols - Crash Report Server'));
});

/**
 * GET /web/api-doc
 * Simple API documentation page.
 */
router.get('/api-doc', (_req: Request, res: Response): void => {
  res.type('html').send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Documentation - Crash Report Server</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .method-badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; min-width: 52px; text-align: center; }
    pre { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 14px 18px; overflow-x: auto; font-size: 0.8125rem; line-height: 1.6; }
    code { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 0.8125rem; }
    .section-card { background: #1e293b; border-radius: 12px; padding: 24px; border: 1px solid #334155; }
    .field-required { color: #f87171; }
    table th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.6875rem; font-weight: 500; }
    .tag-generic { background: rgba(96,165,250,0.15); color: #93c5fd; }
    .tag-unity { background: rgba(167,139,250,0.15); color: #c4b5fd; }
    .tag-device { background: rgba(52,211,153,0.15); color: #6ee7b7; }
    .tag-deprecated { background: rgba(251,191,36,0.15); color: #fcd34d; }
    .toc-link { transition: color 0.15s; }
    .toc-link:hover { color: #93c5fd; }
  </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <div class="max-w-5xl mx-auto px-4 py-8">
    <div class="mb-8">
      <h1 class="text-3xl font-bold mb-2">📋 API 文档</h1>
      <p class="text-gray-400">跨平台崩溃上报服务 · 通用 REST API · v1</p>
    </div>

    <!-- TOC -->
    <div class="section-card mb-8">
      <h2 class="text-lg font-semibold mb-3">📑 目录</h2>
      <ul class="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm text-gray-400">
        <li><a href="#generic" class="toc-link">1. 通用崩溃上报</a></li>
        <li><a href="#feedback" class="toc-link">2. 玩家主动反馈</a></li>
        <li><a href="#unity" class="toc-link">3. Unity 专属端点</a></li>
        <li><a href="#groups" class="toc-link">4. 崩溃分组</a></li>
        <li><a href="#reports" class="toc-link">5. 崩溃报告</a></li>
        <li><a href="#downloads" class="toc-link">6. 文件下载</a></li>
        <li><a href="#symbols" class="toc-link">7. 符号管理</a></li>
        <li><a href="#dump" class="toc-link">8. Dump 解析</a></li>
        <li><a href="#stats" class="toc-link">9. 统计与工具</a></li>
      </ul>
    </div>

    <!-- ============================================================ -->
    <!-- 1. Generic Crash Report -->
    <!-- ============================================================ -->
    <section id="generic" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">
        <span class="method-badge bg-green-600 text-white mr-3">POST</span>
        /api/v1/crash-report
      </h2>
      <p class="text-gray-400 mb-4">提交崩溃报告。支持 JSON 和 multipart/form-data 两种格式。适用于任意运行时（Node.js、Python、Go、Browser JS、C# 等）。</p>

      <h3 class="font-medium mb-3">📥 请求体参数 (JSON)</h3>

      <!-- Generic Runtime Fields -->
      <p class="text-xs text-gray-500 mb-2 mt-4"><span class="tag tag-generic">通用运行时</span> 跨平台通用字段</p>
      <table class="w-full text-sm border-collapse mb-4">
        <thead>
          <tr class="border-b border-gray-700 text-gray-500 text-xs uppercase">
            <th class="text-left py-2 pr-4">字段</th>
            <th class="text-left py-2 pr-4">类型</th>
            <th class="text-left py-2">说明</th>
          </tr>
        </thead>
        <tbody class="text-gray-400">
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><strong class="text-gray-200">exception_type</strong> <span class="field-required">*必填</span></td><td class="pr-4"><code>string</code></td><td>异常类型，如 TypeError, NullReferenceException, SIGSEGV</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">exception_message</td><td class="pr-4"><code>string</code></td><td>异常消息文本</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">stack_trace</td><td class="pr-4"><code>string</code></td><td>堆栈跟踪。运行时会自动识别栈格式用于 hash 分组</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">log_text</td><td class="pr-4"><code>string</code></td><td>完整日志文本 (单条最大 2 MB)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><strong>runtime</strong></td><td class="pr-4"><code>string</code></td><td>运行时环境: <code>node</code>, <code>browser</code>, <code>python</code>, <code>go</code>, <code>unity</code>, <code>csharp</code>, ...</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">runtime_version</td><td class="pr-4"><code>string</code></td><td>运行时版本，如 <code>20.11.0</code>, <code>3.12.3</code>, <code>2022.3.10f1</code></td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">framework</td><td class="pr-4"><code>string</code></td><td>框架/引擎: <code>express</code>, <code>react</code>, <code>django</code>, <code>gin</code>, <code>unity</code>, ...</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">environment</td><td class="pr-4"><code>string</code></td><td>部署环境: <code>production</code>, <code>staging</code>, <code>development</code></td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">server_name</td><td class="pr-4"><code>string</code></td><td>服务名 / 应用标识</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">release</td><td class="pr-4"><code>string</code></td><td>发布版本号 / Git commit hash</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">error_severity</td><td class="pr-4"><code>string</code></td><td>严重级别: <code>fatal</code>, <code>error</code>, <code>warning</code>, <code>info</code> (默认 error)</td></tr>
        </tbody>
      </table>

      <!-- Device/Environment Fields -->
      <p class="text-xs text-gray-500 mb-2 mt-4"><span class="tag tag-device">设备信息</span> 设备 & 环境上下文</p>
      <table class="w-full text-sm border-collapse mb-4">
        <thead>
          <tr class="border-b border-gray-700 text-gray-500 text-xs uppercase">
            <th class="text-left py-2 pr-4">字段</th>
            <th class="text-left py-2 pr-4">类型</th>
            <th class="text-left py-2">说明</th>
          </tr>
        </thead>
        <tbody class="text-gray-400">
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">platform</td><td class="pr-4"><code>string</code></td><td>操作系统平台: <code>Android</code>, <code>iOS</code>, <code>Windows</code>, <code>Linux</code>, <code>macOS</code>, ...</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">os_version</td><td class="pr-4"><code>string</code></td><td>操作系统版本</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">device_model</td><td class="pr-4"><code>string</code></td><td>设备型号</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">gpu_name</td><td class="pr-4"><code>string</code></td><td>GPU 名称</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">cpu_name</td><td class="pr-4"><code>string</code></td><td>CPU 名称</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">memory_mb</td><td class="pr-4"><code>number</code></td><td>设备内存 (MB)</td></tr>
        </tbody>
      </table>

      <!-- App Fields -->
      <p class="text-xs text-gray-500 mb-2 mt-4"><span class="tag tag-deprecated">应用信息</span> 版本 & 包信息</p>
      <table class="w-full text-sm border-collapse mb-4">
        <thead>
          <tr class="border-b border-gray-700 text-gray-500 text-xs uppercase">
            <th class="text-left py-2 pr-4">字段</th>
            <th class="text-left py-2 pr-4">类型</th>
            <th class="text-left py-2">说明</th>
          </tr>
        </thead>
        <tbody class="text-gray-400">
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">app_version</td><td class="pr-4"><code>string</code></td><td>应用版本号</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">bundle_id</td><td class="pr-4"><code>string</code></td><td>应用包名 / Bundle ID</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">client_timestamp</td><td class="pr-4"><code>string</code></td><td>客户端发生崩溃的时间戳 (ISO 8601)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">custom_data</td><td class="pr-4"><code>object | string</code></td><td>自定义附加数据 (JSON)</td></tr>
        </tbody>
      </table>

      <!-- Unity Fields -->
      <p class="text-xs text-gray-500 mb-2 mt-4"><span class="tag tag-unity">Unity 专属</span> 保持向前兼容</p>
      <table class="w-full text-sm border-collapse mb-4">
        <thead>
          <tr class="border-b border-gray-700 text-gray-500 text-xs uppercase">
            <th class="text-left py-2 pr-4">字段</th>
            <th class="text-left py-2 pr-4">类型</th>
            <th class="text-left py-2">说明</th>
          </tr>
        </thead>
        <tbody class="text-gray-400">
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">unity_version</td><td class="pr-4"><code>string</code></td><td>Unity 引擎版本，如 <code>2022.3.10f1</code></td></tr>
          <tr><td class="py-1.5 pr-4">scene_name</td><td class="pr-4"><code>string</code></td><td>发生崩溃的场景名</td></tr>
        </tbody>
      </table>

      <!-- Example -->
      <h3 class="font-medium mb-2 mt-6">📋 示例请求</h3>
      <h4 class="text-xs text-gray-500 mb-1 mt-3">Node.js (Express) 崩溃</h4>
      <pre><code>curl -X POST http://localhost:8080/api/v1/crash-report \\
  -H "Content-Type: application/json" \\
  -d '{
    "exception_type": "TypeError",
    "exception_message": "Cannot read properties of undefined (reading 'id')",
    "stack_trace": "at UserController.getUser (/app/controllers/user.js:42:15)\\n    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)",
    "runtime": "node",
    "runtime_version": "20.11.0",
    "framework": "express",
    "environment": "production",
    "server_name": "api-gateway",
    "release": "abc1234",
    "app_version": "1.5.2"
  }'</code></pre>

      <h4 class="text-xs text-gray-500 mb-1 mt-3">Python 崩溃</h4>
      <pre><code>curl -X POST http://localhost:8080/api/v1/crash-report \\
  -H "Content-Type: application/json" \\
  -d '{
    "exception_type": "ValueError",
    "exception_message": "invalid literal for int()",
    "stack_trace": "Traceback (most recent call last):\\n  File \"/app/main.py\", line 28, in process\\n    count = int(value)\\nValueError: invalid literal for int()",
    "runtime": "python",
    "runtime_version": "3.12.3",
    "framework": "fastapi",
    "environment": "production"
  }'</code></pre>

      <h4 class="text-xs text-gray-500 mb-1 mt-3">Multipart 表单上传 (含 dump 附件)</h4>
      <pre><code>curl -X POST http://localhost:8080/api/v1/crash-report \\
  -F "exception_type=NullReferenceException" \\
  -F "stack_trace=at PlayerController.Update () [0x00000] in ..." \\
  -F "runtime=unity" \\
  -F "runtime_version=2022.3.10f1" \\
  -F "attachments=@crash.dmp"</code></pre>

      <h3 class="font-medium mb-2 mt-4">📤 响应 (201 Created)</h3>
      <pre><code>{
  "id": 42,
  "group_id": 7,
  "is_new_group": false
}</code></pre>
      <p class="text-xs text-gray-500 mt-2">相同异常类型 + 堆栈 + 运行时的崩溃自动归入同一分组 (SHA256 hash)。</p>
    </section>


    <!-- ============================================================ -->
    <!-- 2. Player Feedback -->
    <!-- ============================================================ -->
    <section id="feedback" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">
        <span class="method-badge bg-green-600 text-white mr-3">POST</span>
        /api/v1/player-feedback
      </h2>
      <p class="text-gray-400 mb-4">提交玩家主动填写的 Bug、建议或其他反馈。该端点与自动崩溃上报分开存储，不会参与崩溃分组。支持 JSON，或使用 multipart/form-data 上传截图和日志附件。</p>

      <h3 class="font-medium mb-2">📥 请求字段</h3>
      <table class="w-full text-sm border-collapse mb-4">
        <thead><tr class="border-b border-gray-700 text-gray-500 text-xs uppercase"><th class="text-left py-2 pr-4">字段</th><th class="text-left py-2 pr-4">类型</th><th class="text-left py-2">说明</th></tr></thead>
        <tbody class="text-gray-400">
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><strong class="text-gray-200">title</strong> <span class="field-required">*必填</span></td><td class="pr-4"><code>string</code></td><td>反馈标题，最长 200 个字符</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><strong class="text-gray-200">description</strong> <span class="field-required">*必填</span></td><td class="pr-4"><code>string</code></td><td>玩家描述的复现步骤、期望结果和实际结果</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">category</td><td class="pr-4"><code>string</code></td><td><code>bug</code>（默认）、<code>suggestion</code> 或 <code>other</code></td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">severity</td><td class="pr-4"><code>string</code></td><td><code>low</code>、<code>normal</code>（默认）、<code>high</code> 或 <code>critical</code></td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">player_id / player_name / contact</td><td class="pr-4"><code>string</code></td><td>可选的玩家标识、显示名称和回访联系方式</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">app_version / platform / device_model / scene_name</td><td class="pr-4"><code>string</code></td><td>建议由 Unity 自动填充的版本和设备上下文</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4">client_timestamp</td><td class="pr-4"><code>string</code></td><td>玩家提交时的 ISO 8601 时间戳</td></tr>
          <tr><td class="py-1.5 pr-4">custom_data</td><td class="pr-4"><code>object | string</code></td><td>任意附加 JSON 数据</td></tr>
        </tbody>
      </table>

      <h3 class="font-medium mb-2 mt-4">📋 JSON 示例</h3>
      <pre><code>curl -X POST http://localhost:8080/api/v1/player-feedback \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "购买后无法装备新武器",
    "description": "在商店购买武器后，点击装备按钮没有任何反应。",
    "category": "bug",
    "severity": "high",
    "player_id": "player-123",
    "app_version": "2.0.0",
    "platform": "Android",
    "device_model": "Samsung Galaxy S24",
    "scene_name": "Shop"
  }'</code></pre>

      <h3 class="font-medium mb-2 mt-4">📎 上传截图或日志</h3>
      <p class="text-sm text-gray-400 mb-2">使用 <code>multipart/form-data</code> 时，将完整 JSON 放入 <code>feedback</code> 字段；可重复提交 <code>attachments</code> 文件字段，最多 10 个文件，单文件大小受 <code>MAX_ATTACHMENT_SIZE</code> 限制。</p>
      <pre><code>curl -X POST http://localhost:8080/api/v1/player-feedback \\
  -F 'feedback={"title":"任务卡住","description":"完成对话后无法继续","category":"bug"};type=application/json' \\
  -F "attachments=@screenshot.png" \\
  -F "attachments=@Player.log"</code></pre>

      <h3 class="font-medium mb-2 mt-4">📤 响应 (201 Created)</h3>
      <pre><code>{
  "id": 12,
  "status": "new",
  "attachments": [{ "id": 8, "filename": "screenshot.png", "file_size": 243901 }]
}</code></pre>

      <div class="mt-6 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3"><span class="method-badge bg-blue-600 text-white mr-3">GET</span>/api/v1/player-feedback</h2>
        <p class="text-gray-400 mb-3">获取玩家反馈列表。该管理接口需要登录后的会话 Cookie。</p>
        <p class="text-sm text-gray-400 mb-2">查询参数：<code>page</code>（默认 1）、<code>page_size</code>（默认 20，最大 100）、<code>status</code>（<code>new</code>、<code>in_progress</code>、<code>resolved</code>、<code>closed</code>）、<code>category</code> 和 <code>search</code>（标题、描述或玩家名称）。</p>
        <pre><code>curl http://localhost:8080/api/v1/player-feedback?status=new&amp;category=bug</code></pre>
      </div>

      <div class="mt-6 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3"><span class="method-badge bg-blue-600 text-white mr-3">GET</span>/api/v1/player-feedback/:id</h2>
        <p class="text-gray-400 mb-3">获取单条反馈详情及其附件元数据（需登录）。</p>
        <pre><code>curl http://localhost:8080/api/v1/player-feedback/12</code></pre>
      </div>

      <div class="mt-6 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3"><span class="method-badge bg-yellow-600 text-white mr-3">PUT</span>/api/v1/player-feedback/:id/status</h2>
        <p class="text-gray-400 mb-3">更新反馈处理状态（需登录）。</p>
        <pre><code>curl -X PUT http://localhost:8080/api/v1/player-feedback/12/status \\
  -H "Content-Type: application/json" \\
  -d '{"status":"in_progress"}'</code></pre>
        <p class="text-xs text-gray-500 mt-2"><code>status</code> 可选值：<code>new</code>、<code>in_progress</code>、<code>resolved</code>、<code>closed</code>。</p>
      </div>

      <div class="mt-6 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3"><span class="method-badge bg-blue-600 text-white mr-3">GET</span>/api/v1/download/player-feedback/attachment/:id</h2>
        <p class="text-gray-400">下载玩家反馈上传的单个附件（需登录）。</p>
      </div>
    </section>


    <!-- ============================================================ -->
    <section id="unity" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">
        <span class="method-badge bg-purple-600 text-white mr-3">POST</span>
        /api/v1/unity/crash-report
      </h2>
      <p class="text-gray-400 mb-4">Unity 专属崩溃上报端点。自动填充 <code>runtime="unity"</code>、<code>framework="unity"</code>，并将 <code>unity_version</code> 映射为 <code>runtime_version</code>。</p>

      <p class="text-sm text-gray-500 mb-3">接受与通用端点完全相同的参数。额外行为:</p>
      <ul class="list-disc list-inside text-sm text-gray-400 space-y-1 ml-2">
        <li>自动设置 <code>runtime = "unity"</code></li>
        <li>自动设置 <code>framework = "unity"</code></li>
        <li>如果没有提供 <code>runtime_version</code>，自动使用 <code>unity_version</code> 的值</li>
        <li>支持 Unity IL2CPP 栈格式的 hash 分组</li>
      </ul>

      <h4 class="text-xs text-gray-500 mb-1 mt-4">示例</h4>
      <pre><code>curl -X POST http://localhost:8080/api/v1/unity/crash-report \\
  -H "Content-Type: application/json" \\
  -d '{
    "exception_type": "NullReferenceException",
    "exception_message": "Object reference not set to an instance of an object",
    "stack_trace": "at PlayerController.Update () [0x00000] in /Assets/Scripts/PlayerController.cs:42",
    "unity_version": "2022.3.10f1",
    "platform": "Android",
    "device_model": "Samsung Galaxy S24",
    "os_version": "Android 14",
    "scene_name": "Level_01",
    "app_version": "1.2.3",
    "bundle_id": "com.example.mygame"
  }'</code></pre>

      <h3 class="font-medium mb-2 mt-4">📤 响应 (201 Created)</h3>
      <pre><code>{
  "id": 43,
  "group_id": 8,
  "is_new_group": true,
  "runtime": "unity"
}</code></pre>
    </section>

    <!-- ============================================================ -->
    <!-- 3. Crash Groups -->
    <!-- ============================================================ -->
    <section id="groups" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">
        <span class="method-badge bg-blue-600 text-white mr-3">GET</span>
        /api/v1/crash-groups
      </h2>
      <p class="text-gray-400 mb-4">获取崩溃分组列表，支持分页和多维筛选。</p>

      <h3 class="font-medium mb-2">🔍 查询参数</h3>
      <table class="w-full text-sm border-collapse mb-4">
        <thead>
          <tr class="border-b border-gray-700 text-gray-500 text-xs uppercase">
            <th class="text-left py-2 pr-4">参数</th>
            <th class="text-left py-2 pr-4">类型</th>
            <th class="text-left py-2 pr-4">默认值</th>
            <th class="text-left py-2">说明</th>
          </tr>
        </thead>
        <tbody class="text-gray-400">
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>page</code></td><td class="pr-4">number</td><td class="pr-4">1</td><td>页码</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>page_size</code></td><td class="pr-4">number</td><td class="pr-4">20</td><td>每页条数 (最大 100)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>status</code></td><td class="pr-4">string</td><td class="pr-4">-</td><td>状态筛选: <code>open</code>, <code>resolved</code>, <code>ignored</code></td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>runtime</code></td><td class="pr-4">string</td><td class="pr-4">-</td><td>运行时筛选: <code>node</code>, <code>python</code>, <code>go</code>, <code>unity</code>, ...</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>environment</code></td><td class="pr-4">string</td><td class="pr-4">-</td><td>环境筛选: <code>production</code>, <code>staging</code>, <code>development</code></td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>platform</code></td><td class="pr-4">string</td><td class="pr-4">-</td><td>平台筛选: <code>Android</code>, <code>iOS</code>, <code>Windows</code>, ...</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>app_version</code></td><td class="pr-4">string</td><td class="pr-4">-</td><td>版本号筛选</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>search</code></td><td class="pr-4">string</td><td class="pr-4">-</td><td>搜索异常类型或消息 (模糊匹配)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>start_date</code></td><td class="pr-4">string</td><td class="pr-4">-</td><td>起始日期 (ISO 8601)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>end_date</code></td><td class="pr-4">string</td><td class="pr-4">-</td><td>结束日期 (ISO 8601)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>sort_by</code></td><td class="pr-4">string</td><td class="pr-4">last_seen</td><td>排序字段: <code>last_seen</code>, <code>first_seen</code>, <code>total_count</code></td></tr>
          <tr><td class="py-1.5 pr-4"><code>sort_order</code></td><td class="pr-4">string</td><td class="pr-4">desc</td><td>排序方向: <code>asc</code>, <code>desc</code></td></tr>
        </tbody>
      </table>

      <h3 class="font-medium mb-2 mt-4">📤 响应</h3>
      <pre><code>{
  "items": [{
    "id": 7,
    "crash_hash": "a1b2c3d4e5f6a7b8",
    "exception_type": "TypeError",
    "exception_message": "Cannot read properties of undefined",
    "first_seen": "2026-07-20T08:00:00.000Z",
    "last_seen": "2026-07-27T12:30:00.000Z",
    "total_count": 42,
    "status": "open",
    "resolved_version": ""
  }],
  "total": 1,
  "page": 1,
  "page_size": 20,
  "total_pages": 1
}</code></pre>

      <!-- Crash Group Detail -->
      <div class="mt-6 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3">
          <span class="method-badge bg-blue-600 text-white mr-3">GET</span>
          /api/v1/crash-groups/:id
        </h2>
        <p class="text-gray-400 mb-3">获取单个崩溃分组详情及最近的崩溃报告列表。</p>
        <h4 class="text-xs text-gray-500 mb-1">示例</h4>
        <pre><code>curl http://localhost:8080/api/v1/crash-groups/7</code></pre>
        <h4 class="text-xs text-gray-500 mb-1 mt-3">响应</h4>
        <pre><code>{
  "id": 7,
  "crash_hash": "a1b2c3d4e5f6a7b8",
  "exception_type": "TypeError",
  "exception_message": "...",
  "first_seen": "...",
  "last_seen": "...",
  "total_count": 42,
  "status": "open",
  "recent_reports": [ /* CrashReport[] — 最多 20 条 */ ]
}</code></pre>
      </div>

      <!-- Update Status -->
      <div class="mt-6 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3">
          <span class="method-badge bg-yellow-600 text-white mr-3">PUT</span>
          /api/v1/crash-groups/:id/status
        </h2>
        <p class="text-gray-400 mb-3">更新崩溃分组状态 (解决/忽略)。</p>
        <h4 class="text-xs text-gray-500 mb-1">请求体</h4>
        <pre><code>{ "status": "resolved", "resolved_version": "1.2.5" }</code></pre>
        <p class="text-xs text-gray-500 mt-2"><code>status</code> 可选值: <code>open</code>, <code>resolved</code>, <code>ignored</code>。<code>resolved_version</code> 可选，记录修复版本。</p>
        <h4 class="text-xs text-gray-500 mb-1 mt-3">示例</h4>
        <pre><code>curl -X PUT http://localhost:8080/api/v1/crash-groups/7/status \\
  -H "Content-Type: application/json" \\
  -d '{"status": "resolved", "resolved_version": "1.2.5"}'</code></pre>
        <h4 class="text-xs text-gray-500 mb-1 mt-3">响应</h4>
        <pre><code>{ "success": true }</code></pre>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- 4. Crash Reports -->
    <!-- ============================================================ -->
    <section id="reports" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">
        <span class="method-badge bg-blue-600 text-white mr-3">GET</span>
        /api/v1/crash-reports
      </h2>
      <p class="text-gray-400 mb-4">获取单条崩溃报告列表，支持按分组、平台、版本筛选。</p>

      <h3 class="font-medium mb-2">🔍 查询参数</h3>
      <table class="w-full text-sm border-collapse mb-4">
        <thead>
          <tr class="border-b border-gray-700 text-gray-500 text-xs uppercase">
            <th class="text-left py-2 pr-4">参数</th>
            <th class="text-left py-2 pr-4">类型</th>
            <th class="text-left py-2">说明</th>
          </tr>
        </thead>
        <tbody class="text-gray-400">
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>page</code></td><td class="pr-4">number</td><td>页码 (默认 1)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>page_size</code></td><td class="pr-4">number</td><td>每页条数 (默认 20, 最大 100)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>group_id</code></td><td class="pr-4">number</td><td>按崩溃分组 ID 筛选</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>platform</code></td><td class="pr-4">string</td><td>平台筛选</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>app_version</code></td><td class="pr-4">string</td><td>版本号筛选</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><code>start_date</code></td><td class="pr-4">string</td><td>起始日期</td></tr>
          <tr><td class="py-1.5 pr-4"><code>end_date</code></td><td class="pr-4">string</td><td>结束日期</td></tr>
        </tbody>
      </table>

      <div class="mt-6 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3">
          <span class="method-badge bg-blue-600 text-white mr-3">GET</span>
          /api/v1/crash-reports/:id
        </h2>
        <p class="text-gray-400 mb-3">获取单条崩溃报告详情，包含附件列表和 dump 解析信息。</p>
        <h4 class="text-xs text-gray-500 mb-1">响应</h4>
        <pre><code>{
  "id": 42,
  "group_id": 7,
  "exception_type": "TypeError",
  "exception_message": "...",
  "stack_trace": "...",
  "runtime": "node",
  "runtime_version": "20.11.0",
  "framework": "express",
  "environment": "production",
  "server_name": "api-gateway",
  "release": "abc1234",
  "error_severity": "error",
  "platform": "Linux",
  "app_version": "1.5.2",
  "dump_info": "...",
  "created_at": "2026-07-27T12:30:00.000Z",
  "attachments": [
    { "id": 1, "filename": "crash.dmp", "content_type": "application/octet-stream",
      "file_size": 147200, "download_url": "/api/v1/download/attachment/1" }
  ]
}</code></pre>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- 5. Downloads -->
    <!-- ============================================================ -->
    <section id="downloads" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">⬇️ 文件下载端点</h2>

      <div class="space-y-4">
        <div class="border-l-2 border-blue-500 pl-4">
          <h3 class="font-medium">
            <span class="method-badge bg-blue-600 text-white mr-2 text-xs">GET</span>
            /api/v1/download/report/:id
          </h3>
          <p class="text-sm text-gray-400 mt-1">下载单条崩溃报告的完整 JSON (含附件元数据)。</p>
          <pre class="mt-2"><code>curl -O http://localhost:8080/api/v1/download/report/42
# → crash-report-42.json</code></pre>
        </div>

        <div class="border-l-2 border-blue-500 pl-4">
          <h3 class="font-medium">
            <span class="method-badge bg-blue-600 text-white mr-2 text-xs">GET</span>
            /api/v1/download/group/:id
          </h3>
          <p class="text-sm text-gray-400 mt-1">下载整个崩溃分组的 JSON (含分组信息和所有报告)。</p>
          <pre class="mt-2"><code>curl -O http://localhost:8080/api/v1/download/group/7
# → crash-group-7.json</code></pre>
        </div>

        <div class="border-l-2 border-blue-500 pl-4">
          <h3 class="font-medium">
            <span class="method-badge bg-blue-600 text-white mr-2 text-xs">GET</span>
            /api/v1/download/dump/:reportId
          </h3>
          <p class="text-sm text-gray-400 mt-1">下载崩溃报告的 dump 解析结果 JSON (含附件下载链接)。</p>
          <pre class="mt-2"><code>curl -O http://localhost:8080/api/v1/download/dump/42
# → dump-info-42.json</code></pre>
        </div>

        <div class="border-l-2 border-blue-500 pl-4">
          <h3 class="font-medium">
            <span class="method-badge bg-blue-600 text-white mr-2 text-xs">GET</span>
            /api/v1/download/attachment/:id
          </h3>
          <p class="text-sm text-gray-400 mt-1">下载原始附件文件 (dump 文件、日志文件等)。</p>
          <pre class="mt-2"><code>curl -O http://localhost:8080/api/v1/download/attachment/1
# → crash.dmp (原始二进制)</code></pre>
        </div>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- 6. Symbols -->
    <!-- ============================================================ -->
    <section id="symbols" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">
        <span class="method-badge bg-green-600 text-white mr-3">POST</span>
        /api/v1/symbols
      </h2>
      <p class="text-gray-400 mb-4">上传符号文件 (multipart/form-data)，用于 dump 符号化。</p>

      <h3 class="font-medium mb-2">📥 表单字段</h3>
      <table class="w-full text-sm border-collapse mb-4">
        <thead>
          <tr class="border-b border-gray-700 text-gray-500 text-xs uppercase">
            <th class="text-left py-2 pr-4">字段</th>
            <th class="text-left py-2 pr-4">类型</th>
            <th class="text-left py-2">说明</th>
          </tr>
        </thead>
        <tbody class="text-gray-400">
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><strong class="text-gray-200">file</strong> <span class="field-required">*必填</span></td><td class="pr-4">file</td><td>符号文件 (最大 500 MB)</td></tr>
          <tr class="border-b border-gray-700/30"><td class="py-1.5 pr-4"><strong>build_guid</strong> <span class="field-required">*必填</span></td><td class="pr-4">string</td><td>构建 GUID，用于匹配 dump</td></tr>
          <tr><td class="py-1.5 pr-4">platform</td><td class="pr-4">string</td><td>平台标识 (默认 unknown)</td></tr>
        </tbody>
      </table>

      <pre class="mt-2"><code>curl -X POST http://localhost:8080/api/v1/symbols \\
  -F "file=@libil2cpp.sym.so" \\
  -F "build_guid=a1b2c3d4e5f6a7b8" \\
  -F "platform=Android"</code></pre>

      <div class="mt-6 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3">
          <span class="method-badge bg-blue-600 text-white mr-3">GET</span>
          /api/v1/symbols
        </h2>
        <p class="text-gray-400 mb-2">列出已上传的符号文件。</p>
        <p class="text-sm text-gray-500">Query: <code>page</code>, <code>page_size</code>, <code>platform</code>, <code>build_guid</code></p>
      </div>

      <div class="mt-4 pt-4 border-t border-gray-700">
        <h2 class="text-lg font-semibold mb-3">
          <span class="method-badge bg-red-600 text-white mr-3">DELETE</span>
          /api/v1/symbols/:id
        </h2>
        <p class="text-gray-400 mb-2">删除指定符号文件 (同时删除磁盘文件)。</p>
        <pre><code>curl -X DELETE http://localhost:8080/api/v1/symbols/1</code></pre>
        <h4 class="text-xs text-gray-500 mt-2">响应</h4>
        <pre><code>{ "success": true }</code></pre>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- 7. Dump Parsing -->
    <!-- ============================================================ -->
    <section id="dump" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">🔬 Dump 解析</h2>
      <p class="text-gray-400 mb-4">服务器内置 dump 解析模块，上传的附件自动检测格式并解析。解析结果存储在 <code>dump_info</code> 字段中。</p>

      <h3 class="font-medium mb-3">支持的 Dump 格式</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-gray-700 text-gray-500 text-xs uppercase">
              <th class="text-left py-2 pr-4">格式</th>
              <th class="text-left py-2 pr-4">扩展名</th>
              <th class="text-left py-2">解析内容</th>
            </tr>
          </thead>
          <tbody class="text-gray-400">
            <tr class="border-b border-gray-700/30">
              <td class="py-2 pr-4"><strong class="text-gray-200">Android Tombstone</strong></td>
              <td class="pr-4"><code>.txt</code>, <code>.tombstone</code></td>
              <td>Signal, fault address, backtrace, memory map, build fingerprint, abort message</td>
            </tr>
            <tr class="border-b border-gray-700/30">
              <td class="py-2 pr-4"><strong class="text-gray-200">iOS/macOS Crash</strong></td>
              <td class="pr-4"><code>.crash</code>, <code>.ips</code></td>
              <td>Exception type, signal, crashed thread, all thread backtraces, binary images, registers</td>
            </tr>
            <tr class="border-b border-gray-700/30">
              <td class="py-2 pr-4"><strong class="text-gray-200">Windows Minidump</strong></td>
              <td class="pr-4"><code>.dmp</code>, <code>.mdmp</code></td>
              <td>System info (OS/CPU), exception record, thread list, module list</td>
            </tr>
            <tr>
              <td class="py-2 pr-4"><strong class="text-gray-200">Unity Log</strong></td>
              <td class="pr-4"><code>.log</code>, <code>.txt</code></td>
              <td>Exception lines, stack traces, crash context (前后行), Fatal Error / signal markers</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="text-sm text-gray-500 mt-4">解析器通过文件扩展名和内容特征 (<em>heuristics</em>) 自动识别格式。上传任意 dump 作为 <code>attachments</code> 字段即可自动解析。</p>
    </section>

    <!-- ============================================================ -->
    <!-- 8. Stats & Utilities -->
    <!-- ============================================================ -->
    <section id="stats" class="section-card mb-6">
      <h2 class="text-xl font-semibold mb-4">📊 统计与工具端点</h2>

      <div class="space-y-4">
        <div class="border-l-2 border-blue-500 pl-4">
          <h3 class="font-medium">
            <span class="method-badge bg-blue-600 text-white mr-2 text-xs">GET</span>
            /api/v1/stats/dashboard
          </h3>
          <p class="text-sm text-gray-400 mt-1">获取仪表盘统计数据。</p>
          <p class="text-xs text-gray-500 mt-1">返回: total_crashes, total_groups, open_groups, resolved_groups, crashes_today, crashes_week, top_crashes[], platform_distribution[], version_distribution[], runtime_distribution[], daily_trend[]</p>
          <pre class="mt-2"><code>curl http://localhost:8080/api/v1/stats/dashboard</code></pre>
        </div>

        <div class="border-l-2 border-blue-500 pl-4">
          <h3 class="font-medium">
            <span class="method-badge bg-blue-600 text-white mr-2 text-xs">GET</span>
            /api/v1/platforms
          </h3>
          <p class="text-sm text-gray-400 mt-1">获取所有已知平台列表 (去重)。</p>
          <pre class="mt-2"><code>curl http://localhost:8080/api/v1/platforms
# → ["Android", "iOS", "Windows", "Linux"]</code></pre>
        </div>

        <div class="border-l-2 border-blue-500 pl-4">
          <h3 class="font-medium">
            <span class="method-badge bg-blue-600 text-white mr-2 text-xs">GET</span>
            /api/v1/versions
          </h3>
          <p class="text-sm text-gray-400 mt-1">获取所有已知版本号列表 (去重，最多 50 个，倒序)。</p>
          <pre class="mt-2"><code>curl http://localhost:8080/api/v1/versions
# → ["1.5.2", "1.5.1", "1.5.0"]</code></pre>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <div class="text-center text-xs text-gray-600 mt-8 pb-8">
      <p>Crash Report Server · 跨平台崩溃上报服务</p>
      <p class="mt-1">Base URL: <code class="text-gray-500">http://localhost:8080/api/v1</code></p>
    </div>
  </div>
</body>
</html>
  `);
});

export default router;
