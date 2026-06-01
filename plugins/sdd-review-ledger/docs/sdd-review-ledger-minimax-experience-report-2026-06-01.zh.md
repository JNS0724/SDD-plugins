# sdd-review-ledger MiniMax 两轮真实模型体验报告（2026-06-01）

> 范围：OpenCode + `sdd-review-ledger-opencode.js` + MiniMax-M2.7 真实模型。
> 本报告关注模型在真实开发流程里的行为体验，而不是单元测试覆盖率。

> **落地状态（2026-06-01 之后）**：本报告 §8 的建议已实现——T1 提示词硬化（`ACTION_LINE` 最终门槛 +
> `sdd-review-rules.md` 硬门槛，§8.1）、T2 定向兜底（"review 后又改文件留下新 pending"的短提醒；判断采用
> 折中信号：同回合状态差集 / 跨回合一次性 carry，§8.2）。§8.3 的 `pending` 语义说明已并入 `sdd-review-rules.md`。
> 设计见 `sdd-review-ledger-reminder-ux-improvements.zh.md` §12；验证见 `…-verification-checklist.zh.md` §9。

## 1. 测试目标

本次观察 MiniMax 在同一套现实开发流程中的两轮表现：

1. 单会话长任务：7 个阶段全部在同一个 OpenCode session 中完成。
2. 跨会话继续任务：第 1-3 阶段在 session A，第 4-7 阶段切到 session B。

流程模拟一个 SDD 需求从文档到代码、再回到文档修订的真实节奏：

| 阶段 | 动作 |
| --- | --- |
| 01-design | 先生成 `design.md` |
| 02-tasks | 再生成 `tasks.md` |
| 03-code-from-tasks | 根据 `tasks.md` 写代码 |
| 04-multi-code | 多次继续改代码，并同步必要文档 |
| 05-design-change | 再改 `design.md` |
| 06-code-after-design | 根据新 `design.md` 再改代码 |
| 07-tasks-change | 最后再改 `tasks.md` |

## 2. 测试样本

### 2.1 单会话

```text
Provider: minimax
Model: minimax/MiniMax-M2.7
Scenario: single-session
RunId: e39ef543355b4673adaca253b21a7c88
Session: ses_17cd9c1b8ffe6d7SNyX9PToU1Z
WorkRoot:
test/opencode-sdd-drift-e2e/.real-workspaces/ledger-workflow-minimax-single-session-e39ef543355b4673adaca253b21a7c88
```

### 2.2 跨会话

```text
Provider: minimax
Model: minimax/MiniMax-M2.7
Scenario: split-at-04
RunId: 1a30811643b546f18dd6f2637214e146
Session A: ses_17cd662d4ffelmFpEqrxvn0hHP
Session B: ses_17cd50062ffeWG6y1LwR6JmRYG
WorkRoot:
test/opencode-sdd-drift-e2e/.real-workspaces/ledger-workflow-minimax-split-at-04-1a30811643b546f18dd6f2637214e146
```

## 3. 阶段结果

### 3.1 单会话结果

| 阶段 | 提醒次数 | 阶段结束 pending | 已勾选数量 | 结果判断 |
| --- | ---: | ---: | ---: | --- |
| 01-design | 0 | 0 | 1 | 正常，初始 design 被记录并审计 |
| 02-tasks | 0 | 1 | 1 | 文档先行，`tasks.md` 作为 passive pending 留下 |
| 03-code-from-tasks | 1 | 1 | 4 | 有提醒，MiniMax 执行了 review，但又编辑 `tasks.md` 产生新 pending |
| 04-multi-code | 1 | 0 | 5 | 能继续处理上一阶段遗留，并清空待评审 |
| 05-design-change | 0 | 1 | 5 | design-only 变更被记录为 passive pending |
| 06-code-after-design | 1 | 0 | 5 | 代码变更触发提醒，MiniMax 完成对齐审查 |
| 07-tasks-change | 0 | 1 | 5 | tasks-only 变更作为 passive pending 留下 |

单会话最终 `.sdd-review-todo.md` 仍有 1 条待评审：

```text
sdd/changes/badge-greeting/tasks.md@d4cff72b1f7c58f1
```

这是最后一次 `tasks.md` 文档变更产生的 passive pending。它不是无限循环，也不是 hook 失败；但从体验上看，用户可能会问：“为什么它明明刚 review 过，最后还有遗留？”

### 3.2 跨会话结果

| 阶段 | 提醒次数 | 阶段结束 pending | 已勾选数量 | 结果判断 |
| --- | ---: | ---: | ---: | --- |
| 01-design | 0 | 0 | 1 | 正常 |
| 02-tasks | 0 | 1 | 1 | 文档先行，产生 passive pending |
| 03-code-from-tasks | 1 | 0 | 4 | 提醒后完成 review，并清空待评审 |
| 04-multi-code | 1 | 0 | 5 | 新 session 仍能接上 ledger 状态 |
| 05-design-change | 0 | 0 | 5 | 文档变更后没有留下 pending |
| 06-code-after-design | 1 | 0 | 5 | 代码改动后触发 review，完成闭环 |
| 07-tasks-change | 0 | 0 | 5 | tasks-only 变更也完成闭环 |

跨会话最终 `.sdd-review-todo.md` 的待评审区为空，说明 repo 内 ledger/todo 可以跨 OpenCode session 延续，不依赖单个会话内存。

## 4. MiniMax 行为观察

### 4.1 能看到提醒，也愿意执行 review

两轮里，只要插件通过工具结果注入 `[SDD-REVIEW: NEEDS-REVIEW]`，MiniMax 基本都会中断原本的总结动作，转向读取 `.sdd-review-todo.md`，再读取相关 `design.md`、`tasks.md` 和代码文件。

它不是完全忽略提醒的模型。尤其在跨会话第 03、04、06 阶段，它能按要求：

- 读取 ledger。
- 读取关联文档和代码。
- 给出“文档声称什么、代码实现什么、是否一致”的判断。
- 修改 `.sdd-review-todo.md`，把已审查项从 `[ ]` 改成 `[x]`。

这说明当前插件的主路径对 MiniMax 是有效的。

### 4.2 遵循性不如 DeepSeek 稳，容易漏掉“二次读取 ledger”

单会话第 03 阶段是最典型的问题：

1. MiniMax 根据 `tasks.md` 写了 `src/badgeGreeting.ts` 和 `src/index.ts`。
2. 插件提醒 SDD review。
3. MiniMax 读取 `.sdd-review-todo.md`，看到当时有 3 个 pending：

```text
sdd/changes/badge-greeting/tasks.md@67db2f18e946d68d
src/badgeGreeting.ts@d58515c36c35d8ad
src/index.ts@a13c4e0ed523cbb9
```

4. MiniMax 审查后把这 3 个 pending 勾成 `[x]`。
5. 随后它又编辑了 `tasks.md`，把前 4 个 checklist 从 `[ ]` 改为 `[x]`，保留测试项未完成。
6. 这次编辑让 `tasks.md` 产生了新 hash：

```text
sdd/changes/badge-greeting/tasks.md@0ba1213fb36930f1
```

7. MiniMax 没有按提示再次读取 `.sdd-review-todo.md`，所以新 hash 留成 pending。

结论：这不是“没有触发提醒”，而是“模型在完成第一轮 review 后，又制造了新的待评审对象，但没有执行第二轮 ledger 闭环”。

### 4.3 跨会话轮反而表现更好

跨会话第 04 阶段里，MiniMax 明确意识到了“编辑文档后会产生新 hash，需要再次读取 todo”。日志里能看到它的思路接近：

```text
The newly created/edited design.md and tasks.md now have new path@hashes.
I need to read the todo again and mark the new path@hashes.
```

这一轮最终 pending 为 0。也就是说，MiniMax 并不是完全没有能力完成二次闭环，只是稳定性不够。它有时能做到，有时会提前收尾。

### 4.4 对“未做测试”比较谨慎

两轮里 MiniMax 都没有擅自把测试项当成完成：

- 单会话最终 `tasks.md` 保留 `Write unit tests for basic cases` 未勾选。
- 跨会话最终 `tasks.md` 也保留 `Add unit tests for the function` 未勾选。

这个行为是正向的。它没有为了清空 checklist 而伪造完成状态。

### 4.5 会主动同步文档，但有时同步粒度偏积极

在第 04、06 阶段，MiniMax 会主动把代码变化补写到 `design.md` 或 `tasks.md`：

- 新增 empty-name fallback 后，它补充了设计说明和任务项。
- 新增 VIP prefix 后，它补充了设计说明和任务项。

这符合“归档前 SDD 与代码对齐”的原则。但体验上也意味着：MiniMax 会比较积极地把实现细节写回文档。对于真实项目，提示词需要继续强调“不新增模板外章节、不改文档结构，只在已有位置补充必要事实”，否则文档可能越改越厚。

## 5. 两轮差异

| 维度 | 单会话 | 跨会话 | 判断 |
| --- | --- | --- | --- |
| 代码变更提醒 | 03、04、06 各 1 次 | 03、04、06 各 1 次 | 触发点一致 |
| doc-only 变更 | 02、05、07 多为 passive pending | 02 有 pending，后续能清空 | 设计符合预期，但模型处理差异明显 |
| 第 03 阶段 | 提醒后仍遗留 1 个新 tasks hash | 提醒后 pending 为 0 | MiniMax 单会话漏了二次闭环 |
| 跨会话延续 | 不涉及 | 成功 | ledger/todo 机制有效 |
| 最终状态 | pending 1 | pending 0 | 跨会话结果更干净 |
| API / 插件错误 | 0 | 0 | 未发现运行时错误 |

## 6. 体验问题

### 6.1 “提醒后仍 pending”容易让用户困惑

单会话第 03 阶段的体验比较微妙：用户会看到模型确实进行了 SDD review，也说完成了，但 ledger 里仍有 pending。

根因是模型 review 之后又改了文档。插件没有错，模型也不是完全没听话，但结果确实会让人觉得“不闭环”。

这类问题在 MiniMax 上比 DeepSeek 更容易出现，说明 MiniMax 对长指令里的后置规则遵循不够稳定。

### 6.2 passive pending 的语义需要对用户讲清楚

当前策略里，单纯修改 `design.md` 或 `tasks.md` 可能只记录 pending，不立刻强提醒。这样可以避免用户在头脑风暴、写计划时被强行打断。

但副作用是：用户会在 `.sdd-review-todo.md` 里看到遗留项。这个遗留不一定代表代码错了，可能只是“文档变更待未来代码或人工确认”。

### 6.3 MiniMax 会把用户请求范围放在 checklist 之前

单会话第 03 阶段，MiniMax 认为“用户只要求创建代码文件，所以测试项可以保持未完成”。这个判断合理，但也说明如果用户希望“按 tasks 完成所有项”，提示词需要说得更直：

```text
如果 tasks.md 中存在未完成项，除非用户明确排除，否则应继续完成或说明为什么暂不完成。
```

## 7. 当前结论

MiniMax 真实模型验证结果可以概括为：

```text
插件能触发，MiniMax 能执行，跨会话状态能延续；
但 MiniMax 对“review 中又改文件后必须再次读取 ledger”的遵循不稳定。
```

这不是阻断级 bug，但属于真实使用体验问题。尤其在长任务里，MiniMax 容易出现：

- 已经 review 过旧 hash。
- 又修改了 `design.md` 或 `tasks.md`。
- 新 hash 留在 pending。
- 最终回复里说任务完成。

## 8. 建议优化

### 8.1 提示词继续压缩并突出最终门槛

建议把“二次读取 ledger”规则从长段落里提到更显眼的位置：

```text
最终回复前必须检查：
1. 如果本次 review 期间编辑过 code/design/tasks，立即重新读取 .sdd-review-todo.md。
2. 新出现的 path@hash 也必须完成 review 并勾选。
3. 待评审区不为空时，不要说 SDD review 已完成；应说明仍有哪些项待人工确认。
```

MiniMax 对长提示的后半段更容易漏，短而硬的最终门槛会更有效。

### 8.2 对 MiniMax 保留一次轻量兜底提醒

可以考虑只在一种场景下增加轻量兜底：

```text
本轮已经触发过 active review；
模型随后又编辑了 code/design/tasks；
阶段结束前仍有新 pending。
```

此时不要再注入完整 SDD 协议，只注入一句短提醒：

```text
你刚刚在 review 后又修改了文件，.sdd-review-todo.md 出现了新的 path@hash。最终回复前请重新读取并处理。
```

这样不会回到“频繁打断”的老问题，但能针对 MiniMax 最容易漏的地方补一刀。

### 8.3 文档里明确 pending 的含义

用户文档需要说明：

- `pending` 不等于一定有 bug。
- `pending` 表示“这个版本的文件 hash 还没有被模型或人确认过”。
- doc-only pending 可能是有意保留，用于等待后续代码实现或人工确认。
- 如果模型说“已完成”但 pending 不为空，应优先检查是不是 review 后又改了文档。

## 9. 结论

这两轮 MiniMax 的结果整体可用，但不是“全自动完全可靠”。更准确的产品判断是：

```text
sdd-review-ledger 对 MiniMax 能起到有效提醒和审计作用；
它能把模型拉回 SDD review 流程；
但 MiniMax 需要更强的最终闭环提示，尤其是 review 后再次编辑文件的场景。
```

从使用体验上，MiniMax 适合“有 ledger 兜底、允许少量人工确认”的工作流；如果目标是尽量自动清空待评审，DeepSeek 目前表现更稳。
