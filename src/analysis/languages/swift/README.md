# Swift 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `swift` |
| 显示名 | Swift |
| runtime 提示 | `swift` |
| 内容自动检测 | `N 模块 0xADDR 函数 + 偏移` 且含 `Thread` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| 带源信息 | `0 MyGame 0x102a3b4c5 GameScene.update(_:) + 120 (GameScene.swift:42:15)` | 提取 |
| 纯二进制 | `1 libdispatch.dylib 0x102a3b4e5 _dispatch_call_block_and_release + 24` | 无 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `libdispatch`, `libobjc`, `libsystem`, `libswift` | 系统库 |
| `CoreFoundation`, `Foundation`, `UIKit`, `SwiftUI`, `Combine` | Apple 框架 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| fatal error | 避免 `!` 强制解包,改用 if let / guard let |
| EXC_BAD_ACCESS | Xcode Zombies / Address Sanitizer |
| SIGABRT | 检查 assert/precondition |
| (默认) | Xcode 调试器 + Instruments |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/crash.txt` | Apple 崩溃报告(用户 + 框架帧) |
| `samples/thread.txt` | 纯二进制帧 |

## 日志提取

从首个 `N 模块 0x...` 行提取 50 行。
