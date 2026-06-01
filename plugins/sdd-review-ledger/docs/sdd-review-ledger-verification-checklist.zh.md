# sdd-review-ledger 待核实清单（真实模型 e2e）

> 状态：**待在 Windows 真实模型 e2e 上核实**。
> 背景：`once` 默认模式已落地（commit `46036fe`，见 `sdd-review-ledger-reminder-ux-improvements.zh.md` §10）。
> `once` 模式的安全性**完全依赖**"turn 边界 + 结束点兜底"这条链路在 OpenCode 上真实可靠，所以下面这些点
> 必须用真实模型跑过才能确认。单元/集成测试已全绿（151/151），但那是 mock 事件，**证明不了真实运行时**。

## 切换模式（测试两种都要测）

```text
SDD_REVIEW_REMINDER_MODE=once     # 默认（不设也是它）
SDD_REVIEW_REMINDER_MODE=growth   # opt-in
```

## ⚠️ 报告要点：记录"提醒文本"，不只是"次数"

之前的报告只数了"主动提醒次数"，无法区分**全量 / 精简 / 未注入**。这次每条注入请记录：

- 它是**全量**(含 `你是唯一语义裁判` 4 步协议) 还是 **精简体**(只有 `本回合仍有 N 项待评审…`) 还是 **没注入**。
- 触发它的工具调用(哪个文件、第几次编辑)。
- 当时是不是同一个用户 turn。

## 核实点

### 1. OpenCode turn 边界：`chat.message` 是否每轮 bump batch（最关键）

- **为什么要紧**：`once` 的"每 turn 一条"、`growth` 的"首条全量/后续精简"全靠 `batch` 每轮自增
  （`chat.message` → `onPrompt` → `bumpBatch`）。若 `isUserChatMessage` 没把用户消息识别成 user，
  batch 不增 → 每条都被当"本回合首条"(全是全量、且不会按 turn 收敛)，或 `once` 永远只在整个 session
  报一次。
- **怎么看**：检查 `.git/sdd-review-ledger-state/throttle-*.json` 的 `batch` 是否随每轮用户输入 +1；
  或看 OpenCode 插件 log 是否每轮有 "observed SDD review carry-over"。
- **通过标准**：每个用户 turn 后 `batch` 自增 1。

### 2. `once` 模式默认行为：同回合第二个新文件被抑制

- **怎么测**：一个 turn 内让模型连写两个新文件(如 `a.ts` 再 `b.ts`)。
- **通过标准**：第一次注入**全量**提醒;第二个新文件**不再注入**主动提醒;但 `.sdd-review-todo.md`
  里能看到 `b.ts` 进了待评审。

### 3. `growth` 模式行为：第二个新文件再提醒，且为精简体

- **怎么测**：`SDD_REVIEW_REMINDER_MODE=growth`，同样连写两个新文件。
- **通过标准**：第一次**全量**;第二次**精简体**(不含 `你是唯一语义裁判`，含 `本回合仍有 N 项`)。

### 4. 结束点兜底：`once` 模式被抑制的新路径，回合末是否被捞回

- **怎么测**：`once` 模式下，一个 turn 内写多个文件(只第一条提醒)，且**不勾任何 todo**，让回合自然结束 / idle。
- **通过标准**：
  - OpenCode：`session.idle` 后插件 log 出现 "SDD review pending at idle…"；下一轮用户输入时出现 carry-over。
  - **关键**：被同回合抑制的 `b.ts` 最终没有被悄悄丢掉(下一轮 carry-over 或结束点能再浮现)。

### 5. CC 侧 Stop 强制评审（若在 Claude Code 侧也跑）

- **怎么测**：有 pending 时触发 Stop。
- **通过标准**：返回 `{"decision":"block"}` 一次并列出待评审项;模型续审后再次 Stop(`stop_hook_active=true`)
  → **不再 block**(不死循环)。

### 6. 主通道忽略率（架构 §16.5，长期指标）

- **怎么看**：模型收到主动提醒后，实际**去读 todo + 给评审理由 + 勾选**的比例。
- **意义**：忽略率高 → "首条全量"也没用，可能需要更强的结束点强制;忽略率低 → `once` 默认就够。

### 7. 上下文压缩后是否忘记在评审中

- **怎么测**：长任务跑到触发上下文压缩，看模型是否还记得有待评审项、是否还会去勾。
- **意义**：决定结束点兜底(Stop/idle/carry-over)是不是足够"提醒它回来评审"。

### 8. 改进 B：文档领先代码 = 被动（不主动催、不自动写实现）

- **怎么测**：在一个已 baseline 的 SDD 工程里，**只改 `design.md` / `tasks.md`（不动任何 code）**，
  让模型跑一轮、触发 idle、下一轮再开口。
- **通过标准**：
  - 改 doc 的那次工具调用**不注入**主动提醒（工具输出里无 `[SDD-REVIEW]`）；
  - idle / Stop **不阻断**；下一轮 chat **无 carry-over**；
  - 但 `.sdd-review-todo.md` 里**能看到**该 doc 进了「待评审」（被动记录，没丢）；
  - 模型即便去评审该 doc，也**不应**为"对齐"擅自补写实现代码（A：规则见 `sdd-review-rules.md`）。
- **再改一次 code**：此时主动提醒**应**正常触发——code 变更才是主动通道（"现实动了、文档要跟上"）。

### 9. T1+T2：review 后又改文件的"二次闭环"兜底（MiniMax 重点）

- **T1 提示词**：检查注入的全量提醒 / Stop 文本里，`ACTION_LINE` 是否以"最终门槛"领头（含"待评审区非空
  不得说已完成"）；这是普惠所有模型的硬门槛。
- **T2 同回合（CC）**：一个 turn 内先改 code 触发 review、勾掉 code，**再改 `tasks.md`/`design.md`** 留下新 hash，
  让回合结束 → **Stop 应短 block 一次**，点名那条新 `path@hash`，且**不重灌完整 4 步协议**；续审后 `stop_hook_active`
  → 不再 block。
- **T2 跨回合（OpenCode）**：同样制造"review 后新增 doc pending"，idle 拦不住 → **下一轮**应出现**一次**短 carry-over
  点名该项；**再下一轮不应重复**（一次性，已消费快照）。
- **不误报**：① 只改文档做规划（本回合没 review）→ Stop/carry **静默**；② review 前就存在的 passive pending → **不**被
  当作新增。两者都不该触发短兜底。

## 跑完后

把结果按"提醒文本 + 次数 + 全量/精简/未注入"记成一份 `…-ux-report-<date>.zh.md`，
重点回答 #1（turn 边界）和 #4（once 兜底不丢项）——这两个是 `once` 能否当默认的硬门槛。
