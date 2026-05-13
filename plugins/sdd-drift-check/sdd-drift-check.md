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

在 opencode 里让 AI 改 `sdd/changes/test-feat/design.md`（例如加一行）。该次 tool 调用输出末尾应出现：

```
---
⚠ 改了 sdd/changes/test-feat/design.md，本会话未同步 sdd/changes/test-feat/tasks.md。
```

退出会话后：

```bash
cat .sdd-drift-report.md
```

应包含一条对账记录。

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

---

## 不做什么（明确边界）

- 不修复飘移：只发警告，让模型 / 你来改
- 不解析 markdown 语义：只看路径，不看内容
- 不强制目录命名：靠 `sdd/` 或 `.sdd/` 约定，其他命名不识别
- 不跨会话记忆：每个 session 状态独立

---

## License

随便用。
