# Python 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `python` |
| 显示名 | Python |
| runtime 提示 | `python`, `python3` |
| 内容自动检测 | `Traceback` 起始或 `File "...", line N, in ...` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| Traceback File 行 | `File "/app/src/worker.py", line 42, in run` | 提取 |
| 异常行(附加到末帧) | `json.decoder.JSONDecodeError: ...` | 无 |

说明:Python 回溯为「外→内」打印,解析后反转为「内→外」(crash 帧在前)。

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `^site-packages`, `^lib/python`, `/python\d[\d.]*/` | 第三方/标准库 |
| `<frozen`, `<built-in` | 内建模块 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| AttributeError | hasattr() 或 try/except 防护 |
| KeyError | dict.get() 安全访问 |
| IndexError | 检查索引范围 |
| ValueError | 添加输入验证 |
| TypeError | isinstance() / 类型注解检查 |
| (默认) | try/except + pdb 调试 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/traceback.txt` | 标准库 + 用户代码混合回溯 |
| `samples/pytest.txt` | 测试断言失败回溯 |

## 日志提取

提取 `Traceback` 起始块(最多 50 行,遇异常行截止)。
