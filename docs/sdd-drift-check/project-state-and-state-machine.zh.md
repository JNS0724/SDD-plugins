# Project 状态与状态机

`project.json` 是跨会话长期状态文件，和 session state 文件写在同一个状态目录下：

```text
<nearest .git>/sdd-drift-hook-state/project.json
```

如果 Git 状态目录不可用，会使用和其他 hook state 相同的兜底路径：
`<cwd>/.sdd-drift-hook-state/project.json`，再兜底到
`%TEMP%/sdd-drift-check/<repo-hash>/project.json`。

这个文件归插件实现管理。它适合用来定位问题和做人工评审，但通常不建议用户手工修改。
时间字段是内部比较时钟，不是公开 API。文档/代码编辑时间会使用由文件 mtime
和 hook 事件时间共同推导出的单调数值；`activeUntilMs` 则是普通的 epoch
毫秒 TTL 截止时间。

## 顶层字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | number | Project state schema 版本。当前值为 `1`。 |
| `lastUpdatedAt` | string | project state 重新计算并保存时写入的 ISO 时间。 |
| `changeDirs` | object | 从相对 change 目录到 `ChangeDir` 记录的映射，例如 `sdd/changes/demo`。 |
| `activeChangeDir` | string or null | 后续代码改动的当前最佳归属目标。会在本会话编辑 SDD 文档，或代码归属明确落到某个 change 目录时更新。 |
| `activeUntilMs` | number | `activeChangeDir` 的过期时间，单位是 epoch milliseconds。默认 TTL 由 `SDD_DRIFT_ACTIVE_TTL_MS` 控制，默认 7 天。 |
| `activeLastEditedSession` | string or null | 最近刷新 `activeChangeDir` 的 session id。 |

`changeDirs` 会从根目录下的 `sdd/changes/*` 和 `.sdd/changes/*` 自动发现。
如果某个目录之前被记录过，后来归档了，它仍然可以保留在 `project.json` 中，
但计算出的状态会变成 `ARCHIVED`，并在 drift 检查中跳过。

## `ChangeDir` 字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `relDir` | string | 相对项目根目录的 change 目录路径。 |
| `archived` | boolean | 该 change 目录是否已通过目录名、标记文件或状态文件识别为归档。已归档目录不会产生 drift 提醒。 |
| `docs` | object | `proposal`、`design`、`tasks` 三类文档的记录。 |
| `linkedCode` | array | 被归属到该 change 目录的代码文件。它用于跨会话判断“代码领先于文档”的项目级 review。 |
| `docSyncs` | object | 跨会话的文档同步证据，表示某个 SDD 文档曾为了同步另一个文档而更新。用于避免 `design.md -> tasks.md -> design.md` 往返 ping-pong。 |
| `alignedAt` | string or null | 最近一次完成实现流基线刷新时的 ISO 时间。 |
| `alignedAtMs` | number | 内部数值基线。后续被归属的代码编辑时间必须大于这个值，才可能产生项目级 code drift。 |
| `state` | string | 该 change 目录的派生状态。每次加载/保存都会重新计算，具体见下方状态表。 |
| `conditions` | object | 用来计算 `state` 的派生布尔条件。它是诊断数据，不是独立事实来源。 |

旧版本 `project.json` 如果包含 `peerSyncs`，读取时会迁移为 `docSyncs`；
新版本保存时不会再持久化 `peerSyncs`。

## `docs` 记录

每个 `docs.<proposal|design|tasks>` 条目使用下面的结构：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `exists` | boolean | 当前磁盘上是否存在该文档。 |
| `lastEditedMs` | number | 最近一次观察到该文档被 Edit/Write/MultiEdit 的内部时钟。 |
| `lastReviewedMs` | number | 最近一次观察到该文档被 Read 或 Edit/Write/MultiEdit 的内部时钟。编辑也视为 review。 |
| `lastEditedSession` | string | 最近编辑该文档的 session id。 |
| `lastReviewedSession` | string | 最近读取或编辑该文档的 session id。 |

`proposal.md` 是阶段标记。只有当 `design.md` 已存在时，它才可能产生软性的下一阶段提醒。
它本身不会直接要求创建或同步 `tasks.md`。

## `linkedCode` 记录

`linkedCode` 中的每个条目表示一个当前归属到该 change 目录的代码文件：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `path` | string | 相对项目根目录的代码路径。 |
| `lastEditedMs` | number | 最近一次观察到该代码文件被编辑的内部时钟。 |
| `lastEditedSession` | string | 最近编辑该代码文件的 session id。 |
| `linkedAt` | number | 该文件首次被归属到这个 change 目录时的内部时钟。 |

已有条目会原地更新。新增条目会按最近编辑时间排序，并受
`SDD_DRIFT_PROJECT_LINKED_CODE_CAP` 限制，默认最多保留 `200` 条。

## `docSyncs` 记录

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

这表示插件观察到 `tasks.md` 是为了响应某次 `design.md` 编辑而更新的。
除非后续出现新的独立源文件编辑，否则下一次 `tasks.md` 编辑不应该立刻反向强制同步
`design.md`。

## 派生 `conditions`

| 字段 | 含义 |
| --- | --- |
| `proposalOnly` | `proposal.md` 存在，但 `design.md` 和 `tasks.md` 都不存在。 |
| `designAheadOfTasks` | `design.md` 和 `tasks.md` 都存在；`design.md` 有已知 session 编辑，且比 `tasks.md` 新；同时 `design.md` 不是刚刚为了同步 `tasks.md` 而更新的响应文档。 |
| `tasksAheadOfDesign` | `tasks.md` 和 `design.md` 都存在；`tasks.md` 有已知 session 编辑，且比 `design.md` 新；同时 `tasks.md` 不是刚刚为了同步 `design.md` 而更新的响应文档。 |
| `codeAheadOfDocs` | 最新归属代码编辑时间大于 `alignedAtMs`，并且至少一个现有 review 目标没有在该代码编辑后被 review。 |
| `codePendingDocs` | 对最新 linked code 编辑仍需 review 的现有文档列表，目前可能包含 `design.md` 和/或 `tasks.md`。 |

## ChangeDir 状态

`state` 由 `archived` 和 `conditions` 按下面优先级计算：

| 状态 | 何时计算为该状态 | 预期行为 |
| --- | --- | --- |
| `ARCHIVED` | `archived` 为 true | 完全跳过该 change 目录。 |
| `PROPOSAL_STAGE` | `proposalOnly` 为 true | 允许继续提案/设计头脑风暴，不强制同步 tasks；不会被视为 carry-over drift。 |
| `ALIGNED` | 没有任何 drift 条件为 true | 没有项目级 SDD 待处理事项。 |
| `MULTI_DRIFT` | 多个硬 drift 条件同时为 true | carry-over/checkpoint 提醒会汇总该目录，模型需要解决所有列出的原因。 |
| `DESIGN_PENDING_TASKS` | 只有 `designAheadOfTasks` 为 true | `tasks.md` 需要 review/更新，以匹配 `design.md`。 |
| `TASKS_PENDING_DESIGN` | 只有 `tasksAheadOfDesign` 为 true | `design.md` 需要 review/更新，以匹配 `tasks.md`。 |
| `CODE_PENDING_REVIEW` | 只有 `codeAheadOfDocs` 为 true | 现有活跃 `design.md` / `tasks.md` 需要 review；只有代码事实改变了文档内容时才更新。 |

`collectCarryOverDrift()` 会把所有未归档、且不是 `ALIGNED` / `PROPOSAL_STAGE`
的状态视为跨会话 drift。因此，即使原会话已经结束，后续新会话仍可能收到
`CARRY-OVER DRIFT` 提醒。

## 状态机流转

状态机不是根据模型口头声明推进的，而是根据插件观察到的文件事件反复重新计算。
关键流转如下：

1. **加载 / 发现**
   - 每个 hook 事件都会加载 session state 和 `project.json`。
   - 插件会发现 `sdd/changes/*` 和 `.sdd/changes/*` 目录，并根据文件系统为
     缺失的目录创建 `ChangeDir` 记录。
   - 如果 project state 里还没有对应值，现有 `proposal.md`、`design.md`、
     `tasks.md` 会用文件元数据初始化 `docs.*.exists`、`lastEditedMs` 和
     `lastReviewedMs`。

2. **读取 SDD 文档**
   - `Read proposal.md/design.md/tasks.md` 会更新
     `docs.<doc>.lastReviewedMs` 和 `lastReviewedSession`。
   - 读取可以清除 code-review pending 状态，因为该文档已经在代码编辑后被 review。
   - 读取不会更新 `lastEditedMs`，也不会创建 peer-sync 响应。

3. **编辑 SDD 文档**
   - `Edit` / `Write` / `MultiEdit` 会更新 `lastEditedMs`、
     `lastEditedSession`、`lastReviewedMs`、`lastReviewedSession`。
   - 编辑 `design.md` 时，如果同目录 `tasks.md` 已存在且更旧，可能进入
     `DESIGN_PENDING_TASKS`。
   - 编辑 `tasks.md` 时，如果同目录 `design.md` 已存在且更旧，可能进入
     `TASKS_PENDING_DESIGN`。
   - 如果目标文档是为了满足某个 pending peer requirement 而编辑的，
     `docSyncs` 会记录源/目标关系，避免立刻产生反向 ping-pong。
   - 被编辑的 change 目录会成为 `activeChangeDir`，并刷新 `activeUntilMs`。

4. **代码编辑归属**
   - 如果项目没有 `sdd/` 或 `.sdd/`，或者 DTS/问题单上下文处于激活状态，
     代码编辑会被忽略。
   - 否则，插件会根据 session 证据、`activeChangeDir` TTL/路径相似度、
     唯一候选兜底，或 attribution-review 提示，把代码文件归属到某个活跃
     change 目录。
   - 被归属的代码文件会写入 `linkedCode`。
   - 一旦 linked code 比 `alignedAtMs` 更新，且现有 `design.md` 或 `tasks.md`
     没有在该代码编辑后被 review，对应文档会进入 `codePendingDocs`；如果没有
     其他硬 drift，该目录会变成 `CODE_PENDING_REVIEW`。

5. **实现流基线刷新**
   - 如果同一个 session 先编辑相关 SDD 文档，再编辑代码，并且所有现有 review
     目标都在最新代码编辑之前被编辑过，`refreshAlignedBaseline()` 会推进
     `alignedAtMs` / `alignedAt`。
   - 这对应“先计划、再实现”的正常流程。它可以避免刚完成的实现立刻变成
     carry-over drift。

6. **无文档修改的 review 确认**
   - 如果代码已经修改，所有现有活跃 review 目标也都在最新代码编辑后被读取或
     review，但模型判断无需修改 SDD，session 会记录一个 review-confirmation 标记。
   - project state 也会看到新的 `lastReviewedMs`，因此未来会话中的
     `codePendingDocs` 可以被清除。
   - 报告仍可能提示人工最终确认：本次确实无需修改文档。

7. **提问 / 交接 checkpoint**
   - agent 准备向用户提问或交还控制权前，question checkpoint 会检查是否还有未解决的
     peer/code drift。
   - 如果存在未解决工作，会先发出模型可见 checkpoint，再允许问题完成。

8. **PreCompact checkpoint**
   - 上下文压缩前，pending question/checkpoint 状态和 carry-over drift 会被总结到压缩摘要中，
     避免恢复后的模型忘记刚才被打断的 SDD review。

9. **Stop / idle checkpoint**
   - Claude-compatible Stop 下，未解决的 peer/code drift 可以按配置次数阻断或请求继续。
   - native OpenCode idle 下，Stop continuation 是 best effort。报告和日志仍会刷新，
     但 OpenCode 的可靠继续路径主要依赖 `tool.execute.after` 和 question checkpoint。
   - 如果没有 pending 工作，Stop 会清理临时 session peer-sync 状态，按需刷新基线，
     并写入 `stop_allow_no_pending` 诊断日志。

10. **归档**
    - 如果 change 目录通过目录名、标记文件或状态文件被识别为已归档，
      `archived` 会变为 true，`state` 会变为 `ARCHIVED`。
    - 如果被归档的目录正好是 active 目录，`activeChangeDir` 和 `activeUntilMs`
      会被清空。

一句话概括：`project.json` 记住跨会话的项目事实；session state 记住当前会话发生了什么；
每个 hook 事件都会把 session 合并进 project，重新计算 `conditions`，派生 `state`，
然后决定是发出模型可见 checkpoint、保持静默，还是写入人工可读报告。
