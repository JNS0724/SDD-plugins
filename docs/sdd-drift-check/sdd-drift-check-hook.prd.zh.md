# `sdd-drift-check` PRD：跨会话 SDD 偏差检测

**版本:** 1.3
**日期:** 2026-05-26
**修订记录:** v1.3 — 同步当前主用户面为 Claude Code + OpenCode native plugin，补充结构化提示词与模型可见 checkpoint 约束；v1.2 — 修正 peer 文件不存在时不触发 doc-doc drift；明确 `codeAheadOfDocs` 逐文档 review；新增 `PreToolUse` 提问/交接 checkpoint 范围；统一 ProjectState 存储路径为 `<stateDir(cwd)>/project.json`
**作者:** Claude（Opus 4.7）+ 用户协同
**范围:** 从用户旅程出发，定义"什么是 SDD 偏差"以及 hook 应该在何时提醒
**配套文档:**
- [sdd-drift-check-hook.design.zh.md](./sdd-drift-check-hook.design.zh.md)：实施方案设计文档（PRD 的工程实现）

**版本锁定:** `opencode-ai@1.2.27` + `@opencode-ai/plugin@1.2.27`；`oh-my-opencode@3.17.2` 仅作为旧桥接兼容参考

**文档更新日志:**

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.3 | 2026-05-26 | 当前主用户面调整为 Claude Code command hook 与 OpenCode native plugin；OMO 旧桥接降为历史兼容参考；明确 `<system-reminder>` / `SYSTEM DIRECTIVE` 是模型可见提示词契约 |
| v1.2 | 2026-05-22 | 修正 peer 文件不存在时不触发 doc-doc drift；明确 `codeAheadOfDocs` 逐文档 review；新增 `PreToolUse` 提问/交接 checkpoint 范围；统一 ProjectState 存储路径 |
| v1.1 | 2026-05-22 | 新增 J9–J16 旅程；FR11 改为 LLM 评审驱动归属；新增 FR12 / FR13；新增附录 A `ATTRIBUTION_REVIEW_RULES` 草案 |

---

## 目录

1. [背景与核心问题](#一背景与核心问题)
2. [术语与概念](#二术语与概念)
3. [用户旅程目录](#三用户旅程目录)
4. [旅程行为总表](#四旅程行为总表)
5. [功能需求](#五功能需求-fr)
6. [非功能需求](#六非功能需求-nfr)
7. [领域模型](#七领域模型)
8. [Hook 集成点](#八hook-集成点)
9. [边界场景](#九边界场景)
10. [非目标](#十非目标)
11. [验收标准](#十一验收标准)
12. [与现有实现的差距](#十二与现有实现的差距)
13. [附录 A：评审规则常量草案](#十三附录-a评审规则常量草案)

---

## 一、背景与核心问题

### 1.0 当前适用面

本 PRD 的需求目标保留不变：减少 SDD 文档与代码事实的漂移。当前实现的主适用面是：

- Claude Code 原生 command hook。
- OpenCode native plugin。

旧版 OpenCode + OMO hook bridge 仍可作为历史兼容路径，但不作为当前主验收矩阵。OpenCode native 场景下，Stop continuation 仍是 best effort；可靠的模型可见提醒主要通过 `tool.execute.after` 的工具结果、`tool.execute.before` 的 question checkpoint，以及 compaction/carry-over 摘要完成。

模型收到的 SDD 提醒统一为结构化可见文本：

```text
<system-reminder>
[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - <TYPE>]
...
</system-reminder>
```

这不是隐藏系统消息，也不是运行时强制循环协议；它是 hook 在当前可用通道中给模型的高优先级 checkpoint 指令。

### 1.1 SDD 工作流是跨会话的

用户开发一个需求的实际节奏是：

```
Day 1 (session A): 写 proposal、design、tasks，开始改代码
Day 2 (session B): 继续 vibe coding，可能委托子代理
Day 3 (session C): 评审 tasks.md，发现 design.md 落后
```

但现有 `sdd-drift-check-hook.js` 的 state 是 `(cwd × sessionID)` 双键的会话级文件（[L261-262](./sdd-drift-check-hook.js)）——**sessionID 一换全清零**。

### 1.2 现有 hook 的盲区

| 现象 | 现有 hook 行为 |
|---|---|
| 新会话改代码（SDD 来自历史）| `hasEditedSddChange = false` → 当成"新任务"，不提醒 |
| 跨会话只改 tasks.md（design 落后） | 当前规则 `[TASKS_FILE]: [DESIGN_FILE]` 能命中，但只在会话内有效 |
| 子代理跨会话改代码 | 仅靠 mtime 启发式，不可靠 |
| 同会话 proposal→design→tasks→code 一气呵成 | **误报 drift**（code.seq > doc.touchedSeq） |

### 1.3 本 PRD 解决的问题

定义一组明确的 **用户旅程 + 期望行为**，由它推导：
- 数据需要持久化到哪一层（session vs project）
- 状态机的状态与转移条件
- Hook 应在哪些时刻读/写状态、何时提醒

不解决：自动 review（auto-review）、通用 PreToolUse 阻断、LLM 语义理解。`PreToolUse` 仅允许作为提问/交接类 checkpoint，防止 agent 在 drift 未处理时直接把控制权交还用户。

---

## 二、术语与概念

| 术语 | 定义 |
|---|---|
| **SDD** | Spec-Driven Development，本工具适用的开发流程 |
| **change-dir** | 一个 SDD 变更目录，路径形如 `sdd/changes/<id>/` 或 `.sdd/changes/<id>/` |
| **Doc** | change-dir 下的 `proposal.md` / `design.md` / `tasks.md` 三个文档之一 |
| **linked code** | 一个或多个代码文件，被关联到某个 change-dir（关联规则见 §7.3）|
| **active change-dir** | 当前隐式承接代码编辑的 change-dir（带 TTL 持久化） |
| **edited** | 文件被 Edit/Write/MultiEdit 写入 |
| **reviewed** | 文件被 Read 或被 edited（edited 隐含 reviewed） |
| **drift / 偏差** | 文档与代码、或文档之间，因编辑顺序产生的"待同步"状态 |
| **alignment** | drift 的反面，所有相关文档与代码在编辑时序上一致 |
| **session** | 一次 Claude Code 或 OpenCode 会话，由 `session_id` 标识 |
| **subagent** | 子代理；通过 `task` / `call_omo_agent` / `delegate_task` 等工具调起 |
| **changes mode** | 项目内已存在至少一个未归档的 change-dir 的状态 |
| **vibe coding** | 用户跳过 SDD 流程、直接让 agent 改代码的非正式开发模式 |
| **carry-over drift** | 跨会话遗留的、本会话尚未感知的 drift |

---

## 三、用户旅程目录

格式：**前置条件 / 用户操作 / Stop 时期望 / 关键挑战**

### J1 — 单会话完整流：proposal → design → tasks → code

| 维度 | 内容 |
|---|---|
| 前置 | 项目首次开启 SDD；无任何 change-dir |
| 操作 | 用户提需求 → agent 写 proposal → 写 design → 写 tasks → 按 design 改代码 |
| Stop 期望 | **无提醒**。SDD 已完整，代码即实现 |
| 关键挑战 | 与现有 hook 行为冲突：现有逻辑会产出"code 在 doc 之后"的 drift。**需要识别"实现阶段"**——SDD doc 在本会话刚编辑、紧接着代码实现，应视为完成 |

### J2 — 单会话完整流 + 子代理实现

| 维度 | 内容 |
|---|---|
| 前置 | 同 J1 |
| 操作 | 同 J1，但代码编辑由子代理执行 |
| Stop 期望 | **无提醒**。子代理的代码改动是父代理实现意图的一部分 |
| 关键挑战 | 子代理编辑需归属到父会话的 active change-dir；时序判定与 J1 一致 |

### J3 — 完整流后继续改代码（同会话）

| 维度 | 内容 |
|---|---|
| 前置 | J1 流程完成、上一轮 Stop 已无提醒 |
| 操作 | 用户在下一轮提出代码修改 → agent 改代码（未触发 SDD 文档编辑） |
| Stop 期望 | **应提醒**。这次的代码改动没有对应的 SDD 文档同步 |
| 关键挑战 | 把"上一轮已完成"作为新基线；新一轮的代码编辑相对该基线就是 drift |

### J4 — 跨会话 vibe coding

| 维度 | 内容 |
|---|---|
| 前置 | 项目处于 changes mode（已有未归档 change-dir）|
| 操作 | 用户重开会话 → 直接让 agent 改代码（不读不写 SDD 文档） |
| Stop 期望 | **应提醒**。代码改动 + 跨会话遗留的 SDD 都需要重新对齐 |
| 关键挑战 | 新会话 state 为空；必须从项目级状态识别"已有 change-dir + 当前代码改动产生 drift" |

### J5 — 跨会话只评审 tasks.md，反向 drift

| 维度 | 内容 |
|---|---|
| 前置 | 项目处于 changes mode |
| 操作 | 用户重开会话 → agent 读 tasks.md → 用户提出修改 tasks.md → agent 写 tasks.md |
| Stop 期望 | **应提醒：design.md 落后于 tasks.md** |
| 关键挑战 | 反向 drift（tasks → design）。当前 [CHANGE_DOC_REQUIREMENTS](./sdd-drift-check-hook.js) 已支持 `TASKS_FILE: [DESIGN_FILE]`，但需确认跨会话仍生效 |

### J6 — 跨会话 plan 模式 + 用户委托子代理

| 维度 | 内容 |
|---|---|
| 前置 | 项目处于 changes mode |
| 操作 | 用户重开会话 → 使用 plan 模式 → 通过 task 工具委托子代理 → 子代理改代码 → 返回父代理 |
| Stop 期望 | **应提醒**。代码改动跨会话且未对齐 SDD |
| 关键挑战 | plan 模式下的 task 工具识别 + 子代理编辑归属 + 跨会话 state |

### J7 — 跨会话父代理主动委托子代理

| 维度 | 内容 |
|---|---|
| 前置 | 项目处于 changes mode |
| 操作 | 用户重开会话 → 父代理决定委托 task 子代理 → 子代理改代码 → 返回父代理 |
| Stop 期望 | **应提醒**。与 J6 同 |
| 关键挑战 | 从 hook 视角 J6/J7 不可区分（都是 task 工具触发）；处理一致即可 |

### J8 — 子代理改完返回后父代理向用户提问

| 维度 | 内容 |
|---|---|
| 前置 | 同 J6 |
| 操作 | 父代理收到子代理结果后，**不直接结束**，而是向用户发问（如"是否提交代码"）|
| 提问前期望 | 若提问/交接类工具可被 `PreToolUse` 捕获，应先触发 question checkpoint，要求 agent 完成 SDD review / sync 后再提问 |
| Stop 期望 | 若 `PreToolUse` 未覆盖或桥接不支持，Stop 仍执行 drift 检测作为兜底 |
| 关键挑战 | 从 hook 视角无法可靠区分"提问的 Stop"与"终结的 Stop"；因此用 `PreToolUse` 覆盖可识别的提问/交接动作，用 Stop 覆盖最终兜底 |

### J9 — Proposal-only 停滞

| 维度 | 内容 |
|---|---|
| 前置 | 项目首次开启 SDD；无任何 change-dir |
| 操作 | 用户提需求 → agent 写 proposal.md → 用户没继续 → Stop |
| Stop 期望 | 仅 stage reminder（非阻塞）|
| 关键挑战 | 验证 PROPOSAL_STAGE 状态的非强制提醒分支；现有 hook 已支持，PRD 需明确该状态归 PROPOSAL_STAGE |

### J10 — 完整规划但未实现

| 维度 | 内容 |
|---|---|
| 前置 | 无 change-dir |
| 操作 | proposal → design → tasks → Stop（无代码）|
| Stop 期望 | **无提醒**。规划阶段本身完整 |
| 关键挑战 | 与 J1 仅差"是否有代码"——规划/实现的天然分离点；PRD 需明确该状态为 ALIGNED |

### J11 — 代码改动与 active change-dir 无关（LLM 评审驱动归属）

| 维度 | 内容 |
|---|---|
| 前置 | 项目内 change-dir X 处于 CODE_PENDING_REVIEW；TTL 内 |
| 操作 | 用户让 agent 修另一模块的 bug（与 X 设计上无关）|
| Stop 期望 | hook 注入**结构化评审上下文**让 LLM 自行判断；若 LLM 判定 "unrelated"，则不 edit X 的文档，Stop 接受 |
| 关键挑战 | hook 不能算法判定"无关"；改由 LLM 在 `ATTRIBUTION_REVIEW_RULES` 下评审，hook 观察后续动作记录决定（FR11）|

### J12 — 跨会话 read-only 评审

| 维度 | 内容 |
|---|---|
| 前置 | 项目处于 changes mode |
| 操作 | 用户重开会话 → agent 读 design.md + tasks.md → Stop（无任何编辑）|
| Stop 期望 | **不提醒**；`lastReviewedMs` 应更新到项目级状态，影响后续 drift 判定 |
| 关键挑战 | "只读评审"是独立用户意图；Read 也应满足 review 计数 |

### J13 — 多 change-dir 并存（LLM 评审驱动归属）

| 维度 | 内容 |
|---|---|
| 前置 | 未归档的 X、Y 两个 change-dir 都在 7 天内被编辑过 |
| 操作 | 用户改代码 → Stop |
| Stop 期望 | hook 注入**结构化评审上下文**（含 X、Y 简介），LLM 选择归属 dir 并采取行动（edit 该 dir 的 design/tasks，或声明 unrelated）|
| 关键挑战 | 多 dir 歧义不能靠 activeChangeDir 单值解决；改由 LLM 评审（FR11）|

### J14 — Active TTL 过期后改代码

| 维度 | 内容 |
|---|---|
| 前置 | 项目有 change-dir X，但 `activeUntilMs` 已过 |
| 操作 | 用户改代码 → Stop |
| Stop 期望 | 若 X 是项目内**唯一未归档** dir → 启发式归属 X 并续期 TTL；否则注入 LLM 评审上下文 |
| 关键挑战 | TTL 过期不是"硬切断"；明确"唯一非归档 dir"是降级回路 |

### J15 — 归档过渡

| 维度 | 内容 |
|---|---|
| 前置 | change-dir X 处于 CODE_PENDING_REVIEW |
| 操作 | 用户创建 X 下的 `.archived` 标记文件 / 改 `status.md` 为 archived → Stop |
| Stop 期望 | X 状态机即时转移到 ARCHIVED；drift 清零；后续不再针对 X 提醒（FR12）|
| 关键挑战 | 归档操作的 PostToolUse 即时反映到 ProjectState；不依赖下一次 Stop 才生效 |

### J16 — DTS 修复模式（显式声明）

| 维度 | 内容 |
|---|---|
| 前置 | 项目可能有 change-dir |
| 操作 | 用户 prompt 含 `DTS-1234` 修复 → agent 改代码 → Stop |
| Stop 期望 | **不提醒**（DTS 上下文激活，整轮跳过 SDD 检查）|
| 关键挑战 | 现有 [updateDtsContextFromInput](./sdd-drift-check-hook.js) 已支持；PRD 需作为正式旅程文档化 |

---

## 四、旅程行为总表

| 旅程 | 跨会话？| 主体动作 | 同会话已编辑 SDD？| Stop 期望 |
|---|---|---|---|---|
| J1 | 否 | proposal→design→tasks→code | 是（同会话全套） | 无提醒 |
| J2 | 否 | 同 J1，子代理实现 | 是 | 无提醒 |
| J3 | 否 | J1 完成 → 新一轮纯代码改动 | 是（上一轮）| **提醒** |
| J4 | 是 | 纯代码改动 | 否 | **提醒** |
| J5 | 是 | 只改 tasks.md | 是（仅 tasks） | **提醒：design 落后** |
| J6 | 是 | plan + 子代理改代码 | 否 | **提醒** |
| J7 | 是 | 主动委托子代理改代码 | 否 | **提醒** |
| J8 | 是 | 同 J6，但 agent 准备提问/交接 | 否 | **PreToolUse checkpoint 优先；Stop 兜底提醒** |
| J9 | 否 | 仅 proposal.md | 是（仅 proposal） | stage reminder（非阻塞）|
| J10 | 否 | proposal+design+tasks（无代码）| 是（全套） | 无提醒 |
| J11 | 否/是 | 代码改动与 active dir 无关 | 否 | **LLM 评审注入**，按 LLM 判定 |
| J12 | 是 | 仅 Read 文档 | 否 | 无提醒；`lastReviewedMs` 更新 |
| J13 | 否/是 | 多 active dir + 代码改动 | 否 | **LLM 评审注入**，由 LLM 选择归属 |
| J14 | 是 | activeChangeDir TTL 已过期 + 代码改动 | 否 | 唯一 dir 时启发式归属；否则 LLM 评审 |
| J15 | 否/是 | 标记 change-dir 归档 | 否 | 该 dir 即时转 ARCHIVED；drift 清零 |
| J16 | 否/是 | DTS-xxx 修复 + 代码 | 否 | 整轮跳过 SDD 检查 |

---

## 五、功能需求 (FR)

### FR1 项目级状态持久化

- 在 `<stateDir(cwd)>/project.json` 维护**跨会话**的 change-dir 状态；`stateDir(cwd)` 优先选择 `.git/sdd-drift-hook-state`，避免污染仓库根目录
- 包含每个 change-dir 的：doc 编辑/审阅时间、linked code、归档标志、active 标记
- 由 J4 / J5 / J6 / J7 / J8 共同驱动

### FR2 实现阶段识别（避免 J1/J2 误报）

- 当 SDD 文档（design + tasks）在**本会话**已被编辑，且后续代码编辑紧随其后、未夹杂"回头修改 SDD 的反复"，应识别为"实现阶段"
- 该阶段 Stop 不应产生 code drift 提醒
- 触发条件：把"本会话内的完整流"作为隐式 review 确认

### FR3 完成基线刷新（驱动 J3）

- 每次 Stop 在"无 drift"路径下，应将"当前对齐时序"写入项目级状态作为新基线
- 下一轮的代码编辑若仍未触发 SDD 编辑，相对该基线即为 drift

### FR4 双向 doc-doc drift（驱动 J5）

- design ↔ tasks 互相支持作为 source 检测对方落后
- 跨会话生效：依赖 FR1 持久化 doc.editedMs

### FR5 子代理编辑归属（驱动 J2 / J6 / J7 / J8）

- 子代理通过 `task` / `call_omo_agent` / `delegate_task` 等工具被调起时，其代码改动归属到**父会话的 active change-dir**
- OpenCode native 端利用 checkpoint tool output 与 mtime fallback 进一步加固；legacy bridge 若提供 `parentSessionId`，可作为额外证据
- CC 端保留现有 mtime + 输出文本启发式

### FR6 跨会话 carry-over 提醒（驱动 J4 / J6 / J7 / J8）

- 新会话首事件触发时，从项目级状态恢复 active change-dir 与未消 drift
- 在合适的 hook 输出点注入"carry-over drift"提醒，告知 agent

### FR7 Stop 强制 drift 检测（驱动所有"应提醒"旅程）

- 任何 Stop 事件无条件执行 drift 检测，不依赖代理消息内容
- J8 的"提问 Stop"由此覆盖

### FR8 active change-dir + TTL（代码归属机制）

- 项目级状态维护 `activeChangeDir` 与 `activeUntilMs`
- 默认 TTL 7 天；最近编辑的 change-dir 自动续期
- 代码改动在 TTL 窗口内归属 active；TTL 过期 → 触发"模糊归属"提醒

### FR9 归档目录跳过

- 沿用现有 `isArchivedChangeDir`（[L1216-1249](./sdd-drift-check-hook.js)）
- 项目级状态中的 archived 标记同步影响

### FR10 多 change-dir 并存

- 项目内多个未归档 change-dir 可同时活跃
- drift 检测按 change-dir 独立运行，提醒按 dir 聚合

### FR11 LLM 评审驱动归属（驱动 J11 / J13 / J14）

当代码改动归属不明确时，hook **不算法决定**，而是注入结构化评审上下文交由 LLM 判定。

**触发条件**（满足任一即"归属不明确"）：

1. 项目内有 ≥ 2 个未归档 change-dir，且均在 24 小时内被编辑过
2. `activeChangeDir` 的 TTL 已过期，且项目内 ≥ 2 个未归档 change-dir
3. 当前代码改动路径与 `activeChangeDir` 的历史 `linkedCode` 路径相似度低（启发式：路径前缀不重合）

**注入内容**：

- 最近代码改动列表（限 10 条）
- 候选 change-dir 列表（含 design.md 首行摘要 + 当前 drift 状态）
- 评审规则 1–5（见附录 A `ATTRIBUTION_REVIEW_RULES`）

**Hook 观察后续动作并记录**：

| LLM 后续动作 | 解读 |
|---|---|
| Edit/Write 某 change-dir 的 design.md / tasks.md | 归属到该 dir，drift 解决 |
| Read 某 change-dir 文档但不 edit | 已评审，进入 no-edit 二次 Stop 确认（沿用 [codeReviewConfirmation](./sdd-drift-check-hook.js)）|
| 既不 read 也不 edit，直接 Stop | 首次 Stop 阻断并重发评审；第二次 Stop 接受为"agent 已采纳无关判断" |
| Write `sdd/changes/<new-id>/proposal.md` 或 `design.md` | 选择"建新 change-dir"路径，新 dir 加入 ProjectState |

**不解析 LLM 自然语言响应**——只通过可观测行为信号记录。

### FR12 归档操作即时反映（驱动 J15）

当 PostToolUse 检测到对某 change-dir 的归档动作（创建 `.archived` / `archived.md` / `已归档.md` 标记文件，或写入状态文件含 `status: archived`），立即：

1. ProjectState 中该 dir 的 `archived` 字段置 true
2. 该 dir 的所有 drift 状态清零
3. 若为 `activeChangeDir` → 清空 active；TTL 不重置

**不依赖**下一次 Stop 才生效——PostToolUse 阶段就反映。

### FR13 纯讨论 Stop 静默（驱动衍生场景）

当 Stop 触发时，若本会话**没有任何 Edit / Write / MultiEdit 工具事件**：

1. 不更新 `alignedAtMs`
2. 不刷新完成基线
3. 不发提醒
4. 仅记录 `stop_no_edit_session` 诊断事件

避免讨论/问答类回合误改 SDD 状态机基线。

---

## 六、非功能需求 (NFR)

| 编号 | 内容 |
|---|---|
| NFR1 | Hook 故障**永不**阻塞用户主流程（fail-open 兜底 `process.exit(0)`） |
| NFR2 | 单次 hook 时延 P99 < 500ms（PreCompact / UserPromptSubmit < 300ms） |
| NFR3 | 支持 Claude Code 原生 + OpenCode native plugin 两条主路径；OMO 3.17.2 旧桥接仅 best-effort 兼容，能力差异自动降级 |
| NFR4 | state.json + project.json 大小有界（state.files LRU 1000；project.json change-dir 上限自然取决于项目） |
| NFR5 | 异常隔离（熔断：单 hook 类型连续 5 次失败 → 60s 静默） |
| NFR6 | 所有状态变更与决策有诊断日志可追溯（`.sdd-drift-check.log.jsonl`） |
| NFR7 | 项目级状态文件支持多会话并发（FsLock + 原子写） |

---

## 七、领域模型

### 7.1 数据模型

#### ChangeDir（项目级，持久化）

```typescript
interface ChangeDir {
  relDir: string                     // 相对 cwd，如 "sdd/changes/feature-x"
  archived: boolean

  docs: {
    proposal?: DocRecord
    design?:   DocRecord
    tasks?:    DocRecord
  }

  linkedCode: LinkedCodeRecord[]

  // 完成基线：上一次 Stop 时认定"已对齐"的时序快照
  alignedAt?: string                  // ISO timestamp
  alignedAtMs?: number                // for fast comparison
}

interface DocRecord {
  exists: boolean
  lastEditedMs?: number
  lastReviewedMs?: number             // Read 或 Edit
  lastEditedSession?: string
  lastReviewedSession?: string
}

interface LinkedCodeRecord {
  path: string                        // relative to cwd
  lastEditedMs: number
  lastEditedSession: string
  linkedAt: number                    // 首次归属到该 change-dir 的时刻
}
```

#### ProjectState（`<stateDir(cwd)>/project.json`）

```typescript
interface ProjectState {
  version: 1
  lastUpdatedAt: string
  changeDirs: { [relDir: string]: ChangeDir }

  activeChangeDir?: string
  activeUntilMs?: number              // TTL 过期时间
  activeLastEditedSession?: string
}
```

#### SessionState（`<stateDir(cwd)>/<hash>-<sessionID>.json`）

保留现状（[emptyState:453-471](./sdd-drift-check-hook.js)），增加：

```typescript
interface SessionState {
  // ...现有字段...
  firstEventAt?: string               // 首事件时间，用于检测"新会话"
  transcriptCursor?: number           // byteOffset 增量 hydration
  projectStateSeenAt?: string         // 已感知 project.json 的版本
}
```

### 7.2 状态机（per change-dir）

状态用**正交布尔条件**表达，避免穷举组合：

```
conditions = {
  proposalOnly:        proposal exists 且 design/tasks 缺失
  designAheadOfTasks:  design/tasks 都存在，且 design.lastEditedMs > tasks.lastEditedMs
  tasksAheadOfDesign:  design/tasks 都存在，且 tasks.lastEditedMs > design.lastEditedMs
  codeAheadOfDocs:     max(linkedCode.lastEditedMs)
                       > 任一已存在 design/tasks 的 lastReviewedMs
  archived:            归档标记或归档启发式命中
}
```

`codeAheadOfDocs` 必须逐个已有文档判断，不能用 `max(designReviewed, tasksReviewed)` 折叠；否则只评审一个文档就会掩盖另一个文档未评审。若 `design.md` 或 `tasks.md` 尚不存在，则不把缺失文件作为 code review 目标，也不自动要求创建。

派生**显示状态**：

| 显示状态 | 触发条件 |
|---|---|
| ALIGNED | 所有 condition 均假 |
| PROPOSAL_STAGE | proposalOnly |
| DESIGN_PENDING_TASKS | designAheadOfTasks |
| TASKS_PENDING_DESIGN | tasksAheadOfDesign |
| CODE_PENDING_REVIEW | codeAheadOfDocs |
| MULTI_DRIFT | 多个 condition 为真 |
| ARCHIVED | archived |

### 7.3 代码归属规则

```
when code file C edited at time T:
  active = projectState.activeChangeDir
  if active != null and T < projectState.activeUntilMs:
      attribute C → active
      append/update LinkedCodeRecord on active
      extend activeUntilMs by TTL
  else if session has edited an SDD doc in any change-dir:
      attribute C → that change-dir (latest by editedSeq)
      set activeChangeDir + reset TTL
  else if exactly one non-archived change-dir exists:
      attribute C → that one
      set active + TTL
  else:
      mark C as "unattributed pending code"
      emit "ambiguous attribution" reminder
```

### 7.4 漂移条件计算（per change-dir）

```
codeAheadOfDocs(dir):
  codeEdited = max_or_zero(dir.linkedCode.lastEditedMs)
  reviewTargets = existing(dir.docs.design, dir.docs.tasks)
  return codeEdited > dir.alignedAtMs
      && any(reviewTargets, doc => codeEdited > doc.lastReviewedMs)
```

`alignedAtMs` 是关键——FR3 完成基线刷新后，drift 判断要超过这个基线。

J1 流程结束时的 Stop：alignedAtMs 被刷新为 max(all edits) → next Stop 之前如果代码再被编辑，超过 alignedAtMs → drift。

---

## 八、Hook 集成点

Claude Code command hook 与 OpenCode native plugin 共享概念面：
PostToolUse / Stop / UserPromptSubmit / PreCompact。OpenCode native adapter
会从 `chat.message`、`tool.execute.before`、`tool.execute.after` 与
`session.idle` / idle `session.status` 转换到共享输入形态。`PreToolUse`
作为可选 question checkpoint：仅用于提问/交接类工具；若运行时不支持或
没有命中，则自动降级到 Stop / UserPromptSubmit / carry-over 摘要。

### 8.1 PostToolUse（核心）

- 收到 Edit / Write / MultiEdit / Read 事件 → 更新 SessionState 与 ProjectState
- 若是 task / call_omo_agent / delegate_task / background_output → 走子代理归属路径
- 决定是否在本次工具返回时立即注入"实时"提醒（仅强 drift 场景）
- **归属决策分支**：
  - 清晰归属（J1 / J2 / J3 / J4 / J5 / J6 / J7 / J8）→ activeChangeDir + TTL 算法路径
  - 模糊归属（J11 / J13 / J14 部分）→ 注入 `ATTRIBUTION_REVIEW_RULES` 评审上下文（FR11）
- **归档检测**：若工具事件指向归档标记文件 → 即时更新 ProjectState（FR12）

### 8.2 Stop（最终守门）

强制流程：

1. 增量 hydration（从 transcriptCursor 续读）
2. 重新计算所有 change-dir 的 conditions
3. **判别 J1 / J2 实现阶段**：若本会话有完整 SDD 编辑且代码紧随其后、无反复 → 跳过 code drift；刷新 alignedAtMs
4. 若仍有 drift → 写 `.sdd-drift-report.md` 并 emit 提醒
5. 若无 drift → 更新 alignedAtMs 作为新基线（驱动 FR3）

### 8.2.1 PreToolUse（提问/交接 checkpoint）

- 只拦截 question-like / handoff-like 工具，不拦截普通 Read/Edit/Write
- 在 agent 准备询问用户、提交代码、交接控制权前，检查所有未归档 change-dir 的 pending drift
- 有 pending 时返回 permission deny + additionalContext，要求 agent 先完成 SDD review / sync
- 同一 signature 会话内最多触发一次，避免问题单/无需修改场景反复循环
- 不支持该 hook 的运行时路径，仍由 Stop、UserPromptSubmit 或 carry-over 摘要兜底

### 8.3 UserPromptSubmit（opt-in；driving FR6）

- 检测会话首事件（session state 为空 / firstEventAt 未设置）
- 加载 project.json，识别 active change-dir + 未消 drift
- 把 carry-over drift 摘要注入到 `messages: string[]` 返回给 agent
- 同时把"用户 prompt 文本"提供给 DTS 上下文检测（替代 transcript 反推）

### 8.4 PreCompact（opt-in）

- 压缩前把 `.sdd-drift-report.md` 摘要注入到 `additionalContext`
- 保证压缩后代理仍知未消 drift

---

## 九、边界场景

### 9.1 文档不存在

- 沿用现有 [L1276](./sdd-drift-check-hook.js) 行为：peer 文件不存在 → 跳过 requirement
- 不要为不存在的文件自动 stub

### 9.2 归档目录

- ChangeDir.archived = true → 所有 drift 检测对该 dir 短路
- 归档检测沿用 [isArchivedChangeDir:1236-1249](./sdd-drift-check-hook.js)

### 9.3 多 change-dir 同时活跃

- ProjectState.changeDirs 自然支持多条
- 提醒按 dir 聚合，使用现有 `formatGap` 风格
- activeChangeDir 仍只有一个 → 多 dir 场景下用户需要明确意图，否则按"最新编辑"启发式

### 9.4 mtime 不可信

- git checkout / touch 等会改 mtime
- 缓解：lastEditedSession + lastEditedSession 时间戳作为辅助证据
- 若 mtime 突然异常老（早于 lastEditedAt）→ 用 lastEditedAt 兜底

### 9.5 会话锁竞争

- 项目级 `project.json` 与会话级 state 都需要 FsLock 保护
- 沿用现有 acquireFileLock；超时降级（与现状一致）

### 9.6 DTS 上下文

- 用户 prompt 提及 DTS 问题单 → 跳过 SDD 偏差检测
- 检测一次性完成（UserPromptSubmit 注册后）；未注册时保留现状每 hook 反推

### 9.7 plan 模式

- Claude Code 的 plan 模式不会写入 → 不产生 Edit/Write 事件 → drift 状态不变
- 用户从 plan 切到执行后，task 工具调用照常被 PostToolUse 捕获

### 9.8 OpenCode Stop block 被静默丢弃

- OpenCode native 的 `session.idle` / idle `session.status` 是事件，不是可变 Stop block 输出；Stop continuation 只能 best-effort
- Hook 始终先 `refreshReport` 写 `.sdd-drift-report.md`，保证 continuation 失效时用户仍可见

---

## 十、非目标

| 不做 | 原因 |
|---|---|
| auto-review 集成 | 单独升级，PRD v2 处理 |
| 通用 PreToolUse 阻断 | 已排除。只保留提问/交接 checkpoint，不阻断普通工具调用 |
| 算法/路径推断式代码归属（hook 内决策）| 解析 design.md/tasks.md 找代码引用太脆弱；改由 LLM 在 `ATTRIBUTION_REVIEW_RULES` 下基于语义判定（FR11）|
| LLM 语义理解 Stop 是否提问 | 不可靠；改为 Stop 一律检测 + agent 自决（FR7） |
| 历史 transcript 全量回放 | 性能；用增量 cursor 替代 |
| 强制改 settings.json | UserPromptSubmit / PreCompact 走 opt-in，不强求 |

---

## 十一、验收标准

每旅程的"过 / 不过"信号：

### J1

| 检查项 | 期望 |
|---|---|
| Stop 时 stdout 是否包含 enforcement / advisory | 否（无任何 drift 文本） |
| project.json 内 change-dir 状态 | ALIGNED；alignedAtMs ≈ session 末时刻 |
| 诊断日志事件 | `stop_allow_no_pending` 类 |

### J2

同 J1。另：项目级 LinkedCode 中包含子代理写入的文件路径。

### J3

| 检查项 | 期望 |
|---|---|
| 第二次 Stop 的 stdout | 含 code drift 文本（"changed code file ... pending review"） |
| project.json 内 change-dir 状态 | CODE_PENDING_REVIEW |
| 诊断日志事件 | `stop_block_emit` |

### J4

同 J3。另：UserPromptSubmit（若注册）的 `messages` 含 carry-over drift 摘要。

### J5

| 检查项 | 期望 |
|---|---|
| Stop 时 stdout | "design.md is stale relative to tasks.md" 类文本 |
| change-dir 状态 | TASKS_PENDING_DESIGN |
| 诊断日志 | `emit_peer_enforcement`（sourceFile=tasks.md, required=[design.md]） |

### J6 / J7

同 J4。另：project.json 内 LinkedCode 的 lastEditedSession 字段记录了子代理或父会话 id。

### J8

| 检查项 | 期望 |
|---|---|
| 提问/交接类工具触发 PreToolUse | 有 pending drift 时 deny，并注入 SDD review / sync 提示 |
| PreToolUse 不支持或未命中 | Stop 仍触发检测作为兜底 |
| stdout 内容 | 与 J6 一致，且同一 signature 会话内不重复刷屏 |
| 不依赖自然语言识别"提问"语义 | 是；只识别工具类型/工具名/明确交接动作 |

### J9

| 检查项 | 期望 |
|---|---|
| Stop 时 stdout | 含 stage reminder 文本，不含 enforcement |
| project.json 内 change-dir 状态 | PROPOSAL_STAGE |
| 诊断日志 | `emit_peer_stage_reminder` |

### J10

| 检查项 | 期望 |
|---|---|
| Stop 时 stdout | 无任何 drift 文本 |
| project.json 状态 | ALIGNED |
| 诊断日志 | `stop_allow_no_pending` |

### J11

| 检查项 | 期望 |
|---|---|
| PostToolUse 后 stdout | 含 `ATTRIBUTION_REVIEW_RULES` 评审上下文 |
| LLM 后续动作 | Read 某 dir 文档但不 edit |
| 第一次 Stop | 阻断（block）并重发评审 |
| 第二次 Stop | 接受；project.json 记录 "LLM 判定 unrelated"；`codeReviewConfirmations` 加项 |
| 诊断日志 | `emit_attribution_review` → `codeReviewConfirmed_unrelated` |

### J12

| 检查项 | 期望 |
|---|---|
| Stop 时 stdout | 无任何 drift 文本 |
| project.json | 对应 dir 的 `lastReviewedMs` 更新到 session 内 Read 的时刻 |
| 诊断日志 | `stop_allow_review_done` |

### J13

| 检查项 | 期望 |
|---|---|
| PostToolUse 后 stdout | 含评审上下文，列出所有候选 dir |
| LLM 后续动作 | Edit 某 dir 的 design 或 tasks |
| Stop | 该 dir drift 解决；其他 dir 状态不变 |
| project.json | `activeChangeDir` 更新为 LLM 选中的 dir；TTL 续期 |
| 诊断日志 | `emit_attribution_review` → `peer_or_code_resolved` |

### J14

| 检查项 | 期望 |
|---|---|
| 项目内唯一非归档 dir | 启发式归属，无评审注入；正常 drift 检测 |
| 多 dir 且 TTL 过期 | 走 J13 评审路径 |
| project.json | `activeChangeDir` 续期或更新 |

### J15

| 检查项 | 期望 |
|---|---|
| 归档动作的 PostToolUse | 即时更新 ProjectState；不必等 Stop |
| 该 dir 后续提醒 | 不再触发 |
| project.json | `dir.archived = true`，drift 状态清零 |
| 诊断日志 | `archive_detected` |

### J16

| 检查项 | 期望 |
|---|---|
| UserPromptSubmit 内 prompt | 命中 `DTS_CONTEXT_PATTERNS` |
| 整轮所有 hook 事件 | DTS 上下文激活；跳过 SDD drift 检测 |
| project.json | 无变化（DTS 路径不写 project.json）|
| 诊断日志 | `dts_context_active` |

---

## 十二、与现有实现的差距

按 PRD 要求清点[现有 hook](./sdd-drift-check-hook.js)：

| PRD 需求 | 现状 | 差距 |
|---|---|---|
| FR1 项目级状态 | 仅会话级 `state.json` | **缺**：需新增 `project.json` + 持久化逻辑 |
| FR2 实现阶段识别（J1/J2 不误报） | 当前固定按时序判 drift | **缺**：需新规则—— SDD 文档本会话已编辑 + 紧随其后的代码编辑视为正常实现 |
| FR3 完成基线刷新 | 部分有（codeReviewConfirmations）| **缺**：需在 Stop 无 drift 时自动刷新基线时间戳 |
| FR4 双向 doc-doc drift | [CHANGE_DOC_REQUIREMENTS](./sdd-drift-check-hook.js) 已支持 tasks→design | **跨会话部分缺**：需要 project.json 承载 |
| FR5 子代理归属 | mtime + 文本启发式（[L1593-1791](./sdd-drift-check-hook.js)） | **加固**：OpenCode native 用 checkpoint output 增强；legacy bridge 的 parentSessionId 仅作额外证据；现有启发式保留兜底 |
| FR6 跨会话 carry-over 提醒 | 无 | **缺**：需 UserPromptSubmit handler |
| FR7 Stop 强制检测 / 提问前 checkpoint | 当前 Stop 已检测；PreToolUse question checkpoint 已有初步实现 | **细化**：与 FR2 / FR3 / ProjectState 联动，统一节流与降级规则 |
| FR8 active change-dir + TTL | 无 | **缺**：需 project.json 维护 |
| FR9 归档跳过 | [isArchivedChangeDir](./sdd-drift-check-hook.js) 已有 | **保持** |
| FR10 多 change-dir | 当前已基本支持 | **保持**；与 active 概念结合 |
| FR11 LLM 评审驱动归属 | 现有 `codeReviewConfirmation` 是同一模式的弱化版 | **扩展**：归属信号 + `ATTRIBUTION_REVIEW_RULES` 注入；观察后续动作 |
| FR12 归档即时反映 | 现有 [isArchivedChangeDir](./sdd-drift-check-hook.js) 在每次 collect 时检测 | **加固**：PostToolUse 即时写 project.json，不等 collect |
| FR13 纯讨论 Stop 静默 | 现有 Stop 在 hydrate 后总会跑 collect | **加守门**：本会话无 edit 事件时整段短路 |
| NFR1 永不阻塞 | `process.exit(0)` 兜底 | **保持** |
| NFR2 时延 P99 < 500ms | 长会话 transcript 全量回放有风险 | **改为增量 hydration**（refactor doc R2）|
| NFR3 Claude Code + OpenCode native 兼容 | 已两端支持 | **加固**：双向能力探测；旧 OMO bridge best-effort |
| NFR4 状态有界 | state.files 无上限 | **加 LRU**（refactor R1） |
| NFR5 异常隔离 | 无熔断 | **加熔断**（refactor doc）|
| NFR6 诊断日志 | 已有 | **保持** |
| NFR7 并发锁 | 已用 FsLock | **扩展至 project.json** |

---

## 十三、附录 A：评审规则常量草案

`ATTRIBUTION_REVIEW_RULES` 在代码中以模块顶部常量出现（类比 [DOCUMENT_SYNC_RULES](./sdd-drift-check-hook.js) / [ACTIVE_SDD_ALIGNMENT_RULES](./sdd-drift-check-hook.js)）：

```js
const ATTRIBUTION_REVIEW_RULES = [
  "Rule 1 — Purely mechanical changes (formatting, comment-only edits, test-scaffolding, dependency bumps, lint fixes) do not require any SDD document update. State this conclusion explicitly in your response and continue.",
  "Rule 2 — If the code change implements behavior already described in a candidate change-dir's design.md, AND that change-dir's tasks.md already reflects the implementation, no SDD action is needed.",
  "Rule 3 — If the code change adds, changes, or removes behavior not described in any candidate change-dir's design.md, update the most relevant change-dir's design.md to state the actual implemented behavior. Update tasks.md if a tracked task item is now complete or invalidated.",
  "Rule 4 — If the code change is genuinely unrelated to any active change-dir (e.g., a hotfix, security patch, dependency upgrade, or a different feature), choose one: (a) acknowledge as out-of-SDD scope in your response and continue, or (b) create a new sdd/changes/<id>/ directory with proposal.md if the work is feature-sized and warrants tracking.",
  "Rule 5 — If multiple candidate change-dirs could apply, choose the most specific match based on design.md content and briefly document the reasoning in your response. Do not edit unrelated change-dirs.",
]
```

### 注入文案模板

```js
const ATTRIBUTION_REVIEW_PROMPT = (cwd, gap) => [
  "SDD attribution review needed.",
  "",
  "Recent code changes (this session):",
  ...gap.codeFiles.map((f) => `  - ${rel(cwd, f)} (edited ${gap.codeEditedDelta} events ago)`),
  "",
  "Active SDD change-dirs (within 7-day TTL):",
  ...gap.candidateDirs.map((d) =>
    `  - ${d.relDir} (${d.designSummary}; design.md last edited ${d.designAgeText})`
  ),
  "",
  "Project-level drift state:",
  ...gap.candidateDirs.map((d) => `  - ${d.relDir}: ${d.driftState}`),
  "",
  "Review rules (apply in order):",
  ...ATTRIBUTION_REVIEW_RULES.map((rule, i) => `  ${i + 1}. ${rule.replace(/^Rule \d+ — /, "")}`),
  "",
  "Take the indicated action (edit docs / create new change-dir / acknowledge no SDD action), then continue with the user's request.",
].join("\n")
```

### 项目级补丁机制

允许项目通过 env 注入额外规则：

```
SDD_DRIFT_EXTRA_ATTRIBUTION_RULES_PATH=/path/to/extra-rules.json
```

文件格式：

```json
{
  "rules": [
    "Rule 6 — In this project, changes to packages/sdk/** belong to whichever change-dir lists 'sdk' in its design.md summary."
  ]
}
```

Hook 加载时拼接到 `ATTRIBUTION_REVIEW_RULES` 末尾，不覆盖默认。

### 测试 snapshot 锚点

规则常量与文案模板的字节级 snapshot 测试，确保后续修订不静默改变 LLM 收到的指令。

---

## 下一步

PRD 落地建议路径：

1. **阶段 0**：本 PRD 评审与共识（产品/工程一致）
2. **阶段 1**：依 [design.zh.md](./sdd-drift-check-hook.design.zh.md) 的 P1–P3 落地结构与防御性修复（不依赖 PRD 业务需求）
3. **阶段 2**：实现 FR1 / FR8 / FR12（project.json + active change-dir + TTL + 归档即时反映），无新业务规则，纯持久化扩展
4. **阶段 3**：实现 FR2 / FR3 / FR13（J1 / J2 / J3 / J10 的正确判定 + 纯讨论静默），关键业务变化点
5. **阶段 4**：实现 FR5 加固（OpenCode native checkpoint output / legacy parentSessionId）+ FR6（UserPromptSubmit / chat.message 注入）
6. **阶段 5**：实现 FR11（LLM 评审驱动归属 + `ATTRIBUTION_REVIEW_RULES` 常量 + 注入逻辑），驱动 J11 / J13 / J14
7. **阶段 6**：所有 16 个旅程的 e2e 验收测试

每阶段独立可发布；阶段 2–6 之间存在松依赖（阶段 5 依赖阶段 2 的 project.json 基础设施）。
