# Dart / Flutter 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `dart` |
| 显示名 | Dart / Flutter |
| runtime 提示 | `dart`, `flutter` |
| 内容自动检测 | `package:xxx.dart 行:列` 或 `dart:xxx 行:列` 行首格式 |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| 简式 | `package:my_app/src/screens/home.dart 42:7 HomeScreen.build` | 提取 |
| hash 格式 | `#0 GameRenderer.render (package:my_game/src/renderer.dart:42:7)` | 提取 |
| 核心库 | `#2 _RootZone.runUnary (dart:async/zone.dart:1650:54)` | 提取 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `dart:` | Dart 核心库 |
| `package:flutter`, `package:meta`, `package:collection` | Flutter 框架 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| NoSuchMethodError | 检查方法名与参数类型 |
| NullThrownError | 抛出 Error/Exception 子类 |
| TypeError | 泛型/类型检查 |
| (默认) | flutter analyze + Dart DevTools |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/flutter.txt` | Flutter hash 格式栈 |
| `samples/plain.txt` | 简式 package: 格式栈 |

## 日志提取

筛选 `package:` / `dart:` 起始行。
