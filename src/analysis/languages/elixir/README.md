# Elixir / Erlang 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `elixir`, `erlang` |
| 显示名 | Elixir / Erlang |
| runtime 提示 | `elixir`, `exs`, `erlang`, `erl` |
| 内容自动检测 | 不支持(需 runtime 提示) |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| BEAM 帧 | `(elixir 1.15.0) lib/enum.ex:2510: Enum.reduce/3` | 提取 |
| Erlang | `(stdlib 4.2) lists.erl:1462: :lists.do_map/2` | 提取 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `(elixir `, `(stdlib `, `(kernel `, `(mix `, `:erlang.` (elixir) | OTP/标准库 |
| `(stdlib `, `(kernel `, `(erts ` (erlang) | OTP |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| (默认 elixir) | IEx.pry / :debugger.start |
| (默认 erlang) | :debugger.start() / dbg 追踪 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/elixir.txt` | Mix 项目栈(含 OTP 帧) |
| `samples/erlang.txt` | Erlang 退出异常栈 |

## 日志提取

无专属分支,使用通用帧模式提取。
