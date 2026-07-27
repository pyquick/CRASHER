import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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
    'symbol_list.html': '/web/symbols',
  };
  return map[name] ?? '/web/';
}

/**
 * GET /web/
 * Dashboard page.
 */
router.get('/', (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('dashboard.html', 'Dashboard - Crash Report Server'));
});

/**
 * GET /web/crashes
 * Crash list page.
 */
router.get('/crashes', (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('crash_list.html', 'Crash List - Crash Report Server'));
});

/**
 * GET /web/crashes/:id
 * Crash detail page.
 */
router.get('/crashes/:id', (_req: Request, res: Response): void => {
  res.type('html').send(renderTemplate('crash_detail.html', 'Crash Detail - Crash Report Server'));
});

/**
 * GET /web/symbols
 * Symbol management page.
 */
router.get('/symbols', (_req: Request, res: Response): void => {
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
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen">
  <div class="max-w-5xl mx-auto px-4 py-8">
    <h1 class="text-3xl font-bold mb-2">📋 API Documentation</h1>
    <p class="text-gray-400 mb-8">Unity 崩溃上报服务器 API 文档</p>

    <div class="space-y-6">
      <section class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">
          <span class="bg-green-600 text-white px-3 py-1 rounded text-sm mr-3">POST</span>
          /api/v1/crash-report
        </h2>
        <p class="text-gray-400 mb-4">提交崩溃报告。支持 JSON 和 multipart/form-data。</p>
        <h3 class="font-medium mb-2">JSON Body Parameters:</h3>
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-gray-700">
              <th class="text-left py-2 pr-4">字段</th>
              <th class="text-left py-2 pr-4">类型</th>
              <th class="text-left py-2">说明</th>
            </tr>
          </thead>
          <tbody class="text-gray-400">
            <tr><td class="py-1 pr-4"><strong>exception_type</strong>*</td><td class="pr-4">string</td><td>异常类型</td></tr>
            <tr><td class="py-1 pr-4">exception_message</td><td class="pr-4">string</td><td>异常消息</td></tr>
            <tr><td class="py-1 pr-4">stack_trace</td><td class="pr-4">string</td><td>堆栈跟踪</td></tr>
            <tr><td class="py-1 pr-4">log_text</td><td class="pr-4">string</td><td>Player.log 日志内容</td></tr>
            <tr><td class="py-1 pr-4">unity_version</td><td class="pr-4">string</td><td>Unity 版本</td></tr>
            <tr><td class="py-1 pr-4">platform</td><td class="pr-4">string</td><td>平台 (Android/iOS/Windows/...)</td></tr>
            <tr><td class="py-1 pr-4">device_model</td><td class="pr-4">string</td><td>设备型号</td></tr>
            <tr><td class="py-1 pr-4">app_version</td><td class="pr-4">string</td><td>应用版本号</td></tr>
            <tr><td class="py-1 pr-4">bundle_id</td><td class="pr-4">string</td><td>包名</td></tr>
          </tbody>
        </table>
      </section>

      <section class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">
          <span class="bg-blue-600 text-white px-3 py-1 rounded text-sm mr-3">GET</span>
          /api/v1/crash-groups
        </h2>
        <p class="text-gray-400">获取崩溃分组列表，支持分页和过滤。</p>
        <p class="text-sm text-gray-500 mt-2">Query params: page, page_size, status, search, platform, app_version, start_date, end_date, sort_by, sort_order</p>
      </section>

      <section class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">
          <span class="bg-blue-600 text-white px-3 py-1 rounded text-sm mr-3">GET</span>
          /api/v1/crash-groups/:id
        </h2>
        <p class="text-gray-400">获取单个崩溃分组详情及最近报告。</p>
      </section>

      <section class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">
          <span class="bg-yellow-600 text-white px-3 py-1 rounded text-sm mr-3">PUT</span>
          /api/v1/crash-groups/:id/status
        </h2>
        <p class="text-gray-400">更新崩溃分组状态。</p>
        <p class="text-sm text-gray-500 mt-2">Body: { "status": "open|resolved|ignored", "resolved_version"?: "1.2.4" }</p>
      </section>

      <section class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">
          <span class="bg-blue-600 text-white px-3 py-1 rounded text-sm mr-3">GET</span>
          /api/v1/crash-reports/:id
        </h2>
        <p class="text-gray-400">获取单条崩溃报告详情及附件信息。</p>
      </section>

      <section class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">
          <span class="bg-green-600 text-white px-3 py-1 rounded text-sm mr-3">POST</span>
          /api/v1/symbols
        </h2>
        <p class="text-gray-400">上传符号文件（multipart/form-data）。</p>
        <p class="text-sm text-gray-500 mt-2">Fields: file (required), platform, build_guid (required)</p>
      </section>

      <section class="bg-gray-800 rounded-lg p-6">
        <h2 class="text-xl font-semibold mb-4">
          <span class="bg-blue-600 text-white px-3 py-1 rounded text-sm mr-3">GET</span>
          /api/v1/stats/dashboard
        </h2>
        <p class="text-gray-400">获取仪表盘统计数据。</p>
      </section>
    </div>
  </div>
</body>
</html>
  `);
});

export default router;
