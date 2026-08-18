# Ruby 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `ruby` |
| 显示名 | Ruby |
| runtime 提示 | `ruby`, `rb` |
| 内容自动检测 | `from /path/file.rb:行:in \`method\`` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| from 行 | `from /app/lib/workers/job_worker.rb:42:in \`perform'` | 提取 |
| 无 from 前缀 | `/app/lib/job.rb:42:in \`run'` | 提取 |
| block | `/app/lib/job.rb:10:in \`block in run'` | 提取 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `/gems/`, `/ruby/`, `/usr/lib/ruby` | 标准库/gem |
| `<internal:` | 内部方法 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| NoMethodError | respond_to? 检查或确保对象类型 |
| NameError | 检查拼写/定义顺序 |
| (默认) | byebug / pry 调试 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/rails.txt` | Rails 风格 from 回溯 |
| `samples/simple.txt` | 无 from 前缀简式栈 |

## 日志提取

筛选含 `.rb:<行号>` 的行。
