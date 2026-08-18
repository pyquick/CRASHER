# Lua 分析表

> 代码配置见 `profile.ts`,解析实现见 `parser.ts`,样例数据见 `samples/`。

## 语言标识

| 字段 | 值 |
|---|---|
| 语言 id | `lua` |
| 显示名 | Lua |
| runtime 提示 | `lua` |
| 内容自动检测 | `stack traceback:` 或 `file.lua:行: in ...` |

## 栈帧格式

| 格式 | 示例 | 文件/行号 |
|---|---|---|
| Lua 文件帧 | `/usr/share/lua/5.1/modules/game.lua:42: in function 'update'` | 提取 |
| C 函数帧 | `[C]: in function 'error'` | 无 |
| main chunk | `/app/src/main.lua:15: in main chunk` | 提取 |

## 框架代码模式(severity 分类)

| 模式 | 说明 |
|---|---|
| `^\[C\]` | C 函数 |
| `/lua/`, `/luajit/` | 运行时目录 |

## 异常建议表

| 异常类型 | 建议 |
|---|---|
| (默认) | lua-debug / mobdebug 远程调试,pcall() 防护 |

## 样例数据

| 文件 | 内容 |
|---|---|
| `samples/game.txt` | 游戏 Lua 栈(C 帧 + 模块帧 + main chunk) |
| `samples/simple.txt` | assert 失败简式栈 |

## 日志提取

无专属分支,使用通用帧模式提取。
