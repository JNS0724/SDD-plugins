# sdd-review-ledger 入门（Claude Code / OpenCode）

`sdd-review-ledger` 在 vibe coding 时做一件事：**代码或 SDD 文档变了，就在编辑那一刻把"该评审的材料"端到 agent 面前，请它评审 文档↔文档 / 代码↔文档 是否需要同步**，并用内容哈希记住每次评审结论。

它**不**替你判断有没有偏差（那是语义判断，没有确定性算法）。它只保证：变更被可靠地端出来评审、留痕、永不阻断你的主流程。判断永远由 agent（LLM）做。

> 当前支持 **Claude Code command hook** 和 **OpenCode native plugin** 两种入口。两边共用同一套 ledger/todo 核心逻辑，只是事件适配层不同。

---

## 它和上一代 sdd-drift-check 的区别

| | sdd-drift-check | sdd-review-ledger |
| --- | --- | --- |
| 信号 | file mtime + session 时序状态机 | **内容哈希**（与 mtime、git 无关） |
| 工具角色 | 试图"算出有没有 drift" | **只做评审编排 + 记账**，判断全交 agent |
| 触发判定 | 依赖会话内事件 + git | `needsReview = hash(文件) ≠ 账本里上次评审的哈希`，是 `(工作树, 账本)` 的**纯函数** |
| 清除 | 多种隐式信号 | **唯一信号 = 勾选** `.sdd-review-todo.md`；编辑从不自动清除 |

设计文档见 [`docs/`](.)：架构（v0.3）、详细设计（v0.3）、R1（去 git 状态依赖）、R2（GateGuard 可借鉴边界）。

---

## 前置条件

- 本机能跑 `node`（开发用 Node 18+）。
- 项目里有 `sdd/` 或 `.sdd/` 目录，change 目录形如：

  ```text
  sdd/changes/<change-id>/
    proposal.md
    design.md
    tasks.md
  ```

  没有 `sdd/` / `.sdd/` 且账本为空时，插件**静默退出**，不写任何文件、不提醒。

---

## 安装（Claude Code）

需要两个文件：发布件 `sdd-review-ledger-hook.js`（自包含，已打包）和可选的提示词规则 `sdd-review-rules.md`。

```bash
mkdir -p .claude/hooks/sdd-review-ledger
cp <本插件目录>/sdd-review-ledger-hook.js .claude/hooks/sdd-review-ledger/sdd-review-ledger-hook.js
cp <本插件目录>/sdd-review-rules.md       .claude/hooks/sdd-review-ledger/sdd-review-rules.md
```

创建或更新 `.claude/settings.json`（两个事件用**同一个**发布件；它内部按 `hook_event_name` 分派）：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/sdd-review-ledger/sdd-review-ledger-hook.js"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/sdd-review-ledger/sdd-review-ledger-hook.js"
          }
        ]
      }
    ]
  }
}
```

- **PostToolUse（Edit/Write/MultiEdit）= 主通道**：编辑发生时即检查并在工具结果里端出提醒。
- **UserPromptSubmit = 跨会话/跨轮兜底**：新会话或下一轮开头，若有未评审项，注入一条紧凑 carry-over 摘要。

冷启动：第一次在已有代码的仓库启用时，插件会**自动 baseline**（把当前所有文件按当前哈希记为已评审、本轮不刷屏），避免满屏"全未评审"。这是一次"不回溯存量"的静默标注，不声称"已验证"。

---

## 安装（OpenCode）

只安装 OpenCode 发布件：

```powershell
New-Item -ItemType Directory -Force .opencode\plugins
Copy-Item <本插件目录>\sdd-review-ledger-opencode.js .opencode\plugins\sdd-review-ledger-opencode.js -Force
Copy-Item <本插件目录>\sdd-review-rules.md          .opencode\plugins\sdd-review-rules.md -Force
```

也可以全局安装：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"
Copy-Item <本插件目录>\sdd-review-ledger-opencode.js "$env:USERPROFILE\.config\opencode\plugins\sdd-review-ledger-opencode.js" -Force
Copy-Item <本插件目录>\sdd-review-rules.md          "$env:USERPROFILE\.config\opencode\plugins\sdd-review-rules.md" -Force
```

OpenCode 启动时加载 `.opencode/plugins/` 和 `~/.config/opencode/plugins/` 下的插件文件。修改 JS 发布件后需要重启 OpenCode。

OpenCode adapter 当前监听：

- `tool.execute.before`：缓存工具参数，补足 after 事件里可能缺失的 `file_path`。
- `tool.execute.after`：主通道。写工具完成后运行 ledger 检查，并把提醒追加到本次工具结果。
- `chat.message`：新用户消息时打开新批次，并记录是否存在历史待评审项；**不改写 OpenCode 消息结构**。
- `session.idle` / idle `session.status`：只做被动刷新 todo/ledger，不唤醒会话、不调用 `session.prompt`。

---

## 你会看到什么

大多数时候它是安静的。

| 场景 | 现象 |
| --- | --- |
| 改了代码，且仓库里有活跃 change-dir | Claude Code 的 PostToolUse additionalContext / OpenCode 的 tool output 里出现一段 `<system-reminder>[SDD-REVIEW: NEEDS-REVIEW]`，列出变了哪些文件 + 候选 change-dir + design 首行 |
| 同一轮里连续改多个代码/SDD 文件 | 每次相关编辑后都可能主动提醒；相同 pending 集合的瞬时重复提醒会短窗口去重 |
| 新会话有历史未评审项 | Claude Code 开头收到 carry-over；OpenCode 不改写用户消息，下一次写工具结果仍会提醒，`.sdd-review-todo.md` 持续保留 |
| 改了 `design.md` / `tasks.md` | 同样进待评审，提醒评审下游是否需要跟进 |
| 纯格式化 / 改无关函数 | 也会进待评审（良性），agent 一句"仅格式化，无需改文档"勾掉即可 |
| 没有 `sdd/` 且账本空 | 完全静默 |

模型看到的提醒长这样（fact-forcing：先取证再下结论）：

```text
<system-reminder>
[SDD-REVIEW: NEEDS-REVIEW]

CHANGED (未评审，本批):
  - src/greet.ts  (候选 change-dir: greeting)
  ...

REVIEW（你是唯一语义裁判；下结论前必须先取证，不接受裸判断）:
  1. design/tasks 此刻声称什么  2. code 此刻实现什么
  3. 二者是否一致  4. 结论：需改→编辑 design/tasks；无需改→在 .sdd-review-todo.md 勾掉
...
</system-reminder>
```

---

## 如何"消项"（唯一信号 = 勾选）

评审完每一项，在 `.sdd-review-todo.md` 的 `## 待评审` 区域把它从 `[ ]` 原地勾成 `[x]`，即使结论是"无需改"：

```markdown
## 待评审
- [x] src/greet.ts@a1b2c3  (候选: greeting)   ← 勾上 + 保留行内 @hash
```

- **编辑文件不会自动清除**——这是刻意的（防止"碰一下文档就误清掉一条没人审过的评审项"）。
- **不要移动条目**到审计历史区，不要手写新增待评审条目；插件只认 `## 待评审` 区域里的原始 `path@hash` 勾选。
- 行内 `@<hash>` 把结论钉在你当时看过的那一版上；文件内容再变 → 新哈希 → 自动重新变回待评审。
- 如果评审过程中又编辑了 code / design / tasks，先重新读取最新 `.sdd-review-todo.md`，再勾选最新出现的 `path@hash`；不要只勾旧 hash。
- 勾选**下一次运行生效**（下次 hook 触发时 ingest）。

---

## 运行时产物

| 产物 | 位置 | 是否进 git |
| --- | --- | --- |
| `ledger.json`（评审记录，机器真相源） | `<.git>/sdd-review-ledger-state/`，无 git 时 `<repo>/.sdd-review-ledger-state/`，再兜底 `%TEMP%/` | 否（gitignore） |
| `.sdd-review-todo.md`（人可见 + 勾选入口） | repo 根 | 否（gitignore） |
| `sdd-review.log.jsonl`（诊断） | state 目录 | 否 |

建议加入 `.gitignore`：

```gitignore
.sdd-review-ledger-state/
.sdd-review-todo.md
```

> v0.1 是**本地、不共享**：账本不进 git，跨人/换机不共享（诚实标注，团队模式是 v0.2）。

---

## 常用开关（环境变量）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SDD_REVIEW` / `SDD_REVIEW_DISABLED` | — | **逃生阀总开关**：设 `off`/`0`/`false`/`disabled`（或 `SDD_REVIEW_DISABLED=1`）→ 整程静默：不提醒、不写 todo、不扫描 |
| `SDD_REVIEW_SESSION_MAX_REMINDERS` | 无上限 | 可选的每会话主动提醒硬上限；默认不限制，`0` = 纯靠被动 todo，不主动提醒 |
| `SDD_REVIEW_REMINDER_DEDUPE_MS` | `2000` | 相同 pending 集合的短窗口去重时间；避免并发多文件写入时重复刷同一段提醒 |
| `SDD_REVIEW_IGNORE` | — | 追加扫描忽略 glob（逗号分隔，如 `generated/,vendor/`） |
| `SDD_REVIEW_SCAN_ROOTS` | repo 根 | 限定只扫某些子树（逗号分隔） |
| `SDD_REVIEW_SCAN_BUDGET_MS` | `1500` | 单次扫描时间预算；超出 → 截断并在 todo 头/日志告警（非静默） |
| `SDD_REVIEW_SCAN_ALWAYS_HASH` | `0` | `1` = 禁用 mtime 跳过优化、永远全哈希（最慢但最稳） |
| `SDD_REVIEW_MAX_FILE_BYTES` | `2097152`(2 MiB) | 超此大小的文件不扫 |
| `SDD_REVIEW_BOOTSTRAP_THRESHOLD` | `1` | 空账本扫到 ≥N 个既有文件即 auto-baseline |
| `SDD_REVIEW_HASH_LEN` | `16` | 内容哈希 hex 前缀长度 |
| `SDD_REVIEW_RULES_FILE` | repo 根 `sdd-review-rules.md` | **项目自定义评审规则**：指向一个文本规则文件（绝对路径或相对 repo 根）。命中后，其内容会被**限长（≤4KB/60 行）+ 净化**后作为「项目附加规则」段注入**每回合首条完整提醒**，让团队规则真正进入模型上下文（不靠模型自己去 Read）；不设此变量时回退探测 repo 根的 `sdd-review-rules.md`。两者都没有 → 不注入、行为与从前逐字节相同。注入内容只是给模型的指导文本，**不改变清除判定**（清除唯一信号永远是勾选 `.sdd-review-todo.md`）。 |

---

## 边界与已知残余（诚实标注）

- **主投递无强制力**：提醒是搭在工具结果上的可见文本，模型**可以忽略**（不像有 DENY 的 gate 那样强制）。这是"永不阻断"换来的代价（架构 §10#9）。
- **评审质量 = LLM 质量**：工具只保证"评审被端到裁判面前并留痕"，不保证"判得对"。
- **不在被扫描位置的写**仍可能漏（被 ignore-glob 排除 / 扫描预算截断尾部），但两者都有日志、非静默。
- **OpenCode 投递仍是 best-effort**：主通道是 `tool.execute.after` 追加工具结果；如果平台或模型忽略工具结果里的提醒，仍需依赖 `.sdd-review-todo.md` 兜底。

---

## 快速验证

```text
sdd/changes/demo/
  design.md   # 内容：# Design\n当前实现返回普通问候语。
  tasks.md    # 内容：# Tasks\n- [ ] 实现热情问候语。
```

让 agent：把 `src/app.ts` 的 greet 改成返回带感叹号的热情问候语。

预期：改完那一刻，工具结果里出现 `[SDD-REVIEW: NEEDS-REVIEW]`，列出 `src/app.ts`；`.sdd-review-todo.md` 出现该项；agent 评审 design/tasks，需要则改、不需要则勾掉并写一行理由。

排查：state 目录下看 `sdd-review.log.jsonl`；完全无反应通常是 hook 没被加载或 `settings.json` 里 `command` 路径写错。
