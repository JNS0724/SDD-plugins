# SDD Drift Check — opencode plugin

一个 opencode 插件，在 SDD（Spec-Driven Development）流程中自动检测 spec 文档与代码之间的飘移，避免"改了实现忘了同步文档"或"改了 design 忘了同步 tasks"这类常见疏漏。

---

## 它能解决什么

| 场景 | 触发反馈 |
|---|---|
| 改了 `sdd/changes/<id>/design.md`，没动同目录 `tasks.md` | 强提醒："本会话未同步 tasks.md" |
| 改了 `sdd/changes/<id>/tasks.md`，没动同目录 `design.md` | 弱提醒："是否需要回填 design.md" |
| 改了 `sdd/changes/<id>/proposal.md` | 提醒检查同目录其它 .md |
| 直接修改 `sdd/specs/<feature>/spec.md` | 警告："按流程应走 changes/，确认绕过？" |
| 改了代码（`.ts/.py/.go/...`），但本会话没碰任何 `sdd/changes/**` | 警告："SDD 要求先有变更提案" |
| 会话结束（`session.idle`） | 输出对账报告，并追加写入 `.sdd-drift-report.md` |

**反馈机制**：警告会**追加到 tool 调用的输出末尾**，模型下一轮自然看到并响应；同时打到 stderr 让人看到。

---

## 适配的目录结构

```
项目根/
├── sdd/                       ← 或 .sdd/
│   ├── specs/
│   │   └── <feature>/
│   │       └── spec.md        ← 权威规范，不应直接改
│   ├── changes/
│   │   └── <change-id>/
│   │       ├── proposal.md    ← 在途变更提案
│   │       ├── design.md
│   │       └── tasks.md
│   ├── archive/
│   └── AGENTS.md
└── src/                       ← 代码
    └── ...
```

插件**从被编辑文件向上递归**找 `sdd/` 或 `.sdd/` 目录，不要求一定在项目根。

---

## 安装

### 方式 A：项目级（建议先用这个）

```bash
mkdir -p .opencode/plugin
cp sdd-drift-check.ts .opencode/plugin/
```

### 方式 B：全局（每个项目都生效）

```bash
mkdir -p ~/.config/opencode/plugin
cp sdd-drift-check.ts ~/.config/opencode/plugin/
```

### （可选）装类型让 IDE 不报红

```bash
cd .opencode             # 或 ~/.config/opencode
bun init -y              # 没 bun 用 npm init -y
bun add -d @opencode-ai/plugin
```

不装也能跑——opencode 跑在 Bun 上原生支持 TypeScript。嫌麻烦就把文件里 `import type { Plugin } from "@opencode-ai/plugin"` 这行删掉，并把 `: Plugin` 类型注解去掉即可。

### 加 .gitignore

```
.sdd-drift-report.md
```

---

## 验证

启动 opencode：

```bash
opencode
```

构造测试场景：

```bash
mkdir -p sdd/changes/test-feat
echo "# Design" > sdd/changes/test-feat/design.md
echo "# Tasks" > sdd/changes/test-feat/tasks.md
```

在 opencode 里让 AI 改 `sdd/changes/test-feat/design.md`（例如加一行）。

**两条可观察的产出**：

1. **session.idle 对账**（最直观）：会话结束后 stderr 打印 `📋 SDD 会话对账 ...`，同时 `.sdd-drift-report.md` 追加一行：
   ```
   ## 2026-05-13T13:58:14.050Z
     • sdd/changes/test-feat: 改了 [design.md]，未改 [tasks.md]
   ```

2. **inline 警告**（追加到 tool result）：插件把 `⚠ 改了 ...未同步 ...tasks.md。` 追加到 `output.output`。这段内容在 `opencode run` CLI 里**不会直接显示**（CLI 只渲染 diff），但**会作为 tool result 的一部分喂回模型**，从而让模型在下一轮看到并响应。TUI 模式下可能在 tool 结果面板里可见，取决于版本。

> 已在 **opencode 1.14.48 + deepseek-chat** 上端到端实测通过（4 个场景：design/tasks peer、tasks/design peer、code 无 sdd、直接改 specs/）。

---

## 工作原理

```
┌─────────────────────────────────────────────────────────┐
│  opencode session                                       │
│                                                         │
│  edit/write 工具调用                                    │
│       │                                                 │
│       ▼                                                 │
│  tool.execute.after  ──►  drift(fp, state)              │
│       │                        │                        │
│       │                        ▼                        │
│       │                   匹配规则                       │
│       │                        │                        │
│       ▼                        ▼                        │
│  output.output ◄────── 警告文本追加                       │
│       │                                                 │
│       ▼                                                 │
│  模型看到，自动跟进                                       │
│                                                         │
│  ...                                                    │
│                                                         │
│  session.idle  ──► 对账，写 .sdd-drift-report.md         │
└─────────────────────────────────────────────────────────┘
```

会话状态用 `Map<sessionID, State>` 维护，多会话互不干扰。

---

## 调整点

| 想改什么 | 改哪里 |
|---|---|
| 增删监控的代码后缀 | `CODE_EXT` 正则 |
| 新增 peer 关系（如 `design.md` ↔ `test-plan.md`） | `peers` 对象 |
| 升级警告为**阻断**（拒绝该次编辑） | 把 `tool.execute.after` 换成 `tool.execute.before`，缺 peer 时 `throw new Error(...)` |
| 改报告位置 / 格式 | `event` handler 里的 `fs.appendFileSync` |
| 关闭"直接改 specs/"警告 | 删 `if (rel.startsWith("specs/"))` 那段 |

---

## 排错

| 症状 | 排查 |
|---|---|
| 完全没警告 | `ls .opencode/plugin/` 确认文件在；`opencode --log-level debug` 启动看 plugin 加载日志 |
| TS 类型报错 | 装 `@opencode-ai/plugin`，或把 `import type { Plugin }` 与 `: Plugin` 注解全删 |
| 警告出现但模型不响应 | 看 opencode 的 tool 结果面板里警告是否真出现在 output 末尾；若否，可能是 opencode 版本 API 差异，需调整 `output.output` 字段名 |
| `sdd/` 找不到 | 脚本**向上递归**找 `sdd/` 或 `.sdd/`，确认目录在祖先链上 |
| 会话对账没出现 | 必须触发 `session.idle` 事件（结束会话 / 切到新会话） |
| 我自己改 plugin 时取 filePath 取不到 | opencode `tool.execute.after` 的 `filePath` 在 **`input.args.filePath`**（**不是** `output.args`！原始版本就因为这点错过所有触发，已在本插件修复） |
| 编辑 `src/foo.ts` 时 specs/changes 内部规则误判 | `findSdd` 向上找会命中项目根的 `sdd/` 兄弟目录，需用 `path.relative(root, fp).startsWith("..")` 区分文件是否真在 sdd/ 里——已修复 |

---

## 兼容性

| 维度 | 状态 | 说明 |
|---|---|---|
| **opencode 版本** | ✅ 1.14.x | 实测 `1.14.48`。依赖 `tool.execute.after` 接口的 `input.args.filePath` 与可写的 `output.output`；opencode 升大版本若改字段名要同步调一行取值 |
| **模型** | ✅ 任意 | 插件不感知模型，只看 tool 调用；实测 `deepseek/deepseek-chat`。Claude / OpenAI / 本地模型同样适用——只要模型会调 `edit` / `write` 工具 |
| **工具识别** | ⚠️ 仅 `edit` / `write` | 不会触发的：Bash 里 `sed`/`cat > file` 重定向、自定义文件编辑工具、未来若 opencode 出 `multiedit` 也需补一行 |
| **运行时** | ✅ Bun / Node 18+ | opencode 内置 Bun，原生跑 TS；脚本只用 Node 内置 `fs` / `path`，零外部依赖（`@opencode-ai/plugin` 仅类型，运行时可删） |
| **操作系统** | ⚠️ macOS / Linux 实测 OK；**Windows 未测且有已知风险** | `path.sep` 用得对，但路径正则 `/^changes\/([^/]+)\/(.+\.md)$/` 硬写斜杠——Windows 下 `path.relative` 返回反斜杠会让规则失效。Windows 用户需把正则改成 `[\\\\/]`，或先 `rel.replace(/\\\\/g, "/")` 后再 match |
| **多会话隔离** | ✅ | `Map<sessionID, State>` 按 sessionID 维护，多会话互不污染 |
| **跨会话/持久化** | ❌ 不保留 | opencode 重启或插件重载即清空内存状态；只有 `.sdd-drift-report.md` 是落盘的，但它是只追加日志，不是状态 |
| **目录命名约定** | ⚠️ 硬编码 | 只认 `sdd/` 或 `.sdd/` 顶层 + 子目录 `changes/`、`specs/`；要改名（如 `spec/`、`docs/sdd/`）需同步改插件 |
| **文件命名约定** | ⚠️ 硬编码 | peer 关系只认 `design.md` ↔ `tasks.md`，proposal 只认 `proposal.md`，spec 只认 `specs/<feature>/<*>.md`；要扩展（如 `test-plan.md`）改 `peers` 对象即可 |
| **`AGENTS.md` / `archive/`** | ✅ 静默忽略 | 不检查、不报警，符合 SDD 目录里这些文件的实际用途 |
| **Claude Code** | ❌ 不可直接复用 | 这是 opencode plugin，依赖 opencode 的 hook 接口；如果你也想给 Claude Code 加同样防护，前面对话里那份 `.claude/scripts/sdd-drift-check.js` 是对应实现（事件源是 PostToolUse / Stop hook） |
| **CLI 显示** | ⚠️ `opencode run` 不渲染 inline 警告 | inline 警告会写进 `output.output` 喂给模型，但 `opencode run` 子命令只渲染 edit 工具的 diff，CLI 里看不到。TUI（`opencode` 默认交互模式）可能可见。会话结束的对账总会到 stderr + 报告文件 |

### 一个版本敏感的小风险

opencode plugin 接口仍在演进。**`input.args.filePath` 是当前实测正确的取值路径**，但官方 plugin 文档在不同时间点的写法对它/`output.args.filePath` 描述不一致——升级 opencode 后建议跑一次本仓库里的最小用例（改 `sdd/changes/test-feat/design.md`）确认 `.sdd-drift-report.md` 会写入；若没写入，第一时间排查就是再加一次 `console.error(JSON.stringify(input))` 探针看字段位置。

---

## 不做什么（明确边界）

- 不修复飘移：只发警告，让模型 / 你来改
- 不解析 markdown 语义：只看路径，不看内容
- 不强制目录命名：靠 `sdd/` 或 `.sdd/` 约定，其他命名不识别
- 不跨会话记忆：每个 session 状态独立

---

## License

随便用。
