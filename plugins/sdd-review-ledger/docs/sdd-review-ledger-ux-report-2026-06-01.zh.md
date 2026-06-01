# sdd-review-ledger 真实使用体验报告（2026-06-01）

> 范围：OpenCode 1.2.27 + `sdd-review-ledger-opencode.js` + DeepSeek 真实模型。
> 本报告关注“用起来是什么感觉”，不是单元测试覆盖率报告。

## 1. 测试背景

本轮使用前面沉淀下来的两个大实战场景，模拟一个需求从 SDD 文档到代码、再回到文档修订的真实过程：

1. 先写 `design.md`。
2. 再写 `tasks.md`。
3. 根据 `tasks.md` 写代码。
4. 多次继续改代码。
5. 再改 `design.md`。
6. 根据新 `design.md` 再改代码。
7. 最后再改 `tasks.md`。

两条链路分别验证：

- **单会话长任务**：7 步全部在同一个 OpenCode session 内完成。
- **跨会话继续任务**：第 1-3 步在 session A；第 4-7 步切到 session B，验证 ledger / todo 能否跨会话延续。

测试工程均创建在 `test/opencode-sdd-drift-e2e/.real-workspaces/` 下，OpenCode HOME 单独放在 `.real-homes/` 下，避免模型扫描项目文件时误扫 OpenCode 缓存。

## 2. 执行结果摘要

### 2.1 单会话链路

工作目录：

```text
test/opencode-sdd-drift-e2e/.real-workspaces/ledger-workflow-deepseek-single-session-e919f1426c9c4deeb8a6690a6eceb55b
```

Session：

```text
ses_17f22ca24ffee929Nc09KFx857
```

| 阶段 | 动作 | 退出码 | 主动提醒次数 | 阶段结束待评审 |
| --- | --- | ---: | ---: | ---: |
| 01-design | 创建 `design.md` | 0 | 0 | 0 |
| 02-tasks | 创建 `tasks.md` | 0 | 1 | 0 |
| 03-code-from-tasks | 根据 tasks 写代码 | 0 | 2 | 0 |
| 04-multi-code | 同一轮多次改代码 | 0 | 3 | 0 |
| 05-design-change | 再改 `design.md` | 0 | 2 | 0 |
| 06-code-after-design | 根据新 design 改代码 | 0 | 1 | 1 |
| 07-tasks-change | 再改 `tasks.md` | 0 | 1 | 0 |

说明：第 6 步出现过一次 DeepSeek `ConnectionRefused`，导致该阶段暂留 1 条待评审；第 7 步恢复后清空。

最终 `.sdd-review-todo.md` 的 `## 待评审` 为空，审计历史保留 5 条已完成记录。

### 2.2 跨会话链路

工作目录：

```text
test/opencode-sdd-drift-e2e/.real-workspaces/ledger-workflow-deepseek-split-at-04-ab80bc6ab06c4e54aafd66d7350e7c5a
```

Session：

```text
01-design ~ 03-code-from-tasks: ses_17f1ed4bdffelnJRitzohWJ6He
04-multi-code ~ 07-tasks-change: ses_17f1de745ffeTlvOBvsF8LfMkA
```

| 阶段 | 动作 | 退出码 | 主动提醒次数 | 阶段结束待评审 |
| --- | --- | ---: | ---: | ---: |
| 01-design | 创建 `design.md` | 0 | 0 | 0 |
| 02-tasks | 创建 `tasks.md` | 0 | 1 | 0 |
| 03-code-from-tasks | 根据 tasks 写代码 | 0 | 3 | 0 |
| 04-multi-code | 新会话内多次改代码 | 0 | 2 | 0 |
| 05-design-change | 新会话内再改 `design.md` | 0 | 1 | 0 |
| 06-code-after-design | 根据新 design 改代码 | 0 | 1 | 0 |
| 07-tasks-change | 再改 `tasks.md` | 0 | 1 | 0 |

最终 `.sdd-review-todo.md` 的 `## 待评审` 为空，说明跨会话后 ledger / todo 状态可继续生效。

## 3. 正向体验

### 3.1 插件能把审查动作拉回任务流

模型改完 SDD 文档或代码后，确实会看到 `[SDD-REVIEW: NEEDS-REVIEW]` 提醒，然后去读 `.sdd-review-todo.md`、读相关文件、给出审查理由，并把对应项从 `[ ]` 改成 `[x]`。

这说明当前方案的主路径成立：工具不替模型判断“是否偏差”，但能稳定把“需要审查的材料”端到模型面前。

### 3.2 跨会话状态是可用的

第 4 步切换到新 session 后，插件仍然能基于 repo 内的 ledger / todo 继续工作。这个体验很重要，因为真实开发中经常不是一个 session 从头写到尾。

### 3.3 没有复现插件级运行时错误

本轮没有看到：

- `failed to load plugin`
- `fn5 is not a function`
- `illegal instruction`

PowerShell 日志中的 `NativeCommandError` 是 `opencode --print-logs` 往 stderr 打日志时被 PowerShell 包装出来的样式，不是插件崩溃。

## 4. 主要体验问题：提醒偏密

本轮最明显的问题不是“没触发”，而是“触发得有点勤”。

尤其是：

- 单会话 `04-multi-code`：3 次主动提醒。
- 跨会话 `03-code-from-tasks`：3 次主动提醒。
- 单会话 `05-design-change`：2 次主动提醒。
- 跨会话 `04-multi-code`：2 次主动提醒。

这些次数不是用户肉眼看到的弹窗次数，而是同一阶段里 hook 向模型工具结果注入 SDD review 提醒的次数。即便用户不一定逐条看到，模型上下文里仍会反复出现，影响体验。

### 4.1 为什么会出现 3 次 / 2 次

当前策略是：

```text
同一个用户 turn 内，如果 pending 路径集合增长，就再次提醒。
```

也就是说，同一轮里模型先写 `src/badgeGreeting.ts`，插件提醒一次；随后又新增或修改 `src/index.ts`、`src/badgeFormatter.ts`，pending 路径集合变大，插件会再次提醒。

这不是无限循环 bug，而是“安全优先”的设计结果：宁愿多提醒，也不静默漏掉新增待评审文件。

### 4.2 为什么这会影响体验

真实开发中，一轮用户请求经常会让 agent 连续写多个文件。比如：

```text
请根据 tasks 实现 badge greeting。
```

模型自然可能会：

1. 写主实现文件。
2. 写 index re-export。
3. 提取 formatter。
4. 跑一次编译。
5. 回头修一个命名或导入。

如果每出现一个新 pending 路径就主动提醒，模型会被频繁拉回 SDD review。功能上没错，但会带来几个副作用：

- 打断模型原本的实现节奏。
- 上下文里重复出现相似审查协议。
- 长任务中更容易消耗 token。
- 遇到模型供应商偶发限流或连接错误时，额外提醒次数会放大失败概率。
- 用户会感觉 agent “刚开始干活就一直自查”，不够顺滑。

## 5. 体验判断

我对这轮数据的判断：

| 次数 | 体验判断 | 说明 |
| ---: | --- | --- |
| 0 | 合理 | 初次创建单个 design 时可以不打扰。 |
| 1 | 理想 | 一轮改动后给一次明确提醒，模型能统一评审。 |
| 2 | 可接受但接近上限 | 如果确实新增了另一类文件，可以接受；但第二次应尽量精简。 |
| 3 | 偏多 | 对普通开发任务来说已经明显影响节奏。 |
| 4+ | 不建议 | 容易变成“边写边被审查牵着走”。 |

所以，本轮报告的核心结论是：

```text
当前实现能跑通，也能跨会话延续；
但默认体验应该从“路径集合增长就提醒”收敛为“每个用户 turn 主动提醒一次，结束点再聚合兜底”。
```

## 6. 建议优化方向

### 6.1 默认每个用户 turn 只主动提醒一次

建议默认策略：

```text
同一个用户 turn：
- 第一次相关文件变更：主动提醒一次。
- 后续更多相关文件变更：继续更新 ledger / todo，但不再主动注入完整提醒。
- turn 结束、idle 或下一轮 prompt：如果仍有 pending，再聚合提醒一次。
```

这样可以保留安全性：

- ledger / todo 仍然记录所有待评审项。
- 文件内容 hash 变化仍然会重新进入待评审。
- 下一轮 prompt 仍能 carry-over。
- 结束点仍能做聚合兜底。

但体验会更像正常开发：

```text
先让 agent 把这一批改完，再统一做 SDD review。
```

### 6.2 后续提醒只发精简体

如果仍保留“pending 路径集合增长就提醒”的安全模式，第二次及之后也不应该再重复完整协议。

建议：

```text
第一次：完整 SDD review 协议。
后续：只提示“还有 N 项待评审，请查看 .sdd-review-todo.md”。
```

这样 2 次提醒还可以接受，3 次也不会太刺耳。

### 6.3 增加可配置模式

建议给用户两个模式：

```text
SDD_REVIEW_REMINDER_MODE=once
SDD_REVIEW_REMINDER_MODE=growth
```

含义：

- `once`：默认模式，体验优先。每个用户 turn 只主动提醒一次，后续靠 ledger / todo + 结束点兜底。
- `growth`：安全优先。只要新增 pending 路径就提醒，适合强审计场景。

默认建议用 `once`。

## 7. 本轮未发现的问题

本轮没有发现以下问题：

- 插件完全不触发。
- 跨会话后 ledger 丢失。
- 待评审无法清空。
- 代码和 SDD 修改互相触发导致无限循环。
- OpenCode 插件加载失败。

但仍需要继续观察：

- 真实长任务中，idle / stop 聚合提醒是否足够稳定。
- 遇到上下文压缩时，模型是否会忘记正在做 SDD review。
- MiniMax 这类遵循性较弱或速度较慢的模型，是否更需要强一点的结束点提醒。

## 8. 结论

这轮体验可以概括成一句话：

```text
sdd-review-ledger 已经能把 SDD 审查可靠带进真实开发流，但默认提醒策略仍偏“审计工具”，需要再往“开发助手”收敛。
```

建议下一步优先做提醒降噪：

1. 默认每个用户 turn 只主动提醒一次。
2. 后续新增 pending 只更新 ledger / todo，必要时发精简提醒。
3. 在 turn 结束 / idle / 下一轮 prompt 做聚合兜底。

这样既不牺牲“不会漏记待评审项”的底线，也能减少模型在实现过程中被反复拉走的感觉。

