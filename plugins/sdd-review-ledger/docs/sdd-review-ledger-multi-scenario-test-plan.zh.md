# sdd-review-ledger 多场景长跑测试计划（真实模型 e2e）

> 目的：用一个**更长、更杂、更贴近真实工程**的多轮迭代流程，逼出主路径之外的**隐藏问题**——
> 尤其是最近加的 B / once / T1 / T2 / 结束点兜底，以及两处已知弱点（#1 评审取证不充分、#3 审计理由质量）。
> 不是测单元覆盖率（那有 168 个单测兜底），是观察**真实开发节奏下的行为体验**。
>
> 锚定现有脚手架，**可直接执行**：
> - OpenCode：`test/opencode-sdd-drift-e2e/scripts/run-real-sdd-review-ledger-workflow.ps1`（扩展其 `$phases` 数组）
> - Claude Code：`test/claude-code-sdd-drift-e2e/scripts/run-real-e2e.ps1`
> - 矩阵：`test/run-sdd-drift-real-matrix.ps1`
> - 本计划**只新增/扩展阶段脚本与采集**，不改插件代码。

---

## 0. 与现有 7 阶段流程的差距

现流程（badge-greeting，单 change-dir，7 阶段）只走了主路径，且只记 `reminderCount`（数次数，分不清 full/compact/leftover/none）。本计划补三件事：

1. **多 change-dir + 横切重构 + 删除 + bug-fix + 长任务**，贴近真实工程节奏。
2. **针对性陷阱**：把 #1（走过场盖章）、T2（review 后又改文件留尾巴，同回合 & 跨回合）、B（doc 领先被动 + 不自动实现）、误报负向用例、压缩遗忘，逐个摆进流程。
3. **更细的采集**：每次注入分类（full / compact / leftover-short / carry / none）、每条勾选的**理由原文**、勾选前是否对相关 design/code 发过 `Read`、Stop/idle/carry 行为、终态 todo + 审计历史全文。

---

## 1. 被测行为覆盖矩阵

| # | 行为 | 期望 | 触发阶段 |
|---|---|---|---|
| C1 | 冷启动 bootstrap | 既有 doc+code 记为 bootstrap，不全量浮现 | P01 |
| C2 | **B：doc 领先 code** | 只被动进 todo，**不**注入 active 提醒、idle/Stop 不阻断、下轮无 carry | P01/P02/P05/P08/P11/P15 |
| C3 | **A：评审不自动写实现** | doc 领先时模型**不擅自补写 code**（除非用户要求） | P05 |
| C4 | once 默认节流 | 同回合多文件只一条 full 提醒 | P04/P10 |
| C5 | Stop/idle 结束点兜底 | 同回合被抑制的 code 项回合末被捞回 | P04/P10/P14 |
| C6 | **T1 最终门槛** | 改文件后重读 todo、勾新 path@hash；待评审区非空不说"已完成" | P03/P06/P12 |
| C7 | **T2 同回合 leftover** | review 后又改 doc 留新 hash → CC Stop **短 block 点名**（非 full）、`stop_hook_active` 不重复 | P06 |
| C8 | **T2 跨回合 leftover** | OpenCode idle 拦不住 → 下一轮**一次性** carry 点名、再下一轮**不重复** | P13 |
| C9 | 不误报：纯规划静默 | 只改 doc、本回合无 review → Stop/carry 静默 | P05/P08/P11 |
| C10 | 不误报：既有 pending 不算新增 | review 前就 pending 的 doc 在快照里 → 不被当 leftover | P06/P09 |
| C11 | 归属（attribution） | 一块 code 多 change-dir 候选 → 模型判归属，不让工具判 | P09/P10 |
| C12 | 良性变更 | 重构/格式化（无行为变化）→ 一行理由勾掉 | P07 |
| C13 | code 领先 doc | 改 code 不动 design → 模型把**文档同步到 code 现状** | P16 |
| C14 | 删除文件 | 删除的 code 不浮现、不报错 | P15 |
| C15 | 逃生阀 `SDD_REVIEW=off` | 无提醒、无写盘；恢复后自愈继续追踪 | P17 |
| C16 | 跨会话延续 | 切 session 后 ledger/todo 仍延续 | P08/P14（split 场景） |
| C17 | 上下文压缩遗忘 | 长任务触发压缩后，模型是否还记得评审、兜底能否捞回 | P14 |
| **W1** | **弱点 #1：取证质量** | 记录 rationale 是否引证、勾选前是否 Read（**只观测，不强制**） | P03/P09/P12/P18 |
| **W2** | **弱点 #3：理由完整度** | 捕获终态审计历史，人工看半截句/过简 | P07/P18 |
| C18 | 扫描预算（可选，大仓） | 超预算时 todo 出现 ⚠ 截断警告，不静默丢 | 可选附加 |

---

## 2. 测试工程设定（贴近真实）

一个小而可信的 TypeScript "问候/通知工具包"，多 feature 多 change-dir，含被多 feature 共享的代码文件（制造归属歧义）：

```
sdd/changes/
  badge-greeting/    design.md tasks.md      # 基础问候徽章（沿用现有）
  vip-tiers/         design.md tasks.md      # 等级/VIP 规则
  i18n-locale/       design.md tasks.md      # 多语言问候
  audit-log/         design.md tasks.md      # 横切：调用审计日志
src/
  badgeGreeting.ts   # 被 badge-greeting & vip-tiers & i18n 共享 → 归属歧义甜区
  badgeFormatter.ts
  tiers.ts           # vip-tiers
  locale.ts          # i18n-locale
  auditLog.ts        # audit-log（横切，被多处 import）
  index.ts
```

- OpenCode：沿用 `sddflow` agent（`temperature 0`，`steps 40`，`permission allow`），prompt 不变（已含"见 `[SDD-REVIEW]` 就读 todo+取证+勾选"）。
- Claude Code：沿用 `run-real-e2e.ps1` 的 hook 接线。
- 每次跑前 `npm run build` 确保插件产物最新（脚本会把 `sdd-review-ledger-opencode.js` + `sdd-review-rules.md` 拷进 workspace）。

---

## 3. 阶段脚本（~18 阶段，多 session，多轮迭代）

> 格式贴合现有 `$phases`（`id` / `title` / `prompt`）。`prompt` 沿用英文 + workflow marker `$marker` 风格，保留 `# Design`/`# Tasks` 标题。下面给**动作要点 + 触发行为 + 看点**；落到脚本时按现有 prompt 写法展开。

### Act 1 · Session A — 冷启动 + 基础 feature

| 阶段 | 动作 | 触发 | 看点 |
|---|---|---|---|
| **P01** | 只建 `badge-greeting/design.md`（描述按 name+level 返回问候徽章） | C1, C2 | 0 提醒；todo 出现 design.md 被动 pending |
| **P02** | 据 design 建 `badge-greeting/tasks.md`，不写 code | C2 | 0 提醒；两篇 doc 被动 pending |
| **P03** | 据 tasks 实现 `badgeGreeting.ts` + `index.ts`（含 marker） | C6, W1 | **full** 提醒一条；看模型勾选前是否 Read design/tasks、rationale 是否引证 |
| **P04** | 同一回合两处 code 改：空名→`guest-$marker`；抽出 `badgeFormatter.ts` 并被 badgeGreeting 引用 | C4, C5 | 一条提醒（once）；同回合第二文件被抑制但 Stop 捞回；都是 code → 走 full，不误触 leftover |

### Act 2 · Session A 续 — 迭代 + T2 同回合陷阱

| 阶段 | 动作 | 触发 | 看点 |
|---|---|---|---|
| **P05** | 改 `badge-greeting/design.md`：加"level≥5 给 VIP 前缀"。明确"非提醒要求不要改 code" | C2, C3, C9 | **静默**（doc 领先）；模型**没有擅自实现** code |
| **P06** | 据新 design 改 code 支持 VIP；**评审完成后在同一回合再改 `tasks.md`** 勾 checklist | C6, **C7**, C10 | code 改触发 full；改 tasks 产生新 hash；**CC：Stop 应短 block 点名新 tasks hash 且非 full、续审后不重复**；OpenCode：看 P07 起的下一轮 carry |
| **P07** | 纯重命名局部变量/格式化 `badgeFormatter.ts`（**无行为变化**） | C12, W2 | 良性 pending → 一行理由勾掉；**捕获该条 rationale 看 #3** |

### Act 3 · Session B（切会话）— 第二 feature + 归属

| 阶段 | 动作 | 触发 | 看点 |
|---|---|---|---|
| **P08** | （新 session）建 `vip-tiers/design.md` | C16, C2, C10 | 跨会话 ledger 延续；doc-only 静默；上一会话遗留的 passive doc **不被误当新增** |
| **P09** | 实现 vip-tiers：新建 `tiers.ts`，并**改共享文件 `badgeGreeting.ts`** | **C11**, W1 | 候选 change-dir 含 badge-greeting & vip-tiers → 看模型如何归属 + 取证 |
| **P10** | 横切重构：同回合改 `badgeGreeting.ts`/`tiers.ts`/`badgeFormatter.ts`（跨 A/B） | C4, C5, C11 | once 一条；多归属；Stop 捞回被抑制项 |

### Act 4 · Session B 续 — 第三 feature + 走过场 + 跨回合陷阱

| 阶段 | 动作 | 触发 | 看点 |
|---|---|---|---|
| **P11** | 同回合建 `i18n-locale/design.md` + `tasks.md`（两篇 doc） | C2, C9 | 两篇都被动、0 提醒 |
| **P12** | 实现 i18n：新建 `locale.ts`，**只新增不改老行为**（容易让模型觉得"无冲突"） | **W1**, C6 | **走过场观察**：rationale 是否真引证 design/locale、勾选前是否 Read，还是裸"无冲突"盖章 |
| **P13** | （OpenCode 重点）评审 P12 后**回合内再改 `i18n-locale/design.md`**，让回合自然在 idle 结束 | **C8** | idle 拦不住 → **下一轮**应**一次性** carry 点名该 doc 新 hash；**再下一轮不重复**（已消费快照） |

### Act 5 · Session C（切会话）— 长任务/压缩 + 删除 + code 领先 + 逃生阀 + 终检

| 阶段 | 动作 | 触发 | 看点 |
|---|---|---|---|
| **P14** | （新 session）较长多步：实现 `audit-log`（`auditLog.ts` 被多处 import）+ 串联多文件 + 跑一次 `npm run check`（tsc） | C16, **C17**, C5 | 迫使上下文增长；看模型是否仍记得评审、Stop/idle 是否把漏项捞回 |
| **P15** | 删除某 feature 的一个 code 文件（如下线 i18n 的一个模块）并从 index 移除引用 | **C14**, C2 | 删除文件不浮现/不报错；对应 doc 现在领先 → 被动静默 |
| **P16** | bug-fix：直接改 `tiers.ts` 行为，但**不动 design** | **C13** | code 领先 → full 提醒；期望模型**把 design/tasks 同步到 code 现状**，而非留漂移、也非反向改 code |
| **P17** | 设 `SDD_REVIEW=off` 跑一个改动阶段；随后取消该环境变量再跑一阶段 | **C15** | off：无提醒、无 ledger/todo 写盘；恢复后能**自愈**重新追踪 |
| **P18** | 收尾：制造"评审完又改 doc 留尾巴" + 正常收尾 | W1, W2, C7/C8 | **捕获终态 todo + 审计历史全文**，人工核 #1 取证质量 + #3 理由完整度；CC 看 Stop、OpenCode 看下一轮 carry |

---

## 4. 平台 × 模型 × 场景矩阵

| 维度 | 取值 |
|---|---|
| 平台 | **OpenCode**（workflow.ps1 扩展）+ **Claude Code**（run-real-e2e.ps1） |
| 模型 | **MiniMax-M2.7**（压力目标，遵循不稳）、**DeepSeek-chat**（稳基线）；可选第三个（任配置好的） |
| 场景 | `single-session`（全程同会话）、`split-multi`（**新增**：P08、P14 处各切一次 session）、`split-at-04`（沿用，快速变体） |

**先后建议（按 ROI）**：
1. `MiniMax × OpenCode × single-session` 与 `× split-multi` 各一轮 —— 最易逼出问题。
2. 同两场景补 `DeepSeek × OpenCode` 作稳基线对照。
3. `MiniMax × Claude Code`（验 Stop 强制 block 这条 CC 专有路径，T2 同回合 C7 的硬验证）。
4. 资源够再补 `DeepSeek × Claude Code` 与第三模型。

> `split-multi` 需在 workflow.ps1 的会话切换逻辑里，把"清空 `$activeSessionId`"的触发点从仅 `04-multi-code` 扩成 `P08`、`P14`（与现有 `split-at-04` 同机制）。

---

## 5. 采集规范（比现有 runner 更细）

现 runner 每阶段已存 `<id>.out.jsonl` / `<id>.err.log` + 终态 `.sdd-review-todo.md`。在此之上做一遍 **post-run 分析**（无需改插件，仅读日志）：

**5.1 每次注入分类**（在 `.out.jsonl` 里按串识别，记 full/compact/leftover/carry/none）：

| 类型 | 识别串 |
|---|---|
| full（首条完整协议） | `你是唯一语义裁判` 且 `最终门槛` |
| compact（同回合精简） | `本回合仍有` 且 **不含** `你是唯一语义裁判` |
| **leftover-short（T2）** | `review 后又编辑` / `上一轮 review 后又编辑` |
| carry（跨会话/下轮，code） | `项变更尚未评审` |
| none | 该工具结果无 `[SDD-REVIEW` |

**5.2 取证观测（W1，只读不判）**：在每阶段 `.out.jsonl` 里，看 `[SDD-REVIEW]` 注入**之后、勾选 todo 之前**，模型是否对相关 `design.md`/`tasks.md`/code 发过 `read` 工具调用（grep 工具事件里的 filePath）。记 `read 命中: design ✓/✗ · code ✓/✗`。

**5.3 理由原文（W1/W2）**：从终态 `.sdd-review-todo.md` 的「## 审计历史」抽每条 `- [x] <path>@<hash> — <rationale>`，**原样**记录，人工标注：是否引证（含 design 片段/code 符号）、是否半截句/过简。

**5.4 每阶段 pending 增量**：记 `pending path@hash` 的 before/after，标出**新增的**与**被清掉的**。

**5.5 结束点行为**：CC 记 Stop 是否 `decision:block`、reason 是 full 还是 leftover-short、`stop_hook_active` 后是否不再 block；OpenCode 记 idle 后下一轮是否 carry、carry 是否一次性。

**5.6 运行时健康**：`exitCode`、`err.log` 里的 error/exception/failed 词频、`npm run check`（tsc）是否通过。

---

## 6. 通过/失败判据 & "隐藏问题"定义

**逐行为判据**（对照 §1 矩阵）：每个 C/W 项按其"看点"给 PASS / FAIL / 观测值。重点硬门槛：

- **C7**（CC T2 同回合）：P06 收尾必须出现**短 leftover block** 点名新 tasks hash，且**不含** full 协议；续审后不重复。FAIL = 没 block / 给了 full / 死循环。
- **C8**（OpenCode T2 跨回合）：P13 后**恰好一次** carry 点名；再下一轮无重复。FAIL = 不 carry / 每轮都 carry。
- **C2/C9**（B + 规划静默）：P05/P08/P11/P15 必须 **0 active 提醒、不 block、不 carry**，但 todo **有**被动记录。FAIL = 改文档被主动催，或漏记。
- **C5/C17**（兜底不丢项）：被抑制/被遗忘的 **code** 项最终必须经 Stop/idle/carry 浮现，**绝不静默丢**。

**"隐藏问题"**＝计划没预期、但跑出来的任意一种：
1. **误报打扰**：纯规划改文档却被主动催 / 既有 pending 被当 leftover。
2. **静默丢项**：某 pending 既没被勾、也没被任何通道浮现。
3. **注入体类型错配**：该 full 给了 compact、该 leftover-short 却灌了 full、或重复轰炸。
4. **死循环 / 卡顿**：Stop 反复 block、回合无法结束。
5. **跨会话/跨平台不一致**：同一阶段 OpenCode 与 CC 行为分叉超出 §4.5 已知不对称。
6. **运行时错误**：hook 抛错、tsc 失败被忽略、ledger/todo 写坏。
7. **走过场盖章**（W1）与**理由截断/过简**（W2）的**频率与分布**（这是已知弱点，量化它在不同模型/平台上的发生率，作为是否要做 #1/#3 优化的证伪输入）。

---

## 7. 报告模板（与现有体验报告对齐，便于横向对比）

每个 run 产出一份，最后汇总成一份多场景报告，骨架：

```markdown
# sdd-review-ledger 多场景体验报告（<date>）
## 1. 范围与样本（platform / model / scenario / runId / sessionIds / workRoot）
## 2. 阶段结果表（P01–P18 × | 注入类型(full/compact/leftover/carry/none) | 提醒次数 | 阶段末 pending | 勾选数 | read命中 | 结果判断 |）
## 3. 行为覆盖判定（§1 矩阵逐项 PASS/FAIL/观测）
## 4. 针对性陷阱结果（C7 / C8 / C2-C9 / C5-C17 各自实况）
## 5. 弱点量化（W1 走过场率：N/总勾选；W2 理由质量：完整/过简/截断分布）
## 6. 隐藏问题清单（§6 七类，逐条实证 + 日志定位）
## 7. 平台/模型差异（OpenCode vs CC、MiniMax vs DeepSeek）
## 8. 结论与下一步（是否需要 #1/#3 优化、是否有新 bug 要修）
```

---

## 8. 执行步骤（可直接照做，Windows）

1. **构建产物**：在 `plugins/sdd-review-ledger` 跑 `npm run build`（脚本会拷最新 bundle + 规则进 workspace）。
2. **扩展阶段**：把 §3 的 P01–P18 写进 `run-real-sdd-review-ledger-workflow.ps1` 的 `$phases`（沿用现有 prompt 风格 + `$marker`）；把 `split-multi` 的会话切点加到 `P08`/`P14`（仿现有 `split-at-04`）。
3. **OpenCode 跑**：`./run-real-sdd-review-ledger-workflow.ps1 -Provider minimax -Scenario single-session`，再 `-Scenario split-multi`；换 `-Provider deepseek` 重跑。
4. **CC 跑**：`test/claude-code-sdd-drift-e2e/scripts/run-real-e2e.ps1`（同阶段脚本，验 C7 的 Stop 强制 block）。
5. **矩阵**：用 `test/run-sdd-drift-real-matrix.ps1` 串起 provider × scenario（× platform）。
6. **采集分析**：按 §5 对每个 run 的 `<id>.out.jsonl` + 终态 todo 做 post-run 分析；按 §7 出报告。
7. **汇总**：合成一份多场景报告，结论喂回是否要落地 #1/#3 优化。

> 节流：先只跑 §4 的第 1 步（MiniMax×OpenCode×{single,split-multi}）逼问题；有发现再按矩阵补全对照。每个 run 18 阶段 × `steps≤40`，注意 API 配额与超时（现脚本 `temperature 0` 已尽量可复现）。

---

## 9. 与已知弱点的关系（先测后改）

- 本计划**不改插件代码**——它的产出（尤其 W1/W2 的发生率、是否有 §6 隐藏问题）正是决定"#1 提示硬化/渲染标记、#3 截断标记到底值不值得做、怎么做"的**证伪输入**（呼应架构 §16.5「主通道忽略率」与 gateguard-lessons §10 残余「先裸测纯非阻断下的真实完成率」）。
- 若跑出 §6 第 1/2/3/4 类（误报、丢项、错配、死循环）——那是**真 bug**，优先于体验优化修。
