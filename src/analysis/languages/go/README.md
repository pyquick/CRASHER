# Go 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `go` |
| 显示名 | Go |
| runtime 提示 | `go`, `golang` |
| 内容自动检测 | `goroutine N` / `panic:` 或 ≥2 行 `pkg.Func(...)` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| 函数行 + 文件行 | `main.processRequest(0xc0000b4000)` / `\t/app/src/main.go:42 +0x1a5` | 提取 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `^runtime\.`, `^sync\.`, `^reflect\.`, `^syscall\.` | 标准库 |
| `^internal/` | Go 内部包 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| panic | 检查 nil 指针、越界切片、类型断言失败 |
| runtime error | 检查 goroutine 共享状态访问 |
| (默认) | `-race` 检测数据竞争,delve 调试 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/panic.txt` | nil 指针 panic 完整栈 |
| `samples/goroutine-leak.txt` | goroutine 阻塞栈 |

## 日志提取

从 `panic:` 或 `goroutine` 起始行提取后续 40 行。
