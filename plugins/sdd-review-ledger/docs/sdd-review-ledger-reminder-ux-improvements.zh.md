# sdd-review-ledger 提醒体验改进思路

> 状态：**设计提案（未实现）**。本文记录基于 2026-05-31 DeepSeek 真实模型实测
> （见 `sdd-review-ledger-real-model-report-2026-05-31.zh.md`）+ 后续设计讨论得出的
> 提醒（reminder）体验改进方向，作为后续 TDD 落地的依据。
>
> 配套阅读：`sdd-review-ledger-gateguard-lessons.zh.md`（gate vs nudge 的历史决策）、
> `sdd-review-ledger-architecture.zh.md`（§1 永不阻断 / §2 工具不答语义 / §9 提醒通道 /
> §10 诚实残余 / §16.5 主通道忽略率验收）。

---

## 0. 背景与动机

真实模型实测确认了两件事：

1. **功能是对的**：7 步交叉开发流程全部完成、退出码 0、最终待评审清空，跨会话也能延续审查状态。
2. **提醒偏吵**：在「边实现、边同步文档、边勾 todo」这种正常迭代里，单个阶段注入了 5–7 次
   完整提醒（报告场景一 03=7、04=5）。

后续讨论又暴露了第二个、更要紧的担忧：

3. **长任务遗忘**：在一个**超长单轮**里（模型自主连续干很久、中途没有新的用户消息），
   如果只靠「每次相关编辑提醒」，一旦收敛到不再产生新文件，主动提醒会安静下来，
   存在「模型忘了还要评审就把任务收尾了」的风险。

本文给出的改进同时回应这两类问题，且**全部保全现有不变量**（见 §7）。

---

## 1. 现状速览

### 1.1 提醒触发模型（核对自源码）

- 主动提醒只在 `PostToolUse` 且工具 ∈ `{Edit, Write, MultiEdit}` 时触发
  （CC：`src/dispatch.js:11,28-31`；OpenCode：`tool.execute.after`，`native-plugin.js:228-251`）。
- 是否「再发一条」由 `decideReminder` 判定（`src/core/throttle.js:54-63`）：
  去重签名 = 各 pending 项 `path@currentHash` 排序拼接（`src/handlers/on-edit.js:12-16`），
  仅当**签名完全相同**且落在 `reminderDedupeMs`（默认 2000ms，`src/core/config.js:11`）窗口内才抑制。
- 默认 `sessionMaxReminders = Number.MAX_SAFE_INTEGER`（`src/core/config.js:8`）= 实际上**不限量**。
- 跨会话/新回合：`UserPromptSubmit`（CC）/ `chat.message`（OpenCode）触发 `onPrompt`，
  若仍有 pending，注入**精简** carry-over（`src/core/prompts.js:68-78`，187 字节，只报数量 + 指针）。
- OpenCode 已有「Stop 等价物」：`session.idle` / `session.status:idle` 事件被映射成
  `hook_event_name = "Stop"`，目前只调用 `run()` **静默刷新** ledger+todo、不注入提醒
  （`native-plugin.js:253-268`）。CC 端**没有任何 Stop 分支**。

### 1.2 噪声的唯一根因

去重签名绑 `path@currentHash`，而 `currentHash` 是整文件 sha256。**任何内容改动都会换新 hash
→ 换新签名 → 不再算「重复」→ 立即再发一条完整 ~1.5KB 提醒**。这是 03/04 阶段密度高的唯一原因，
不是循环 bug。2 秒窗口只能合并「几乎同时、且 pending 集字节完全相同」的多文件写。

> 关键认知：**「提醒」≠「记忆」。** 真正不丢的机器是「始终照写的 `.sdd-review-todo.md` +
> 下一回合 carry-over + 内容变则自动重新待评审」。提醒只是即时的「门铃」，
> 节流重复门铃**不会**抹掉清单。

---

## 2. 改进一（P0）：按回合合并 + 按「路径集」去重

**问题**：同一回合内反复改**已提醒过的同几个文件**，每次换 hash 都重发。

**做法**：把主动提醒的去重键从 `path@hash` 换成「**当前回合内的 pending 路径集**」：

- 渲染（提醒正文、todo）里**仍保留 `@hash`**——它负责「内容一变自动重新待评审」，不能丢。
- 去重判定改为：同一回合内 `pendingPathSet ⊆ lastRemindedPathSet` → 抑制；
- **路径集只要增长（出现任何一个本回合还没提过的新文件）→ 永远立即提醒**；
- 跨回合用已存在的 `bumpBatch`（`on-prompt.js:23`，每个用户回合 +1）边界**重置**「已提醒集」。

**效果**：03 阶段 7 次 → 收敛为「每个新文件首现各一次 + 反复打磨已知文件时安静」；
05 阶段两个不同文件（design.md、tasks.md）真实先后漂移，仍各报一次（这是**正确**行为，
报告自己也判定「2 次是合理的」），但靠 §3 让第二次变轻。

**为什么不漏**：「路径集一增长就必报」是**按构造**的保证——真·新审查义务结构上不可能被静音；
被抑制的只是「同一文件本回合又动了一下」。即便如此，该文件仍在写好的 todo 里、下一回合 carry-over
会重报、且旧 hash 勾选无法误清（`compute.js:51,78` 比的是实时 hash vs reviewedHash）。

**剩余口子**：超长单轮里，如果全程只反复改同几个已提醒文件、再没新文件，主动推送会安静一段
（它仍在 todo 上，不算丢）。这个口子由 §4 的 Stop 收尾扫覆盖（比 §5 的定时器更干净）。

---

## 3. 改进二（P1）：同会话重复提醒复用精简体

**问题**：每次都重灌完整 ~1.5KB / 21 行协议，其中 ~1.2KB（`REVIEW_BLOCK` + `ACTION_LINE`，
`prompts.js:16-29`）每次字节相同；纯上下文浪费。而精简体（`buildCarryOver`，187 字节）已存在，
却只用于跨会话。

**做法**：每回合**首条**主动提醒（或路径集增长时）发完整协议；同回合后续提醒退化为
「N 项待评审，见 `.sdd-review-todo.md`」的精简体（仿 `buildCarryOver`）。
路径集增长时可带一行 delta（如 `+1 新增: <path>`）以保留「有新义务」信号。

**约束**：精简体需有自己的**字节稳定快照测试**（与 `todo.js`/`prompts.js` 现有快照契约一致）。

**风险**：零覆盖风险——精简体仍报数量 + 指针，什么都没丢，纯呈现/token 优化。

---

## 4. 改进三（P0，核心）：Stop 回合末 SDD 同步评审扫描（双平台）

**目标**：堵住「长任务模型忘了评审就收尾」的口子——在**回合自然结束（要交还/收尾）那一刻**，
补一轮 SDD 同步检查：还有没对齐的就**正好提醒并强制补审一次**，没有就放行收尾。

### 4.1 机制要点（关键）

要让模型在 Stop 时**真的去评审**，唯一可行路径是**强制再续一回合（block once）**——
不 block 的话，Stop 触发时模型已经写完收尾，注入的文本本回合不会被执行（退化成下一回合才提醒）。

### 4.2 为什么这不违反历史决策

- **不违 §2**：Stop 只问纯机械问题「`pending` 还空不空」（`compute.js` 本来就在算），
  **对不对齐、要不要改全程仍由模型判断**。这与被否决的 PreToolUse「FactGate」有本质区别——
  后者要工具预先做「这块 code 归哪个 change-dir」的**语义归属**，那才是 §2 红线。
- **§1 在长任务场景最弱**：block-at-stop 是「软门」（延迟交还），但长任务里**没有人坐等收回控制权**，
  「卡心流」的顾虑在此最轻；而这恰是它最该出手的场景（宣布完成前的最后防线）。

### 4.3 双平台落地（两边都加）

- **Claude Code**：`dispatch.js` 新增 `Stop` 分支。跑一遍 pipeline →
  有 pending 且 `!stop_hook_active` → 返回 `{ decision: "block", reason: <评审指令> }`；
  pending 空或 `stop_hook_active` → 放行。
- **OpenCode**：复用现有 `session.idle` / `session.status:idle` 入口
  （`native-plugin.js:253-268`，**实测触发概率不低、可靠可用**），从「静默 `run()`」升级为
  「有 pending 时注入评审提醒并促使模型续审」。其「促使模型实际动手」的确切机制
  在实现时验证（事件返回注入 vs 下一条消息浮现），并配套与 CC `stop_hook_active` 等价的
  「同一 pending 集不重复 block」防抖（现有 `IDLE_DEDUP_WINDOW_MS=500` + `shouldHandleIdle` 可扩展）。

### 4.4 防死循环（必须做对）

**最多 block 一次**：
```
模型想收尾 → 有 pending 且非 stop_hook_active
   → block 一次："还有 N 项没对齐，逐项取证评审、需要就同步 design/tasks，然后再给总结"
模型评审/勾选 → 再想收尾
   → 放行（pending 清了，或 stop_hook_active 兜底）
```
即「收尾前补一次评审」，绝不「清不干净就永远出不去」。模型若确实清不掉，最多挡一次即放行。

### 4.5 平台不对称（诚实写明）

- CC = 收尾前**强制**扫一遍（`decision:"block"` 是 CC 专有契约）。
- OpenCode = 经 `session.idle` 注入提醒促审；若某次未能强制续跑，则退化为**下一回合 carry-over 必浮现**。
- 两边都保证「不会遗忘」；CC 额外保证「同一长轮收尾前也跑不掉」。

---

## 5. 可选（P2）：只「重新 arm」的 TTL

**做法**：可选 `reminderTtlMs`（环境变量，**默认关**）。超长单轮里若距上次提醒超过 TTL，
即使路径集没变也重发一次。时钟只能**增加**提醒、永不抑制（`decideReminder` 已注入 `nowMs`）。

**取舍**：与「宁可多提醒」一致、结构上不可能藏东西。但 §4 的 Stop 收尾扫卡在自然回合边界、
比定时器更干净，**故 P2 优先级最低**——仅当实测显示「超长单轮中段」也需要周期性 nudge 时再上。

---

## 6. 明确拒绝的方向（及理由）

| 方向 | 结论 | 理由 |
| --- | --- | --- |
| PreToolUse「FactGate」（写盘前 DENY code 编辑） | **拒绝** | 触发条件「这块 code 有活着的 design 对应」是 §4/§6.4 外包给 LLM 的**语义归属**，让 PreToolUse 预先答它 = 违 §2 元原则（比违 §1 更深）；且 OpenCode 侧 deny+重试未经验证。见 gateguard-lessons §三 / 矩阵 #5。 |
| 绝对「force-continue」门（清不干净就一直挡） | **拒绝** | 会把 agent 无限锁在回合里、烧 token、用户拿不回控制权。§4 用 `stop_hook_active` 退化成「至多 block 一次」。 |
| 重新引入 session 提醒硬上限（默认有限） | **拒绝** | R2→R3 已证明「每会话/每批次上限」会让后半程重要变更**静默漏报**（gateguard-lessons L11）。`SDD_REVIEW_SESSION_MAX_REMINDERS` 保留为**可选**硬闸，默认无限。 |
| 语义驱动的严重度分级 | **暂缓** | 分级若需内容语义即违 §2；只能由纯机械信号（`classifyPath` kind、是否在活跃 change-dir、never-reviewed vs changed）推导。风险高、收益被 §2 / §4 大部分覆盖，暂不做。 |

---

## 7. 必须保全的不变量

任何上述改动都**不得**破坏：

1. **清除唯一信号 = 勾选**：编辑文件永不自动清除；只认 `.sdd-review-todo.md`「待评审」区 `[ ]→[x]`。
2. **fail-open**：任何错误 → 静默，绝不抛给用户、绝不阻断用户输入/主流程、绝不改审批流（§1 硬核，架构 §7.5）。
3. **工具不答语义**：`computeNeedsReview` 只回答 `hash(elem) ≠ reviewedHash`，一切「对齐/偏差/归属」判断留给模型（§2）。
4. **字节稳定**：`renderTodo` / 各提醒模板「同输入→同字节」；新增精简体需配套快照契约。
5. **永不静默丢失**：扫描超预算等覆盖损失必须在 todo 顶部可见警告；待评审项留着不勾是安全的。

---

## 8. 对比成熟工具（简表）

| 维度 | 成熟做法 | 改进后我们 |
| --- | --- | --- |
| 持久面板/原地更新 | LSP `publishDiagnostics` 替换、Danger 单评论、Renovate 单看板 | 已对齐（幂等 `.sdd-review-todo.md`），保留 |
| 事务/批次边界 | husky+lint-staged 在 commit 边界触发一次 | **改进一**：按用户回合合并 |
| 重复时精简 | 重协议示一次、重复用轻量指针 | **改进二**：首条完整、同回合后续精简 |
| 收尾守门 | —（多数工具无 agent 收尾概念） | **改进三**：回合末 SDD 同步扫，block-once |
| 逃生阀 | GateGuard 每次 deny 带内印 Recovery 行 | 已有 `SDD_REVIEW=off`；可加带内点名开关（P2 附带） |

---

## 9. 落地与验证计划

**实现顺序**：改进一（P0）+ 改进三（P0）一起做，改进二（P1）随附；P2 视实测再定。

**TDD 必钉死的行为**：

- 改进一：`{A}` 已提醒、同回合 `{A,B}` → **必报**（B 是新）；同回合 `{A}` 重 hash → **抑制**；
  跨回合 → 重新算（必重报）；被抑制项**仍在 todo 且为最新 hash**；下一回合 carry-over 必重报。
- 改进三（CC）：有 pending → Stop **必 block 一次**并列出 N 项；pending 空 → 放行；
  `stop_hook_active=true` → **绝不再 block**（防死循环）。
- 改进三（OpenCode）：`session.idle` 有 pending → 注入提醒；同一 pending 集不重复 block；
  无 pending → 不打扰、只刷新。
- 全程 fail-open：任一环节抛错 → 静默、退出 0。

**开放问题 / 待验证**：

1. **主通道忽略率**（架构 §16.5，仍未测）：模型收到主动提醒后实际去评审/勾选的比例。
   它决定改进一的「首条完整」是否够、以及是否真需要更强的 §4 强制。
2. **OpenCode「促使续审」的确切机制**：`session.idle` 注入后，是当场促使模型续审，
   还是落到下一条消息浮现——实现时实测确认（用户反馈 idle 触发概率不低）。
3. **超长单轮中段**是否需要 P2 TTL，还是 §4 收尾扫已足够。

---

> 一句话：**改进一让唠叨变克制但不漏；改进二让重复变轻；改进三（双平台 Stop 收尾扫，block-once）
> 是长任务的最后防线。** 三者都不碰「让工具答语义」「永不阻断用户主流程」「清除只认勾选」这几条底线。
