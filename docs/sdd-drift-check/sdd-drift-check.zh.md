# SDD Drift Check 中文版

`sdd-drift-check` 是一个兼容 OpenCode 和 Claude Code 的 SDD 偏差检查 hook。
它会在 agent 修改代码或 SDD 文档时，提醒模型同步相关的 `proposal.md`、`design.md`
和 `tasks.md`。

## 当前状态

Claude Code 使用 command-hook 发布件，OpenCode 使用原生插件适配器。两个运行入口共用同一套 drift 规则、状态文件、报告和诊断日志。

在 OpenCode 原生插件中，Stop continuation 只能算 best effort，因为它发生在 `session.idle` 之后；更可靠的模型可见路径仍然是 `tool.execute.after`。

## 运行环境

本包有两个入口文件：

- `sdd-drift-check-hook.js`：Claude Code 兼容 command hook。用于 Claude Code hook 配置。
- `sdd-drift-check-opencode.js`：OpenCode 原生插件适配器。用于 OpenCode 从 `.opencode/plugins/` 直接加载。
- `sdd-drift-check-rules.md`：可选运行时提示词规则文件。用户想自定义 SDD review 原则时，把它放到已安装 JS 文件同目录。

两个入口共用 drift 规则、状态文件、报告和诊断日志。OpenCode 原生适配器和 Claude command hook 是刻意分开的：Claude 使用 `sdd-drift-check-hook.js`，纯 OpenCode 使用自包含的 `sdd-drift-check-opencode.js`。两个发布件来自同一批源码模块，但用户不需要同时安装另一个运行时的 JS 文件。

OpenCode 原生适配器监听这些事件：

- `chat.message`
- `tool.execute.before`
- `tool.execute.after`
- `session.idle`
- OpenCode 的 `session.status` idle 事件

它会捕获用户消息上下文，用于问题单/DTS 检测；在 `tool.execute.before` 缓存工具参数；把工具和 idle 事件转换成共享 hook 输入结构；在发现 drift 时，把模型可见提醒追加到工具结果里。类似“提问/确认/交接”的工具会在 `tool.execute.before` 阶段检查，因此 agent 准备问“要不要提交代码？”之前，也可能被拉回去先完成 SDD checkpoint。

OpenCode 注意事项：`session.idle` / idle `session.status` 是事件，不是可变 Stop hook 响应。原生适配器可以刷新报告和日志；当共享 Stop hook 返回 `inject_prompt` 时，也会 best effort 调用 `session.prompt` 尝试继续。但当前 OpenCode plugin hook 仍没有真正的 Stop-continuation 输出通道。想要 OpenCode 里稳定继续，请保持 `tool.execute.after` 启用。

真实测试显示，在 OpenCode 1.2.27 的 `opencode run` 场景里，Stop-only 不能稳定触发后续继续。Stop 输出可能出现在 assistant 已经结束之后，不会再启动下一轮模型调用。因此当前 OpenCode 可靠级联仍依赖原生插件的 `tool.execute.after`。Stop 保留为有边界的 best-effort continuation，以及最终报告/日志 checkpoint。如果你完全不希望 OpenCode Stop 尝试继续，可以设置：

```powershell
$env:SDD_DRIFT_OPENCODE_STOP_MODE = "report-only"
```

Claude command hook 不使用 `console.error` 或 `messages.transform`。OpenCode 原生适配器只会在 Stop 路径解析到结构化 `inject_prompt` 后 best effort 使用 `session.prompt`；普通模型可见提醒仍然通过工具结果传递。

## 模型可见提示词形态

所有 SDD 提示都使用统一结构：

```text
<system-reminder>
[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - <TYPE>]

STATE
...

REQUIRED ACTION
...

SDD EDIT RULES / ALIGNMENT RULES / EXIT CRITERIA
...
</system-reminder>
```

这是模型可见的 directive 文本，不是隐藏 system-role 覆写。hook 仍然依赖运行时提供的传输通道：Claude Code 接收 command-hook 输出，OpenCode 原生插件接收工具结果提醒和 best-effort Stop continuation prompt。

当前提示类型：

| 类型 | 何时出现 |
| --- | --- |
| `CODE REVIEW NOTICE` | 实现代码变更后的第一条弱提醒，告诉模型继续完成当前工作，但最终回复前要 review SDD |
| `CODE REVIEW CHECKPOINT` / `CODE REVIEW REMINDER` | 阶段末代码 review 要求，目标是活跃 `design.md` / `tasks.md` |
| `PEER SYNC CHECKPOINT` / `PEER SYNC REMINDER` | SDD 文档编辑后，已有的 `design.md` 和 `tasks.md` peer 不同步 |
| `PROPOSAL STAGE REMINDER` | `proposal.md` 变化，且 `design.md` 已经存在 |
| `QUESTION CHECKPOINT` | 提问、确认或交接工具即将把控制权交回用户，但 SDD review 还没完成 |
| `STOP ENFORCEMENT` | Claude-compatible Stop 路径发现还有未解决的 SDD 工作 |
| `COMPACTION CHECKPOINT RECOVERY` / `COMPACTION DRIFT SUMMARY` | `PreCompact` 在上下文压缩前保存 pending SDD 状态 |
| `CARRY-OVER DRIFT` | 新会话看到来自旧会话的项目级 unresolved drift |
| `ATTRIBUTION REVIEW` | 多个活跃 change 目录都可能归属同一个代码改动 |

这些 section 布局属于测试过的提示词契约。尤其是，SDD 编辑必须保留已有标题和模板，修改最接近的过期段落或任务项，不能为了满足 hook 乱加新章节；完成 SDD checkpoint 后，要回到用户原始任务。

## 自定义提示词规则

review 原则会从 `sdd-drift-check-rules.md` 动态加载。查找顺序：

1. 如果设置了 `SDD_DRIFT_RULES_FILE`，优先使用它。
2. 使用运行中 JS 发布件同目录的 `sdd-drift-check-rules.md`。
3. 如果没有规则文件，或某个 section 为空，使用内置默认规则。

支持的 section 标题：

- `## SDD 编辑规则` (`## SDD EDIT RULES`)
- `## 活跃 SDD 对齐规则` (`## Active SDD Alignment Rules`)
- `## 归属评审规则` (`## Attribution Review Rules`)
- `## 子代理评审规则` (`## Subagent Review Rule`)
- `## 退出标准` (`## Exit Criteria`)

用户只需要修改这些标题下的 bullet，就可以调整后续注入给模型的原则。插件每次构建提示词时都会重新读取规则文件，因此修改 `sdd-drift-check-rules.md` 不需要重新构建，也不需要重启正在运行的 OpenCode 会话。已经注入给模型的旧提示词不会被撤回，新规则从下一次 hook 提醒开始生效。

## 行为概览

| 场景 | 行为 |
| --- | --- |
| 项目没有 `sdd/` 或 `.sdd/` 目录 | hook 静默退出，不写状态、不写报告、不提醒模型 |
| 修改 `design.md`，同目录 `tasks.md` 已存在但未同步 | 要求同步 `tasks.md` |
| 修改 `tasks.md`，同目录 `design.md` 已存在但未同步 | 要求同步 `design.md` |
| 修改 `proposal.md` | 只有当 `design.md` 已存在时，发出软性的下一阶段提醒 |
| peer 文件不存在 | 视为后续 SDD 阶段，不强制级联创建 |
| peer 文件存在但本会话未同步 | 报告为 unsynced，要求模型读取并更新它 |
| peer 文件稍后在同一会话同步 | 清除 gap，不制造反向 ping-pong |
| 普通代码变更后没有 SDD review | 延迟提醒模型在最终回复前 review 相关 `design.md` 和 `tasks.md` |
| 一轮改很多代码文件 | 聚合代码改动，发出有边界的紧凑提醒，直到最新代码批次 review 过 `design.md` 和 `tasks.md` |
| 新会话开始时存在旧会话 unresolved drift | 从 `project.json` 恢复 project-level carry-over drift，并可能通过 `UserPromptSubmit` / `PreCompact` / `Stop` 注入紧凑提醒 |
| DTS / 问题单上下文 | 跳过代码领先文档 review 提醒；Claude Code 通过 `UserPromptSubmit` 捕获上下文，OpenCode 通过 `chat.message` 捕获上下文，也可用 `SDD_DRIFT_DTS_CONTEXT=1` 强制声明 |
| 代码只影响任务进度 | 在 `design.md` 和 `tasks.md` 都 review 后，允许只更新 tasks，或不编辑文档 |
| 模型忽略约束并停止 | 写 `.sdd-drift-report.md`，供人工后续确认 |

## Project 状态与状态机

`project.json` 是跨会话长期状态文件，和 session state 文件写在同一个状态目录下：

```text
<nearest .git>/sdd-drift-hook-state/project.json
```

如果 Git 状态目录不可用，会使用和其他 hook state 相同的兜底路径：
`<cwd>/.sdd-drift-hook-state/project.json`，再兜底到
`%TEMP%/sdd-drift-check/<repo-hash>/project.json`。

这个文件归插件实现管理。它适合用来定位问题和做人工评审，但通常不建议用户手工修改。时间字段是内部比较时钟，不是公开 API。文档/代码编辑时间会使用由文件 mtime 和 hook 事件时间共同推导出的单调数值；`activeUntilMs` 是普通的 epoch 毫秒 TTL 截止时间。

详细版见 [project-state-and-state-machine.zh.md](./project-state-and-state-machine.zh.md)。

### 顶层字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | number | Project state schema 版本。当前值为 `1`。 |
| `lastUpdatedAt` | string | project state 重新计算并保存时写入的 ISO 时间。 |
| `changeDirs` | object | 从相对 change 目录到 `ChangeDir` 记录的映射，例如 `sdd/changes/demo`。 |
| `activeChangeDir` | string or null | 后续代码改动的当前最佳归属目标。会在本会话编辑 SDD 文档，或代码归属明确落到某个 change 目录时更新。 |
| `activeUntilMs` | number | `activeChangeDir` 的过期时间，单位是 epoch milliseconds。默认 TTL 由 `SDD_DRIFT_ACTIVE_TTL_MS` 控制，默认 7 天。 |
| `activeLastEditedSession` | string or null | 最近刷新 `activeChangeDir` 的 session id。 |

### `ChangeDir` 字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `relDir` | string | 相对项目根目录的 change 目录路径。 |
| `archived` | boolean | 该 change 目录是否已通过目录名、标记文件或状态文件识别为归档。已归档目录不会产生 drift 提醒。 |
| `docs` | object | `proposal`、`design`、`tasks` 三类文档的记录。 |
| `linkedCode` | array | 被归属到该 change 目录的代码文件。用于跨会话判断“代码领先于文档”的项目级 review。 |
| `docSyncs` | object | 跨会话文档同步证据，用于避免 `design.md -> tasks.md -> design.md` 往返 ping-pong。 |
| `alignedAt` | string or null | 最近一次完成实现流基线刷新时的 ISO 时间。 |
| `alignedAtMs` | number | 内部数值基线。后续被归属的代码编辑时间必须大于这个值，才可能产生项目级 code drift。 |
| `state` | string | 该 change 目录的派生状态。每次加载/保存都会重新计算。 |
| `conditions` | object | 用来计算 `state` 的派生布尔条件。它是诊断数据，不是独立事实来源。 |

旧版本 `project.json` 如果包含 `peerSyncs`，读取时会迁移为 `docSyncs`；新版本保存时不会再持久化 `peerSyncs`。

### `docs` 记录

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `exists` | boolean | 当前磁盘上是否存在该文档。 |
| `lastEditedMs` | number | 最近一次观察到该文档被 Edit/Write/MultiEdit 的内部时钟。 |
| `lastReviewedMs` | number | 最近一次观察到该文档被 Read 或 Edit/Write/MultiEdit 的内部时钟。编辑也视为 review。 |
| `lastEditedSession` | string | 最近编辑该文档的 session id。 |
| `lastReviewedSession` | string | 最近读取或编辑该文档的 session id。 |

`proposal.md` 是阶段标记。只有当 `design.md` 已存在时，它才可能产生软性的下一阶段提醒。它本身不会直接要求创建或同步 `tasks.md`。

### `linkedCode` 记录

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `path` | string | 相对项目根目录的代码路径。 |
| `lastEditedMs` | number | 最近一次观察到该代码文件被编辑的内部时钟。 |
| `lastEditedSession` | string | 最近编辑该代码文件的 session id。 |
| `linkedAt` | number | 该文件首次被归属到这个 change 目录时的内部时钟。 |

已有条目会原地更新。新增条目会按最近编辑时间排序，并受 `SDD_DRIFT_PROJECT_LINKED_CODE_CAP` 限制，默认最多保留 `200` 条。

### `docSyncs` 记录

`docSyncs` 以目标文档 key 作为键，目前可能是 `design` 或 `tasks`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `sourceFile` | string | 触发同步的源 SDD 文件，只能是 `design.md` 或 `tasks.md`。 |
| `sourceEditedMs` | number | 需要被同步的源文件编辑内部时钟。 |
| `targetEditedMs` | number | 满足同步要求的目标文件编辑内部时钟。 |

示例：

```json
{
  "docSyncs": {
    "tasks": {
      "sourceFile": "design.md",
      "sourceEditedMs": 2000,
      "targetEditedMs": 3000
    }
  }
}
```

这表示插件观察到 `tasks.md` 是为了响应某次 `design.md` 编辑而更新的。除非后续出现新的独立源文件编辑，否则下一次 `tasks.md` 编辑不应该立刻反向强制同步 `design.md`。

### 派生 `conditions`

| 字段 | 含义 |
| --- | --- |
| `proposalOnly` | `proposal.md` 存在，但 `design.md` 和 `tasks.md` 都不存在。 |
| `designAheadOfTasks` | `design.md` 和 `tasks.md` 都存在；`design.md` 有已知 session 编辑，且比 `tasks.md` 新；同时 `design.md` 不是刚刚为了同步 `tasks.md` 而更新的响应文档。 |
| `tasksAheadOfDesign` | `tasks.md` 和 `design.md` 都存在；`tasks.md` 有已知 session 编辑，且比 `design.md` 新；同时 `tasks.md` 不是刚刚为了同步 `design.md` 而更新的响应文档。 |
| `codeAheadOfDocs` | 最新归属代码编辑时间大于 `alignedAtMs`，并且至少一个现有 review 目标没有在该代码编辑后被 review。 |
| `codePendingDocs` | 对最新 linked code 编辑仍需 review 的现有文档列表，目前可能包含 `design.md` 和/或 `tasks.md`。 |

### ChangeDir 状态

| 状态 | 何时计算为该状态 | 预期行为 |
| --- | --- | --- |
| `ARCHIVED` | `archived` 为 true | 完全跳过该 change 目录。 |
| `PROPOSAL_STAGE` | `proposalOnly` 为 true | 允许继续提案/设计头脑风暴，不强制同步 tasks；不会被视为 carry-over drift。 |
| `ALIGNED` | 没有任何 drift 条件为 true | 没有项目级 SDD 待处理事项。 |
| `MULTI_DRIFT` | 多个硬 drift 条件同时为 true | carry-over/checkpoint 提醒会汇总该目录，模型需要解决所有列出的原因。 |
| `DESIGN_PENDING_TASKS` | 只有 `designAheadOfTasks` 为 true | `tasks.md` 需要 review/更新，以匹配 `design.md`。 |
| `TASKS_PENDING_DESIGN` | 只有 `tasksAheadOfDesign` 为 true | `design.md` 需要 review/更新，以匹配 `tasks.md`。 |
| `CODE_PENDING_REVIEW` | 只有 `codeAheadOfDocs` 为 true | 现有活跃 `design.md` / `tasks.md` 需要 review；只有代码事实改变了文档内容时才更新。 |

`collectCarryOverDrift()` 会把所有未归档、且不是 `ALIGNED` / `PROPOSAL_STAGE` 的状态视为跨会话 drift。

### 状态机流转

状态机不是根据模型口头声明推进的，而是根据插件观察到的文件事件反复重新计算：

1. **加载 / 发现**：加载 session state 和 `project.json`，发现 `sdd/changes/*` 与 `.sdd/changes/*`，并用文件系统补齐缺失的 `ChangeDir`。
2. **读取 SDD 文档**：更新 `lastReviewedMs` / `lastReviewedSession`，可以清除 code-review pending，不会更新 `lastEditedMs`。
3. **编辑 SDD 文档**：更新 edited/reviewed 字段；必要时产生 `DESIGN_PENDING_TASKS` 或 `TASKS_PENDING_DESIGN`；若是响应 peer requirement，会写入 `docSyncs` 防 ping-pong。
4. **代码编辑归属**：根据 session 证据、active TTL、路径相似度、唯一候选或归属评审，把代码归属到 change 目录并写入 `linkedCode`。
5. **实现流基线刷新**：同一 session 先改 SDD、后改代码，且所有 review 目标都在最新代码编辑前被编辑过时，推进 `alignedAtMs` / `alignedAt`。
6. **无文档修改的 review 确认**：代码改了，文档 review 过，但模型判断无需改文档时，记录 review-confirmation 标记，并允许后续清除 `codePendingDocs`。
7. **提问 / 交接 checkpoint**：agent 准备向用户提问或交还控制权前，检查 unresolved peer/code drift。
8. **PreCompact checkpoint**：上下文压缩前，把 pending checkpoint 和 carry-over drift 写入压缩摘要。
9. **Stop / idle checkpoint**：Claude-compatible Stop 可阻断或请求继续；OpenCode idle 只做 best effort continuation，并刷新报告/日志。
10. **归档**：识别为归档后，`archived` 变为 true，`state` 变为 `ARCHIVED`；如果该目录是 active 目录，会清空 active 记录。

一句话概括：`project.json` 记住跨会话的项目事实；session state 记住当前会话发生了什么；每个 hook 事件都会把 session 合并进 project，重新计算 `conditions`，派生 `state`，然后决定是发出模型可见 checkpoint、保持静默，还是写入人工可读报告。

## 安装到项目

### OpenCode 原生插件

只给当前项目启用：

```powershell
New-Item -ItemType Directory -Force .opencode\plugins
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-opencode.js .opencode\plugins\sdd-drift-check-opencode.js
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-rules.md .opencode\plugins\sdd-drift-check-rules.md
```

全局安装到所有 OpenCode 项目：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-opencode.js "$env:USERPROFILE\.config\opencode\plugins\sdd-drift-check-opencode.js" -Force
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-rules.md "$env:USERPROFILE\.config\opencode\plugins\sdd-drift-check-rules.md" -Force
```

OpenCode 会自动加载 `.opencode/plugins/` 和 `~/.config/opencode/plugins/` 下的本地插件。在 Windows 上，全局路径通常是 `C:\Users\<user>\.config\opencode\plugins\`。

`sdd-drift-check-opencode.js` 是自包含文件，不要再把 `sdd-drift-check-hook.js` 复制到 `.opencode/plugins/`。请把 `sdd-drift-check-rules.md` 放在已安装 JS 文件同目录，插件每次构建提醒提示词时都会重新读取它。

### Claude Code 或 Claude-compatible hook 配置

Claude Code 最小 Stop-only 配置如下。它会捕获 `UserPromptSubmit` 上下文，但不启用 `PostToolUse`：

```powershell
New-Item -ItemType Directory -Force .claude\hooks\sdd-drift-check
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .claude\hooks\sdd-drift-check\sdd-drift-check-hook.js
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-rules.md .claude\hooks\sdd-drift-check\sdd-drift-check-rules.md
```

`.claude/settings.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ]
  }
}
```

真实项目安装后，可以这样检查 hook 是否被调用：

```powershell
Get-ChildItem -Force .git\sdd-drift-hook-state
Get-Content .git\sdd-drift-hook-state\sdd-drift-check.log.jsonl -Tail 20
```

如果项目没有 `.git` 目录，检查兜底位置：

```powershell
Get-ChildItem -Force .sdd-drift-hook-state
Get-ChildItem -Force "$env:TEMP\sdd-drift-check"
```

常见诊断事件：

- `hook_start`
- `user_prompt_context_captured`
- `posttooluse_no_output`
- `emit_subagent_checkpoint_enforcement`
- `stop_allow_no_pending`

如果 OpenCode 或 Claude Code 对话后完全没有新日志，通常说明插件没有被加载，或 command-hook 路径配置错误。

## 使用时会看到什么

SDD review 是当前用户任务里的 checkpoint，不是任务终点。完成 SDD review 或同步后，模型应该回到原始用户任务继续工作，而不是把 SDD 审查当成最终答案。

代码领先文档的 drift 默认按 session 聚合。实现代码在 `PostToolUse` 期间被记录，hook 默认每个 session 最多发出一次弱 code-review 提醒。后续代码改动通常只更新状态，等 Stop、提问或压缩 checkpoint 再统一 review。

review 目标是所有未归档的根级 `sdd/changes/*` 和 `.sdd/changes/*` 下已经存在的 `design.md` 与 `tasks.md`。这能覆盖多个方案同时进行的场景，而不是只看当前回合碰到的 change 目录。

活跃 SDD 文件是规划记录，不是可选注释。归档前，`design.md` 和 `tasks.md` 应与代码事实对齐。行为、API/契约、算法、状态/数据流、数据结构、性能策略、错误处理、安全边界、用户可见结果、实现限制变化，通常都属于 design-impacting change。任务完成、取消、拆分或失效时，`tasks.md` 也应同步。

纯格式化、纯注释、测试脚手架、无设计影响的配置/依赖变化，可以不修改 SDD，但模型仍应先 review 相关文档，并在最终回复里说明 review 了哪些文件、为什么无需改动。

前端入口文件也算代码，包括 `html`、`css`、JavaScript、TypeScript、框架文件和常见后端源码扩展。因此单文件浏览器原型如 `index.html` 也会触发 code-ahead-of-doc review checkpoint。

## DTS / 问题单例外

DTS / 问题单修复被视为运维例外，可以跳过代码领先文档 review。由于不能可靠地从文件路径识别问题单，hook 只会在 hook 可见上下文里出现这些标记时跳过：

- `DTS`
- `issue ticket`
- `bug fix`
- `问题单修改`

也可以手工为本次运行设置：

```powershell
$env:SDD_DRIFT_DTS_CONTEXT = "1"
```

关闭 DTS 例外：

```powershell
$env:SDD_DRIFT_DTS_SKIP = "0"
```

这个例外不会关闭显式 SDD 文档编辑后的 peer synchronization。

## 批次清除规则

代码 review 批次会在下面任一条件满足时清除：

- 每个活跃 `sdd/changes/*/{design.md,tasks.md}` review 目标都在最新代码变更后被 review，且至少一个被 review 的 SDD 文档确实被编辑；剩余 design/tasks peer sync 由单独 peer-sync 规则处理。
- 每个活跃 review 目标都被读取，hook 为当前代码批次记录 no-edit review-confirmation marker。

如果模型选择不编辑 SDD，hook 不会硬阻断到底。它允许回合结束，并写 `.sdd-drift-report.md`，让用户最终确认文档是否真的无需更新。

## 归档规则

change 目录满足下面任一条件时会被视为已归档，并跳过后续 drift 检查：

- 目录名是 `archive`、`archives`、`archived`、`.archive`、`.archived`、`已归档`
- 目录名带有 `archived` / `已归档`
- 包含 `.archived`、`.archive`、`ARCHIVED`、`archived.md`、`archive.md`、`已归档.md`
- `status.md`、`state.md` 等小状态文件里写了 `status: archived` 或 `状态: 已归档`

## 日志和报告

默认诊断日志位置：

```text
<nearest .git>/sdd-drift-hook-state/sdd-drift-check.log.jsonl
```

如果 hook 没有使用 Git 状态目录，日志会跟随状态目录兜底到：

```text
<cwd>/.sdd-drift-hook-state/
%TEMP%/sdd-drift-check/
```

日志默认保留最近 3 天。每次写诊断日志前都会清理过期 JSONL 记录，包括当前日志和同名数字轮转文件，例如 `sdd-drift-check.log.jsonl.1`。

`.sdd-drift-report.md` 会写在项目根目录，因为它是给人看的。报告内容不变时，hook 不会只为了更新时间戳而反复重写报告。

建议加入 `.gitignore`：

```gitignore
.sdd-drift-report.md
.sdd-drift-hook-state/
.opencode/*.tmp
```

## 构建和打包

已提交的运行时发布件：

```text
plugins/sdd-drift-check/sdd-drift-check-hook.js
plugins/sdd-drift-check/sdd-drift-check-opencode.js
plugins/sdd-drift-check/sdd-drift-check-rules.md
```

适配器和共享源码位于：

```text
plugins/sdd-drift-check/src/core/
plugins/sdd-drift-check/src/handlers/
plugins/sdd-drift-check/src/adapters/claude-code/command-hook.js
plugins/sdd-drift-check/src/adapters/opencode/native-plugin.js
```

修改 `src/` 后，需要重新构建发布件：

```powershell
cd plugins\sdd-drift-check
npm install
npm run build
```

然后检查已提交发布件是否同步：

```powershell
npm run build:check
```

`build:check` 会生成临时 JS 发布件，并与已提交的两个 JS 文件做字节级比较。如果失败，说明改了源码但没有重新构建，或者直接改了发布件。

`sdd-drift-check-rules.md` 不会打包进 JS，它在运行时动态读取。

## 测试

静态和 fake-provider 测试：

```powershell
cd test\opencode-sdd-drift-e2e
npm install
npm test
```

OpenCode 原生真实模型检查：

```powershell
npm run e2e:real -- -Provider deepseek
npm run e2e:real -- -Provider minimax
```

明确别名：

```powershell
npm run e2e:real:native -- -Provider deepseek
npm run e2e:real:native -- -Provider minimax
```

Claude Code 伴随检查位于 `test/claude-code-sdd-drift-e2e`。provider key 只放本地：

```powershell
cd test\claude-code-sdd-drift-e2e
Copy-Item .claude\providers\deepseek.local.ps1.example .claude\providers\deepseek.local.ps1
Copy-Item .claude\providers\minimax.local.ps1.example .claude\providers\minimax.local.ps1
```

填好 `.local.ps1` 里的 Anthropic Messages compatible gateway 后运行：

```powershell
npm run e2e:real -- -Provider deepseek -Scenario multi-code-cascade
npm run e2e:real -- -Provider minimax -Scenario multi-code-cascade
```

跨 OpenCode 和 Claude Code 运行同一真实模型矩阵：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File test\run-sdd-drift-real-matrix.ps1 -Provider deepseek -Scenario multi-code-cascade -Target both
```

截至 2026-05-26，结构化提示词 wrapper 已回归验证：

| Runtime | Provider | Scenario | Result |
| --- | --- | --- | --- |
| OpenCode native plugin | DeepSeek | `multi-code-cascade` focused regression | 通过：模型看到结构化 SDD directive，未留下 unresolved report |
| OpenCode native plugin | MiniMax | `multi-code-cascade` focused regression | 通过：模型看到结构化 SDD directive，未留下 unresolved report |
| Claude Code command hook | DeepSeek | `multi-code-cascade` focused regression | 通过：Stop/checkpoint 语言保留了回到原任务的约束 |
| Claude Code command hook | MiniMax | `multi-code-cascade` focused regression | 通过：Stop/checkpoint 语言保留了回到原任务的约束 |

## 调试开关

关闭诊断日志：

```powershell
$env:SDD_DRIFT_LOG = "0"
opencode
```

指定诊断日志路径：

```powershell
$env:SDD_DRIFT_LOG_PATH = "E:\tmp\sdd-drift-check.log.jsonl"
opencode
```

调整日志轮转大小，默认 `2097152` bytes：

```powershell
$env:SDD_DRIFT_LOG_MAX_BYTES = "5242880"
opencode
```

调整代码工具结果里的模型可见 review 提醒次数。默认每批次和每会话都是 `1`：

```powershell
$env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = "1"
$env:SDD_DRIFT_CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS = "1"
opencode
```

把任一值设为 `0`，可以把代码 review 完全推迟到 Stop / question / compaction checkpoint。

调整诊断日志保留天数，默认 `3` 天。设置为 `0` 可临时关闭按天清理：

```powershell
$env:SDD_DRIFT_LOG_RETENTION_DAYS = "7"
opencode
```

显示非 peer warning：

```powershell
$env:SDD_DRIFT_SHOW_WARNINGS = "1"
opencode
```

严格阻断模式，可能在 UI 里显示 warning，因为它使用 `stderr` 和 exit code 2：

```powershell
$env:SDD_DRIFT_STRICT = "1"
opencode
```

关闭 OpenCode Stop continuation，保持 Stop report-only：

```powershell
$env:SDD_DRIFT_OPENCODE_STOP_MODE = "report-only"
opencode
```

只有当 post-idle Stop prompt 比它带来的收益更干扰时才建议这样做。正常 OpenCode 原生使用中，应保持 `tool.execute.after` 启用。

hook bug 诊断：

```powershell
$env:SDD_DRIFT_DEBUG = "1"
opencode
```

## 边界

- 只追踪 OpenCode / Claude 可见的文件工具事件。shell 重定向写文件对 hook 不一定可见。
- 内置 peer 规则是：
  - `proposal.md -> design.md` 只在 `design.md` 已存在时作为软阶段提醒。
  - `design.md -> tasks.md` 只在 `tasks.md` 已存在时触发。
  - `tasks.md -> design.md` 只在 `design.md` 已存在时触发。
- OpenCode Stop-only continuation 是 best effort，不应当被当作可靠级联执行机制。OpenCode 下可靠模型可见提醒主要依赖 `PostToolUse` / `tool.execute.after`。
