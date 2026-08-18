# 崩溃分析引擎 (Crash Analysis)

> 栈帧解析、崩溃定位与源码关联分析。每种语言独立文件夹,通用逻辑在 `common/`。

## 目录结构

```
analysis/
├── index.ts                  # 公开导出
├── types.ts                  # 共享类型 + LanguageProfile(分析表接口)
├── parser.ts                 # 薄入口:语言检测 + 解析分发
├── registry.ts               # 13 个语言 profile + parser 注册表
├── analyzer.ts               # analyzeCrash 编排
├── common/                   # 通用逻辑(语言无关)
│   ├── paths.ts              #   路径归一化 / 模块名提取
│   ├── severity.ts           #   严重度分类(框架模式取自各语言 profile)
│   ├── tree.ts               #   崩溃文件树构建
│   ├── summary.ts            #   触发点 / 摘要 / 建议
│   ├── source.ts             #   源码快照关联分析
│   ├── generic.ts            #   通用回退解析 + 日志帧提取
│   └── __tests__/            #   common 单元测试
└── languages/<lang>/         # 每语言一个文件夹
    ├── parser.ts             #   该语言栈帧解析
    ├── profile.ts            #   分析表(检测/框架模式/建议/日志提取)
    ├── samples/              #   样例数据(真实格式栈)
    ├── parser.test.ts        #   基于样例的测试
    ├── README.md             #   文档分析表
    └── index.ts              #   导出 parse + profile
```

## 语言汇总分析表

| 语言 | id | 文件夹 | 内容自动检测 | 样例 | 测试 |
|---|---|---|---|---|---|
| C# / Unity | `csharp` | `languages/csharp` | ✅ | 3 | ✅ |
| C++ / C | `cpp`, `c` | `languages/cpp` | ✅ (GDB 格式) | 3 | ✅ |
| Go | `go` | `languages/go` | ✅ | 2 | ✅ |
| Python | `python` | `languages/python` | ✅ | 2 | ✅ |
| JavaScript / TypeScript / Node / Browser | `javascript`, `typescript`, `node`, `browser` | `languages/javascript` | ✅ | 3 | ✅ |
| Java / Kotlin | `java`, `kotlin` | `languages/java` | ✅ | 2 | ✅ |
| Rust | `rust` | `languages/rust` | ✅ | 2 | ✅ |
| Ruby | `ruby` | `languages/ruby` | ✅ | 2 | ✅ |
| PHP | `php` | `languages/php` | ✅ | 2 | ✅ |
| Swift | `swift` | `languages/swift` | ✅ | 2 | ✅ |
| Dart / Flutter | `dart` | `languages/dart` | ✅ (package: 格式) | 2 | ✅ |
| Elixir / Erlang | `elixir`, `erlang` | `languages/elixir` | ❌ 需 runtime 提示 | 2 | ✅ |
| Lua | `lua` | `languages/lua` | ✅ | 2 | ✅ |
| 未知 | `unknown` | `common/generic.ts`(通用回退) | — | — | ✅ |

## 分析表 (LanguageProfile)

每个语言文件夹的 `profile.ts` 是该语言的分析表,包含:

| 字段 | 用途 |
|---|---|
| `runtimeHints` | runtime 字符串 → 语言 id 的映射 |
| `detect` | 按栈内容自动检测 |
| `frameworkPatterns` | 框架代码正则表(severity 分类:trigger/source/framework) |
| `advice` | 异常类型 → 修复建议表 |
| `defaultAdvice` | 该语言默认建议 |
| `functionDeclarations` / `definitionPatterns` | 源码分析用函数声明/定义正则 |
| `extractFromLog` | 从日志文本提取栈帧 |

## 使用

```typescript
import { analyzeCrash, parseStackFrames, detectLanguage } from './analysis/index.js';

const frames = parseStackFrames(stackTrace, runtime);
const lang = detectLanguage(stackTrace, runtime);
const analysis = analyzeCrash(report, sourceSnapshot?);
```

## 新增语言

1. 创建 `languages/<lang>/` 文件夹(`parser.ts` + `profile.ts` + `index.ts`)
2. 在 `registry.ts` 注册 profile 与 parser(**注意检测优先级顺序**)
3. 添加 `samples/` 样例与 `parser.test.ts`
4. 更新本表与 `docs/STANDARDS.md`

## 测试

```bash
npm test   # tsx --test "src/analysis/**/*.test.ts"
```
