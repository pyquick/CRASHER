# Java / Kotlin 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `java`, `kotlin` |
| 显示名 | Java / Kotlin |
| runtime 提示 | `java`, `jvm`, `kotlin` |
| 内容自动检测 | `at pkg.Class.method(File.java:行)` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| 标准帧 | `at com.example.service.UserService.getDisplayName(UserService.java:42)` | 提取 |
| Kotlin | `at com.example.app.MainActivity.onCreate(MainActivity.kt:25)` | 提取 |
| 省略行 | `... 23 more` | 跳过 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `^java\.`, `^javax\.`, `^jakarta\.`, `^sun\.`, `^jdk\.` | JDK |
| `^org\.springframework\.`, `^org\.hibernate\.` | 主流框架 |
| `^kotlin\.` (kotlin) | Kotlin 标准库 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| NullPointerException | 调用前检查 null / requireNonNull |
| ArrayIndexOutOfBoundsException | 检查索引范围 |
| ClassCastException | instanceof 检查或泛型 |
| IllegalArgumentException | 参数校验 |
| ConcurrentModificationException | 迭代时勿修改集合 |
| (默认) | 断点调试 / IntelliJ 调试器 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/java.txt` | Spring 服务栈(Caused by + 省略行) |
| `samples/kotlin.txt` | Android Kotlin 栈 |

## 日志提取

从 `log_text` 中筛选 `^\s*at\s+` 行。
