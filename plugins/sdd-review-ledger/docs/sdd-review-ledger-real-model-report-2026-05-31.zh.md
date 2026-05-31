# sdd-review-ledger DeepSeek 真实模型 7 步实测报告（单会话 + 跨会话）

## 摘要

本次使用 OpenCode 1.2.27 + `sdd-review-ledger-opencode.js` + DeepSeek 真实模型，跑了两轮贴近实际开发节奏的 7 步交叉场景：

1. 先写 `design.md`
2. 再写 `tasks.md`
3. 根据 `tasks.md` 写代码
4. 多次继续改代码
5. 再改 `design.md`
6. 根据新 `design.md` 再改代码
7. 最后再改 `tasks.md`

两大场景：

- 场景一：7 步全程使用同一个 OpenCode session。
- 场景二：第 1-3 步使用 session A；从第 4 步开始新建 session B，并用 session B 完成第 4-7 步。

结论：

- 7 个阶段全部完成，OpenCode 退出码均为 `0`。
- 最终 `.sdd-review-todo.md` 无待评审项。
- 未发现 `failed to load plugin` / `fn5 is not a function` 等 OpenCode 插件加载错误。
- 跨会话场景下，ledger / todo 状态能延续到新 session；第 4 步新会话仍能看到前 3 步留下的 SDD 审查状态。
- 修正测试脚本后，OpenCode + DeepSeek 没有异常慢；此前慢的主要原因是测试脚本把 OpenCode HOME 放在项目目录内，导致模型搜索项目文件时扫到 `.home/.cache/opencode/node_modules`。
- 当前“每次相关文件编辑都提醒”的策略覆盖充分，但在模型已经进入 SDD 审查、自行修正文档/代码时，提醒偏密。建议后续引入“审查事务降噪”。

## 测试环境

- 日期：2026-05-31
- 平台：Windows / PowerShell
- 项目根目录：`E:\tool\MySkills\MySkills`
- 测试工程：`test/opencode-sdd-drift-e2e`
- OpenCode：本测试工程局部安装的 `opencode@1.2.27`
- 模型提供商：DeepSeek
- 模型：`deepseek/deepseek-chat`
- 插件产物：`plugins/sdd-review-ledger/sdd-review-ledger-opencode.js`
- 规则文件：`plugins/sdd-review-ledger/sdd-review-rules.md`

## 执行命令

场景一：单会话。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-real-sdd-review-ledger-workflow.ps1 -Provider deepseek
```

场景二：第 4 步开始新建会话。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-real-sdd-review-ledger-workflow.ps1 -Provider deepseek -Scenario split-at-04
```

场景一实际工作目录：

```text
E:\tool\MySkills\MySkills\test\opencode-sdd-drift-e2e\.real-workspaces\ledger-workflow-deepseek-66fe6ec429eb4728aeb8268a095a9394
```

场景二实际工作目录：

```text
E:\tool\MySkills\MySkills\test\opencode-sdd-drift-e2e\.real-workspaces\ledger-workflow-deepseek-split-at-04-8b7a327a0bf54115a0b42216b1af5ce6
```

测试脚本同时为 OpenCode 配置了独立 HOME。场景一：

```text
E:\tool\MySkills\MySkills\test\opencode-sdd-drift-e2e\.real-homes\ledger-workflow-deepseek-66fe6ec429eb4728aeb8268a095a9394
```

场景二：

```text
E:\tool\MySkills\MySkills\test\opencode-sdd-drift-e2e\.real-homes\ledger-workflow-deepseek-split-at-04-8b7a327a0bf54115a0b42216b1af5ce6
```

这点很重要：OpenCode HOME 不应放在被测项目目录内，否则模型搜索 `package.json`、`tsconfig.json` 等文件时，可能把 OpenCode 自己的缓存目录扫进上下文。

## 场景一：单会话阶段结果

| 阶段 | 动作 | 退出码 | 注入提醒次数 | 阶段结束 pending | 阶段结束 checked |
| --- | --- | ---: | ---: | ---: | ---: |
| 01-design | 创建 `design.md` | 0 | 0 | 0 | 1 |
| 02-tasks | 根据 design 创建 `tasks.md` | 0 | 1 | 0 | 2 |
| 03-code-from-tasks | 根据 tasks 写代码 | 0 | 7 | 0 | 4 |
| 04-multi-code | 同一轮多次改代码 | 0 | 5 | 0 | 5 |
| 05-design-change | 代码之后再改 `design.md` | 0 | 2 | 0 | 5 |
| 06-code-after-design | 根据新 design 再改代码 | 0 | 2 | 0 | 5 |
| 07-tasks-change | 最后再改 `tasks.md` | 0 | 1 | 0 | 5 |

最终产物包括：

```text
sdd/changes/badge-greeting/design.md
sdd/changes/badge-greeting/tasks.md
src/badgeGreeting.ts
src/badgeFormatter.ts
src/index.ts
.sdd-review-todo.md
```

最终 `.sdd-review-todo.md` 的 `## 待评审` 为空，`## 审计历史` 中保留了最新审计记录。

## 场景二：第 4 步起新会话

会话切换：

```text
01-design ~ 03-code-from-tasks: ses_18145f89dffeP55oC0JkdgxcH5
04-multi-code ~ 07-tasks-change: ses_18144f8faffepoMSVLaDF11wp9
```

阶段结果：

| 阶段 | 动作 | Session | 退出码 | 注入提醒次数 | 阶段结束 pending | 阶段结束 checked | Error Words |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 01-design | 创建 `design.md` | `ses_18145f89dffeP55oC0JkdgxcH5` | 0 | 0 | 0 | 1 | 0 |
| 02-tasks | 根据 design 创建 `tasks.md` | `ses_18145f89dffeP55oC0JkdgxcH5` | 0 | 1 | 0 | 2 | 2 |
| 03-code-from-tasks | 根据 tasks 写代码 | `ses_18145f89dffeP55oC0JkdgxcH5` | 0 | 6 | 0 | 4 | 0 |
| 04-multi-code | 从新 session 开始，多次改代码 | `ses_18144f8faffepoMSVLaDF11wp9` | 0 | 6 | 0 | 5 | 0 |
| 05-design-change | 新 session 中再改 `design.md` | `ses_18144f8faffepoMSVLaDF11wp9` | 0 | 4 | 0 | 5 | 0 |
| 06-code-after-design | 根据新 design 再改代码 | `ses_18144f8faffepoMSVLaDF11wp9` | 0 | 2 | 0 | 5 | 0 |
| 07-tasks-change | 最后再改 `tasks.md` | `ses_18144f8faffepoMSVLaDF11wp9` | 0 | 1 | 0 | 5 | 0 |

最终 `.sdd-review-todo.md` 的 `## 待评审` 同样为空。

场景二验证点：

- 第 4 步没有传入前 3 步的 `--session`，OpenCode 创建了新 session。
- 新 session 下，插件仍然读取同一个仓库的 `.git/sdd-review-ledger-state/ledger.json` 和 `.sdd-review-todo.md`，因此能延续前 3 步的审查状态。
- 第 4-7 步继续触发 SDD review，并能把新 session 中的 pending 清空。
- 第 2 阶段日志出现一次 `The socket connection was closed unexpectedly`，OpenCode 随后自动重试，阶段最终退出码为 `0`。这是 DeepSeek/OpenCode 网络流的瞬时错误，不是插件加载或插件执行错误。
- 未发现 `failed to load plugin`、`fn5 is not a function`、`.home\.cache` 污染项目搜索上下文。

## 每一步发生了什么

### 01-design

模型创建 `sdd/changes/badge-greeting/design.md`。

插件没有主动注入提醒。原因是 ledger 为空且项目刚出现 SDD 文档，插件执行 bootstrap baseline：记录当前文档 hash，避免新项目一启动就把所有已有文件都列为待评审。

### 02-tasks

模型根据 `design.md` 创建 `tasks.md`。

`tasks.md` 是新出现的 SDD 文档 hash，因此触发一次 SDD review。模型读取 design/tasks 后，确认 `tasks.md` 覆盖设计要求，并在 `.sdd-review-todo.md` 中勾选。

### 03-code-from-tasks

模型根据 `tasks.md` 创建代码：

```text
src/badgeGreeting.ts
src/index.ts
```

代码文件首次被纳入 ledger 跟踪，触发 SDD review。模型在审查中发现代码和原文档存在若干不一致，例如：

- 设计文档中的文件名和实际文件名需要对齐。
- 返回值需要包含测试 marker。
- 需要补充 barrel re-export 说明。

于是模型在同一阶段同步修改了 `design.md` / `tasks.md`，并继续勾选新的 `path@hash`。

这一阶段提醒次数较多，原因不是插件循环，而是模型在审查过程中连续编辑了多个被追踪元素。每次编辑产生新 hash，插件都会再次提醒。

### 04-multi-code

模型按要求进行多次代码修改：

- 增加空名称处理：空 `name` 返回 `guest-66fe6ec4`
- 新增 `src/badgeFormatter.ts`
- 修改 `src/badgeGreeting.ts` 使用 formatter helper

模型随后同步更新 `design.md` 和 `tasks.md`，并勾选对应 review todo。

这一阶段也出现多次提醒。行为符合当前“每次相关编辑都提醒”的策略，但体验上偏吵。

### 05-design-change

模型修改 `design.md`，加入 VIP 规则：

```text
level >= 5 时返回值带 [VIP] 前缀
```

这里出现 2 次提醒，原因是有 2 次真实 SDD 文件编辑：

1. 第一次 `edit design.md` 后，`design.md@新hash` 进入待评审，插件提醒。
2. 模型认为 `tasks.md` 也需要同步，于是 `edit tasks.md` 新增 VIP 任务项。此时 `tasks.md@新hash` 也进入待评审，插件再次提醒。

随后模型读取最新 `.sdd-review-todo.md`，把 `design.md@hash` 和 `tasks.md@hash` 都勾选掉。

### 06-code-after-design

模型根据 VIP 设计修改代码：

- `src/badgeFormatter.ts` 增加 `isPremium(level >= 5)`
- `formatBadgeGreeting` 对 premium 用户添加 `[VIP]` 前缀

插件提醒模型审查 code 与 design/tasks 是否一致。模型确认并勾选最新 todo。

### 07-tasks-change

模型最后修改 `tasks.md`，增加一条已完成的 VIP marker 确认项。

`tasks.md@新hash` 触发一次提醒。模型审查后勾选，最终 pending 清空。

## 慢速问题诊断

初次 7 步测试中，第 3 阶段明显变慢。日志显示模型执行了 `glob package.json`，结果扫到了大量路径：

```text
.home/.cache/opencode/node_modules/**/package.json
.home/.bun/install/cache/**/package.json
```

原因是测试脚本把 OpenCode HOME 放在了被测工作目录内部：

```text
<workRoot>\.home
```

这不是典型真实用户项目结构。真实使用中，OpenCode HOME 通常位于用户配置目录，不在项目根内。修正后测试脚本改为：

```text
test/opencode-sdd-drift-e2e/.real-homes/<run-id>
```

重新运行后，7 步在约 4 分钟内完成，没有再出现 `.home/.cache` 污染项目搜索上下文的问题。

## 当前策略评价

当前策略是：

```text
每次 code/design/tasks/proposal 相关编辑后：
  - 重新计算 pending
  - 重写 .sdd-review-todo.md
  - 如果存在 pending，就在工具结果中提醒模型审查
```

优点：

- 覆盖强，不容易漏掉长任务中的后续改动。
- 即使模型在审查中继续改了文档或代码，也会生成新的 `path@hash` 并要求再次确认。
- 对多轮交叉开发有效，最终能收敛到 pending 清空。

缺点：

- 模型已经进入 SDD 审查后，继续修正文档/代码会产生新的 hash，从而再次提醒。
- 在第 03 / 04 阶段这种“边实现、边同步文档、边勾 todo”的过程中，提醒偏密。
- 第 05 阶段的 2 次提醒是合理的，但用户体感上可能会疑惑：明明只是改一次 design，为什么又提醒一次。

## 后续优化建议

建议引入“审查事务降噪”，而不是恢复全局提醒上限：

```text
首次发现 pending -> 注入提醒，并进入 reviewing 状态
reviewing 状态中的 code/design/tasks 编辑 -> 继续刷新 todo，但不重复注入
模型读取最新 todo 并勾选所有当前 path@hash
pending 清空 -> 退出 reviewing 状态
新用户输入 / TTL 到期 / 工具调用次数超阈值 -> 退出 reviewing 状态，允许再次提醒
```

这样可以把第 05 阶段从 2 次提醒压到 1 次，把第 03 / 04 阶段的提醒密度明显降低，同时仍然保证 `.sdd-review-todo.md` 记录最新 pending，不牺牲覆盖率。

## 本地回归

真实模型测试后，运行外层测试工程：

```powershell
npm test
```

结果：通过。

通过项包括：

- `sdd-drift` core / hook / native OpenCode 测试
- `sdd-review-ledger` native OpenCode plugin 测试
- `opencode-turn-checkpoint` 测试
- journey fixture 测试

## 结论

本次实测验证了 `sdd-review-ledger` 在 OpenCode + DeepSeek 下可以完成真实交叉开发流程，并最终清空审查待办。

同时也确认了两个工程判断：

1. OpenCode + DeepSeek 并没有天然异常慢；测试工程不能把 OpenCode HOME/cache 放进项目根。
2. ledger / todo 是仓库级状态，不是 OpenCode session 私有状态；因此从第 4 步开始新建 session 仍能继续审查。
3. 当前“每次相关编辑都提醒”的策略偏保守，适合防漏，但体验上应通过“审查事务降噪”优化。
