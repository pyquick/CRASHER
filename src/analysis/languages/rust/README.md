# Rust 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `rust` |
| 显示名 | Rust |
| runtime 提示 | `rust`, `rs` |
| 内容自动检测 | `thread '...' panicked at` 或编号回溯,且含 `.rs:` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| panicked at(内联) | `panicked at '...', src/game/board.rs:42:15` | 提取 |
| 编号帧 + at 行 | `2: game::board::get_cell` / `at src/game/board.rs:42:15` | 提取 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `^std::`, `^core::`, `^alloc::` | 标准库 |
| `^rust_begin_unwind`, `^panic_unwind` | panic 运行时 |
| `<\w+ as core::` | trait 实现 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| panicked at | 检查 unwrap/expect 调用或越界访问 |
| (默认) | `RUST_BACKTRACE=full` + gdb/lldb |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/panic.txt` | 越界 panic + 完整编号回溯 |
| `samples/thread-panic.txt` | 工作线程 unwrap 失败 |

## 日志提取

从 `panicked at` 或 `stack backtrace:` 起始提取 50 行。
