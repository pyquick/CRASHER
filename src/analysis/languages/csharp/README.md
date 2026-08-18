# C# / Unity 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `csharp` |
| 显示名 | C# / Unity |
| runtime 提示 | `unity`, `csharp`, `dotnet`, `.net` |
| 内容自动检测 | `at Xxx.Yyy ... in <path>:<line>` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| Unity 标准 | `at PlayerController.Update () [0x0001f] in <8f2c...>:0` | `<hash>` 剥离,无有效路径 |
| Unity 源路径 | `at GameManager.Start () [0x00010] in C:\build\Assets\Scripts\GameManager.cs:line 30` | 提取 |
| .NET 控制台 | `at MyApp.Program.Main(String[] args) in /home/.../Program.cs:line 15` | 提取 |
| 无文件信息(回退) | `at EnemySpawner.Update ()` | 无 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `^System\.` | .NET 基础库 |
| `^UnityEngine\.` | Unity 引擎 |
| `^UnityEditor\.` | Unity 编辑器 |
| `^Microsoft\.`, `^mscorlib`, `^Mono\.`, `^netstandard` | 框架 / 运行时 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| NullReferenceException | 访问对象成员前加入判空逻辑 |
| ArgumentNullException | 确保参数不为 null |
| IndexOutOfRangeException | 检查数组/列表索引范围 |
| InvalidOperationException | 检查操作前置条件 |
| KeyNotFoundException | 使用 TryGetValue 或先检查 key |
| (默认) | 使用带完整调试符号的开发构建复现 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/unity-nullref.txt` | Unity NullReferenceException 完整栈(框架帧 + 用户帧) |
| `samples/unity-simple.txt` | 无文件信息的简式栈 |
| `samples/dotnet-console.txt` | .NET 控制台应用栈 |

## 日志提取

从 `log_text` 中筛选 `^\s*at\s+` 行作为栈帧。
