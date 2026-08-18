# JavaScript / TypeScript / Node / Browser 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `javascript`, `typescript`, `node`, `browser` |
| 显示名 | JavaScript / TypeScript / Node.js / Browser JavaScript |
| runtime 提示 | `node`, `nodejs`, `node.js`, `bun`, `deno`, `browser`, `web`, `frontend`, `javascript`, `js`, `typescript`, `ts` |
| 内容自动检测 | `at ... (file.js:行:列)` 且文件扩展为 js/ts 系,或 ≥2 行 `at` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| 具名函数 | `at OrderService.processOrders (/app/src/services/order.js:42:15)` | 提取 |
| 匿名帧 | `at https://example.com/static/js/app.js:120:9` | 提取 |
| async | `at async OrderController.list (...)` | 提取 |
| Node 内部 | `at processTicksAndRejections (node:internal/process/task_queues:95:5)` | 提取 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `node:internal`, `processTicksAndRejections` | Node 内部 |
| `node_modules` | 第三方依赖 |
| `<anonymous>` | 匿名函数 |
| `^webpack`, `^__webpack`, `@chrome-extension` (browser) | 打包器/浏览器扩展 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| TypeError | 可选链 (?.) 或空值检查 |
| ReferenceError | 检查变量作用域声明 |
| SyntaxError | 检查括号/引号/逗号 |
| RangeError | 检查无限递归或非法数组长度 |
| (默认) | DevTools / node --inspect 调试 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/node.txt` | Node.js 服务端栈 |
| `samples/browser.txt` | 浏览器 CDN 脚本栈 |
| `samples/webpack.txt` | webpack 打包产物栈 |

## 日志提取

从 `log_text` 中筛选 `^\s*at\s+` 行。
