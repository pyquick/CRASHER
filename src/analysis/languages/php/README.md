# PHP 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `php` |
| 显示名 | PHP |
| runtime 提示 | `php` |
| 内容自动检测 | `#N /path/file.php(行)` 或 `PHP Fatal error:` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| 编号帧 | `#0 /var/www/html/app/Calculator.php(42): App\Calculator->divide(10, 0)` | 提取 |
| 错误行(回退) | `PHP Fatal error: Uncaught Exception: ... in /path/file.php:42` | 提取 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `/vendor/` | Composer 依赖 |
| `/var/www` | 站点根 |
| `[internal` | 内部函数 |
| `require|include|eval|spl_autoload` | 加载器 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| Fatal error | 检查类名前缀和函数拼写 |
| Uncaught Error / Exception | try/catch 包裹 |
| (默认) | 开启 xdebug 获取详细栈 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/fatal.txt` | Fatal error + 完整 Stack trace |
| `samples/simple.txt` | 简式编号帧 |

## 日志提取

从 `Stack trace:` 或首个 `#N ...php(` 行提取 40 行。
