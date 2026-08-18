# C++ / C 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `cpp`, `c` |
| 显示名 | C++ / C |
| runtime 提示 | `cpp`, `c++`, `unreal`, `native`, `c` |
| 内容自动检测 | `#N 0xADDR` 或 `(Class::Method)` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| GDB | `#0 0x7f8a... in Server::ProcessRequest() from /lib/libserver.so` | 模块路径,无行号 |
| at 格式 | `Class::Method() at /path/file.cpp:42` | 提取 |
| 地址格式 | `/lib/libunity.so(+0x12345) [0x7f8a...]` | 模块 + 地址 |
| Windows | `game.dll!Player::Update()` | 模块 + 函数 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `^std::`, `^boost::`, `^absl::` | 标准库 |
| `^libc`, `^lib\w+\.so`, `\.dylib`, `\.dll`, `^glibc`, `^pthread` | 系统/动态库 |
| `^__` | 编译器内部符号 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| SIGSEGV | 使用 AddressSanitizer / Valgrind 定位内存问题 |
| SIGABRT | 检查 assert 失败或未捕获异常 |
| SIGFPE | 检查除零与整数溢出 |
| (默认) | `-g` 编译 + gdb/lldb 或 ASan 调试 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/gdb.txt` | GDB 格式回溯 |
| `samples/windows.txt` | Windows `module!function` 格式 |
| `samples/addr.txt` | `模块(+偏移)[地址]` 格式 |

## 日志提取

无专属分支,使用通用帧模式提取。
