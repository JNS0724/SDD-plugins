# SDD Drift Check — opencode plugin

一个 opencode 插件，在 SDD（Spec-Driven Development）流程中自动检测 spec 文档与代码之间的飘移，避免"改了实现忘了同步文档"或"改了 design 忘了同步 tasks"这类常见疏漏。

---

## 它能解决什么

| 场景 | 触发反馈 |
|---|---|
| 改了 `sdd/changes/<id>/design.md`，没动同目录 `tasks.md` | 在本次 edit/write 的 tool result 里追加 AI 可见约束，要求模型先同步 `tasks.md` |
| 改了 `sdd/changes/<id>/tasks.md`，没动同目录 `design.md` | 弱提醒："是否需要回填 design.md" |
| 改了 `sdd/changes/<id>/proposal.md` | 提醒检查同目录其它 .md |
| 直接修改 `sdd/specs/<feature>/spec.md` | 警告："按流程应走 changes/，确认绕过？" |
| 改了代码（`.ts/.py/.go/...`），但本会话没碰任何 `sdd/changes/**` | 警告："SDD 要求先有变更提案" |
| 会话结束（`session.idle`） | 若仍未同步，只追加写入 `.sdd-drift-report.md` |

**反馈机制**：默认不向 TUI/CLI 输出红色 stderr，也不发 follow-up 用户消息。插件会在触发 drift 的 `edit` / `write` 工具结果后追加一段 AI 可见的 `SDD drift tool result enforcement` 约束，让模型在下一步生成前直接看到 peer 缺口，并先用 read + edit/write 同步缺失文档。只有设置 `SDD_DRIFT_SHOW_WARNINGS=1` 时，才会额外把非 peer drift 的人工可见提示追加到 tool 输出里。

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

1. **级联同步**（最直观）：模型改完 `design.md` 后，该 tool result 会包含 `SDD drift tool result enforcement` 约束；下一次模型请求会从上一条 tool 消息里看到这个约束，继续读写同目录 `tasks.md`。成功后 `tasks.md` 会出现对应同步内容，界面不会出现红色 stderr 提示。

2. **失败报告**：如果模型仍然没有同步，`.sdd-drift-report.md` 追加一行：
   ```
   ## 2026-05-13T13:58:14.050Z
     • sdd/changes/test-feat: 改了 [design.md]，未改 [tasks.md]
   ```

> 已在 **opencode-ai 1.2.27** 测试工程中用 fake OpenAI provider 端到端验证，用于稳定复现 tool result 触发的级联同步。真实模型验证需要在允许外部 API 调用后单独运行。

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
│  tool result 追加 AI 可见 peer 缺口约束                  │
│       │                                                 │
│       ▼                                                 │
│  下一次 LLM 请求从上一条 tool 消息看到约束                │
│       │                                                 │
│       ▼                                                 │
│  模型继续读写 peer 文档                                  │
│                                                         │
│  ...                                                    │
│                                                         │
│  session.idle  ──► 仍有缺口则写报告文件                   │
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
| 恢复可见 tool 警告 | 启动 opencode 前设置 `SDD_DRIFT_SHOW_WARNINGS=1` |

---

## 排错

| 症状 | 排查 |
|---|---|
| 完全没触发 | `ls .opencode/plugin/` 确认文件在；`opencode --log-level debug` 启动看 plugin 加载日志 |
| TS 类型报错 | 装 `@opencode-ai/plugin`，或把 `import type { Plugin }` 与 `: Plugin` 注解全删 |
| 模型改了 `design.md` 但没继续改 `tasks.md` | 用 debug log 或本仓库 e2e 确认 `design.md` 的 tool result 里是否有 `SDD drift tool result enforcement`，以及下一次 LLM 请求是否带着这段 tool 消息；若有但模型仍结束，说明模型忽略 tool result 约束，只能升级为可见 warning / 抛错阻断 / 等 opencode 支持 Stop continuation |
| `sdd/` 找不到 | 脚本**向上递归**找 `sdd/` 或 `.sdd/`，确认目录在祖先链上 |
| 失败报告没出现 | 必须触发 `session.idle` 事件后才写 `.sdd-drift-report.md` |
| 我自己改 plugin 时取 filePath 取不到 | opencode `tool.execute.after` 的 `filePath` 在 **`input.args.filePath`**（**不是** `output.args`！原始版本就因为这点错过所有触发，已在本插件修复） |
| 编辑 `src/foo.ts` 时 specs/changes 内部规则误判 | `findSdd` 向上找会命中项目根的 `sdd/` 兄弟目录，需用 `path.relative(root, fp).startsWith("..")` 区分文件是否真在 sdd/ 里——已修复 |

---

## 兼容性

| 维度 | 状态 | 说明 |
|---|---|---|
| **opencode 版本** | ✅ 1.2.27 | 依赖 `tool.execute.after` 与 `session.idle`；opencode 升大版本若改字段名要同步调取值 |
| **模型** | ✅ 任意 | 插件不感知模型，只看 tool 调用；Claude / OpenAI / DeepSeek / 本地模型同样适用——只要模型会调 `edit` / `write` 工具 |
| **工具识别** | ⚠️ 仅 `edit` / `write` | 不会触发的：Bash 里 `sed`/`cat > file` 重定向、自定义文件编辑工具、未来若 opencode 出 `multiedit` 也需补一行 |
| **运行时** | ✅ Bun / Node 18+ | opencode 内置 Bun，原生跑 TS；脚本只用 Node 内置 `fs` / `path`，零外部依赖（`@opencode-ai/plugin` 仅类型，运行时可删） |
| **操作系统** | ✅ Windows 实测 | 文件路径会先归一化为 `/` 再匹配；本仓库 e2e 在 Windows PowerShell 下运行 |
| **多会话隔离** | ✅ | `Map<sessionID, State>` 按 sessionID 维护，多会话互不污染 |
| **跨会话/持久化** | ❌ 不保留 | opencode 重启或插件重载即清空内存状态；只有 `.sdd-drift-report.md` 是落盘的，但它是只追加日志，不是状态 |
| **目录命名约定** | ⚠️ 硬编码 | 只认 `sdd/` 或 `.sdd/` 顶层 + 子目录 `changes/`、`specs/`；要改名（如 `spec/`、`docs/sdd/`）需同步改插件 |
| **文件命名约定** | ⚠️ 硬编码 | peer 关系只认 `design.md` ↔ `tasks.md`，proposal 只认 `proposal.md`，spec 只认 `specs/<feature>/<*>.md`；要扩展（如 `test-plan.md`）改 `peers` 对象即可 |
| **`AGENTS.md` / `archive/`** | ✅ 静默忽略 | 不检查、不报警，符合 SDD 目录里这些文件的实际用途 |
| **Claude Code** | ❌ 不可直接复用 | 这是 opencode plugin，依赖 opencode 的 hook 接口；如果你也想给 Claude Code 加同样防护，前面对话里那份 `.claude/scripts/sdd-drift-check.js` 是对应实现（事件源是 PostToolUse / Stop hook） |
| **CLI/TUI 显示** | ✅ 默认无红字 | 默认不写 `console.error`，peer drift 约束只随 tool result 进入模型上下文。需要人工可见提示时设置 `SDD_DRIFT_SHOW_WARNINGS=1` |

### 一个版本敏感的小风险

opencode plugin 接口仍在演进。**`input.args.filePath` 是当前实测正确的取值路径**，但官方 plugin 文档在不同时间点的写法对它/`output.args.filePath` 描述不一致——升级 opencode 后建议跑一次本仓库里的最小用例（改 `sdd/changes/test-feat/design.md`）确认 tool result 会注入 `SDD drift tool result enforcement` 并同步 `tasks.md`；若没触发，优先用 `client.app.log()` 或本仓库 e2e 的 debug log 排查字段位置，不要用 `console.error` 干扰 TUI。

---

## 不做什么（明确边界）

- 不直接替用户改文件，也不代发用户消息：插件只把未同步 peer 缺口追加到 tool result，让模型通过 opencode 工具链继续改
- 不解析 markdown 语义：只看路径，不看内容
- 不强制目录命名：靠 `sdd/` 或 `.sdd/` 约定，其他命名不识别
- 不跨会话记忆：每个 session 状态独立

---

## License

随便用。
