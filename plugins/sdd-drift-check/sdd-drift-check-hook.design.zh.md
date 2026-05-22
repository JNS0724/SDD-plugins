# `sdd-drift-check-hook.js` 方案设计

**版本:** 1.1
**日期:** 2026-05-22
**修订记录:** v1.1 — 修正状态机 peer-exists 与 per-doc review 规则；补齐 `PreToolUse` 提问检查点；统一 ProjectState 存储路径为 `<stateDir(cwd)>/project.json`；修正实施阶段依赖顺序
**作者:** Claude（Opus 4.7）+ 用户协同
**输入文档:** [sdd-drift-check-hook.prd.zh.md](./sdd-drift-check-hook.prd.zh.md) v1.2
**版本锁定:** `oh-my-opencode@3.17.2` + `opencode-ai@1.2.27` + `@opencode-ai/plugin@1.2.27`

**文档更新日志:**

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.1 | 2026-05-22 | 修正状态机 peer-exists 与 per-doc review 规则；补齐 `PreToolUse` 提问检查点；统一 ProjectState 存储路径；修正实施阶段依赖 |
| v1.0 | 2026-05-22 | 初版方案设计 |

本文档回答"怎么做"，PRD 回答"做什么"。每个 FR/NFR/旅程都映射到本文的具体实施位置（见附录 A、B）。

---

## 目录

1. [设计原则](#一设计原则)
2. [顶层架构](#二顶层架构)
3. [数据模型](#三数据模型)
4. [命名空间布局](#四命名空间布局)
5. [Hook Dispatcher](#五hook-dispatcher)
6. [5 个 Hook Handler 实现](#六5-个-hook-handler-实现)
7. [状态机与完成基线](#七状态机与完成基线)
8. [代码归属与 LLM 评审](#八代码归属与-llm-评审)
9. [跨会话 carry-over](#九跨会话-carry-over)
10. [健壮性与错误隔离](#十健壮性与错误隔离)
11. [测试策略](#十一测试策略)
12. [分阶段实施](#十二分阶段实施)
13. [必须保留的契约](#十三必须保留的契约)
14. [附录](#十四附录)

---

## 一、设计原则

派生自 PRD 的设计目标 + 既往迭代共识：

1. **单文件部署**：保持 `sdd-drift-check-hook.js` 单文件分发（不引入 `lib/` 等子目录）
2. **状态分层**：session state（短命，per-sessionID）+ project state（长命，per-cwd）
3. **决策外包**：模糊归属由 LLM 在 `ATTRIBUTION_REVIEW_RULES` 下评审；hook 只是上下文设置器与动作观察者
4. **fail-open**：永不阻塞用户主流程；任何异常路径最终 `process.exit(0)`
5. **能力探测**：CC vs OMO 自动降级（Stop block / PreCompact / parentSessionId 差异）
6. **行为可观测**：诊断日志事件名枚举化，可被外部工具 grep
7. **向后兼容**：现有 `module.exports`、state schema、env 变量、`.sdd-drift-report.md` 格式全部保留

---

## 二、顶层架构

```
┌────────────────────────────────────────────────────────┐
│         Hook 入口 (stdin → main → Dispatcher)          │
└────────────────────────┬───────────────────────────────┘
                         │
                ┌────────▼────────┐
                │   Dispatcher    │   能力探测 / 熔断 / 锁
                └────────┬────────┘
                         │
        ┌────────────────┼────────────────┬──────────────┐
        │                │                │              │
   ┌────▼────┐      ┌────▼────┐      ┌────▼────┐    ┌────▼─────┐
   │ PostTU  │      │  Stop   │      │   UPS   │    │ PreCompct│
   └────┬────┘      └────┬────┘      └────┬────┘    └────┬─────┘
        │                │                │              │
   ┌────▼────┐           │                │              │
   │ PreTU   │           │                │              │
   │Question │           │                │              │
   └────┬────┘           │                │              │
        └────────────────┴────────────────┴──────────────┘
                         │
                ┌────────▼────────┐
                │   状态层         │
                │ ┌─────────────┐ │
                │ │SessionState │ │  短命；现有结构 + R1/R7/R10 加固
                │ │  v3 (扩)    │ │
                │ └─────────────┘ │
                │ ┌─────────────┐ │
                │ │ProjectState │ │  ★ 新增；跨会话权威
                │ │  v1         │ │
                │ └─────────────┘ │
                └─────────────────┘
```

**核心数据流**：

- 所有 hook 事件先过 Dispatcher（统一锁、能力、熔断）
- Handler 读/写 SessionState 与 ProjectState，返回 `Action[]`
- Dispatcher 顺序执行 Action（stdout 互斥、save state、refresh report、log）

**关键不变量**：
- ProjectState 是跨会话权威；SessionState 是本会话工作集
- ProjectState 中的 `alignedAtMs` 是 J1↔J3 的分水岭（核心机制）
- 所有 LLM 评审决定由 hook 观察后续动作记录，不解析自然语言

---

## 三、数据模型

### 3.1 SessionState v3（扩展现有 v2）

```typescript
interface SessionState {
  version: 3
  createdAt: string
  clock: number

  // 现有字段（v2 保留）
  touched: string[]
  edited: string[]
  changeDirs: string[]
  files: Record<NormalizedKey, FileRecord>
  requirements: Record<NormalizedKey, RequirementBucket>
  stopBlocks: Record<Signature, number>
  toolEvents: Record<EventKey, Timestamp>
  peerSyncs: Record<NormalizedKey, PeerSyncBucket>
  codeDriftNotice: Notice | null
  peerDriftNotice: Notice | null
  subagentCheckpointNotice: Notice | null
  codeReviewConfirmations: Record<Signature, Confirmation>
  transcriptEvents: Record<EventKey, Timestamp>
  dtsContext: DtsContext | null

  // v3 新增
  firstEventAt?: string                       // 首事件时刻，检测新会话边界
  transcriptCursor?: number                   // byteOffset，增量 hydration
  projectStateSeenAt?: string                 // 已感知的 project.json 版本
  attributionReviews: Record<Signature, AttributionReview>  // FR11 评审追踪
  noEditSession?: boolean                     // FR13 纯讨论标记
  circuitBreaker: Record<HookName, CircuitState>            // 熔断状态
  subagentContext?: { parentSessionId: string }              // FR5 OMO 路径
}

interface AttributionReview {
  signature: string
  emittedAt: string
  candidates: string[]                        // 候选 changeDir relDir 列表
  resolution?: "edit" | "no-edit-confirmed" | "new-change-dir" | "unrelated"
  resolvedAt?: string
  resolvedToDir?: string                      // edit / new-change-dir 时填
}

interface CircuitState {
  failures: number
  openUntilMs: number
}
```

### 3.2 ProjectState v1（★ 新增）

```typescript
interface ProjectState {
  version: 1
  lastUpdatedAt: string

  changeDirs: Record<RelDir, ChangeDir>

  // 活跃归属
  activeChangeDir?: string                    // relDir
  activeUntilMs?: number                      // TTL 过期时间（ms 时间戳）
  activeLastEditedSession?: string
}

interface ChangeDir {
  relDir: string                              // 相对 cwd
  archived: boolean

  docs: {
    proposal?: DocRecord
    design?: DocRecord
    tasks?: DocRecord
  }

  linkedCode: LinkedCodeRecord[]

  // FR3 完成基线
  alignedAt?: string                          // ISO
  alignedAtMs?: number                        // 快速比较用

  // 派生显示状态（每次写入时计算）
  state: ChangeDirState
  conditions: {
    proposalOnly: boolean
    designAheadOfTasks: boolean
    tasksAheadOfDesign: boolean
    codeAheadOfDocs: boolean
    codePendingDocs: ("design" | "tasks")[]
  }
}

interface DocRecord {
  exists: boolean
  lastEditedMs?: number
  lastReviewedMs?: number                     // Read 或 Edit
  lastEditedSession?: string
  lastReviewedSession?: string
}

interface LinkedCodeRecord {
  path: string                                // 相对 cwd
  lastEditedMs: number
  lastEditedSession: string
  linkedAt: number                            // 首次归属到该 change-dir 的时刻
}

type ChangeDirState =
  | "ALIGNED"
  | "PROPOSAL_STAGE"
  | "DESIGN_PENDING_TASKS"
  | "TASKS_PENDING_DESIGN"
  | "CODE_PENDING_REVIEW"
  | "MULTI_DRIFT"
  | "ARCHIVED"
```

### 3.3 文件路径

```
<stateDir(cwd)>/
├── project.json                             ★ 新增（项目级权威）
├── <hash>-<sessionID>.json                  现有（会话级；扁平不动）
├── sdd-drift-check.log.jsonl                现有
└── *.corrupt-<ts>                           破损归档（R7）
```

`<stateDir(cwd)>` 必须复用现有 `stateDir(cwd)` 解析逻辑：优先写入最近的 `.git/sdd-drift-hook-state`，再降级到 cwd 下 `.sdd-drift-hook-state`，最后才写入临时目录。保持扁平结构避免 migration 风险。`project.json` 与会话 state 并列，不能把项目级状态硬编码回仓库根目录，避免污染 `git status`。

### 3.4 Schema 迁移

**SessionState v2 → v3**：

```
normalizeState() 自动补全：
  - version: 2 → 3
  - 新字段 default 为 undefined / {} / null
  - 旧字段不删，确保 module.exports 测试通过
```

**ProjectState 首次初始化**：

```
loadProjectState(cwd):
  if project.json 不存在:
    project = createEmptyProject()
    扫描 cwd 下所有 sdd/changes/* 和 .sdd/changes/*
    for each dir:
      project.changeDirs[relDir] = {
        relDir, archived: detectArchived(dir),
        docs: { ... FS mtime 初始化 ... },
        linkedCode: [],
        conditions: computeConditions(...),
        state: computeState(...),
      }
    saveProjectState(cwd, project)
  return project
```

**关键决策**：首次初始化时 `lastReviewedMs = lastEditedMs`（保守，避免误报"never reviewed"）。

---

## 四、命名空间布局

单文件 `sdd-drift-check-hook.js` 内 24 段：

```
§1   Config              env 解析（唯一 process.env 入口）
§2   Caps                能力探测（CC vs OMO；canStopBlock 等）
§3   Paths               toPosix / normalizeKey / isSddPath / CODE_EXT
§4   FsLock              acquireFileLock / writeTextAtomic
§5   Log                 writeDiagnosticLog + 错误率采样（R8）
§6   Stdin               带超时的 stdin 读取（R9）
§7   SessionState        load/save/migrate + LRU（R1） + 破损归档（R7）
§8   ProjectState        ★ 新增：load/save/init + 锁
§9   Transcript          增量 hydration（R2） + DTS prompt 文本提取
§10  DtsContext          DTS 检测三件套 + 单次缓存（R3）
§11  Sdd                 findSdd / getChangeDoc / applyToolRecord / detectArchiveAction（FR12）
§12  Requirements        peer-sync 簿记（同会话内）
§13  StateMachine        ★ 新增：per-change-dir 状态机 + alignedAtMs（FR2/FR3）
§14  Attribution         ★ 新增：归属决策（active TTL + LLM review fork）（FR8/FR11）
§15  Gaps                drift / collectPeerGaps / collectCodeGaps
§16  Checkpoint          subagent checkpoint + parentSessionId（FR5）
§17  Messages            buildToolEnforcement / buildCodeEnforcement / buildAttributionReview（FR11）
§18  Notices             三套通知去重 + AttributionReview 节流
§19  Report              refreshReport（始终先写盘再 emit）
§20  Output              Claude / OpenCode 输出适配
§21  HookHandlers        5 个 hook 各一个 handler，统一签名 (input, ctx) → Action[]
§22  Dispatcher          注册表式分派 + 熔断（R11）
§23  Main                ~40 行 wiring
§24  Exports             保留 module.exports 契约 + 新增导出
```

—— 部署物仍是单文件。无 `lib/` 子目录。无 build step。

---

## 五、Hook Dispatcher

### 5.1 注册表

```js
const HookHandlers = {
  PreToolUse: {
    requiresSession: "write",
    requiresProject: "read",
    lockPolicy: { sessionWait: 1000, projectWait: 500 },
    handle: handlePreToolUse,
  },
  PostToolUse: {
    requiresSession: "write",
    requiresProject: "write",
    lockPolicy: { sessionWait: 5000, projectWait: 2000 },
    handle: handlePostToolUse,
  },
  Stop: {
    requiresSession: "write",
    requiresProject: "write",
    lockPolicy: { sessionWait: 5000, projectWait: 2000 },
    handle: handleStop,
  },
  UserPromptSubmit: {
    requiresSession: "write",
    requiresProject: "read",
    lockPolicy: { sessionWait: 1000, projectWait: 500 },
    handle: handleUserPromptSubmit,
  },
  PreCompact: {
    requiresSession: "read",
    requiresProject: "read",
    lockPolicy: { sessionWait: 500, projectWait: 500 },
    handle: handlePreCompact,
  },
}
```

未列出的事件名 → log `unsupported_event`、退出。

`PreToolUse` 只用于**提问/交接类工具的 checkpoint**，例如 agent 准备询问“是否提交代码”“是否继续下一步”时，在真正把控制权交还用户前检查 SDD drift。它不是通用的工具前置阻断，也不用于普通 Edit/Write/Read 的许可控制。

### 5.2 Dispatch 流程

```
async dispatch(input):
  1. caps = Caps.detect(input)
  2. if CircuitBreaker.isOpen(input.hook_event_name): log + return
  3. handler = HookHandlers[input.hook_event_name]
  4. ctx = await buildContext(input, handler):
       - load SessionState (with lock if write)
       - load ProjectState (with lock if write)
       - if 任一锁未拿到 → log + return
  5. try:
       actions = handler.handle(input, ctx)
       await Actions.run(actions, ctx)
       CircuitBreaker.recordSuccess
     catch err:
       CircuitBreaker.recordFailure
       log handler_exception
       // 不抛
  6. release locks in reverse order
```

### 5.3 Action 类型

```js
const Actions = {
  EMIT_MESSAGE,        // stdout 输出（互斥）
  SAVE_SESSION,        // saveSession(cwd, sessionID, session)
  SAVE_PROJECT,        // saveProject(cwd, project)
  REFRESH_REPORT,      // refreshReport(cwd, session, project)
  LOG,                 // writeDiagnosticLog
}
```

执行顺序保证：LOG → SAVE_PROJECT → SAVE_SESSION → REFRESH_REPORT → EMIT_MESSAGE。这样即便 EMIT_MESSAGE 后进程崩，state 也已落盘。

---

## 六、5 个 Hook Handler 实现

### 6.1 `handlePreToolUse`（question checkpoint）

```
1. 仅识别 question-like / handoff-like 工具：
    - OMO task/plan 相关的用户确认工具
    - commit / continue / ask-user 类语义的交接动作
    - 非提问类工具直接 silent
2. 加载 ProjectState，聚合所有未归档 ChangeDir 的 pending drift
3. 若无 pending:
    - log pretooluse_question_allow_no_pending
    - return [SAVE_SESSION]
4. 若有 pending:
    - 生成 question checkpoint prompt
    - Claude Code 输出 permissionDecision="deny"
    - reason/additionalContext 要求 agent 在提问或提交前先完成 SDD review / sync
5. 节流：
    - 同一 signature 在一次会话内最多 deny 一次
    - 之后仍未解决时交给 Stop / UserPromptSubmit 聚合提醒，避免交互死循环
```

该 handler 的目的只覆盖 J8：agent 准备把问题抛给用户时，先给它一次处理 SDD drift 的机会。它不改变 `PostToolUse` 的实时观察职责，也不替代 `Stop` 的最终兜底。

### 6.2 `handlePostToolUse`

```
1. markToolEvent: 重复事件 → return
2. session.applyToolRecord(tool, input):
    - 更新 session.files (LRU 1000)
    - 更新 session.changeDirs
    - 若是 Edit/Write/MultiEdit → noEditSession=false
3. project.applyToolEvent(input):
    - 更新对应 ChangeDir.docs.*.lastEditedMs / lastReviewedMs / lastEditedSession
    - 若是代码 → 走 Attribution.decide(...)
    - 若工具命中归档动作 → 即时设 ChangeDir.archived=true（FR12）
    - 重算所有 ChangeDir 的 conditions + state
4. Attribution.decide 返回的 decision:
    - "single" / "session-touched" / "active-ttl" → 直接归属，append linkedCode
    - "needs-review" (FR11) → 标记 session.attributionReviews[signature]
    - "no-attribution" → 不归属，记录为 "unattributed pending"
5. Gaps.collectPeerGaps + collectCodeGaps（基于 SessionState 与 ProjectState 合并视角）
6. 输出决策（互斥优先级）：
    (a) Hard peer drift → emit peer enforcement
    (b) Pending attribution review → emit ATTRIBUTION_REVIEW_PROMPT
    (c) Code drift (in single attributed dir) → emit code enforcement
    (d) Stage reminder → emit stage reminder
    (e) 都没有 → silent
7. 子代理 checkpoint 路径（task / call_omo_agent / delegate_task / background_output）：
    - hydrateStateFromCheckpointOutput
    - 若有 pending → emit subagent checkpoint enforcement
8. 提问/交接 checkpoint 不在 PostToolUse 处理；统一由 PreToolUse 处理，避免工具结果里重复注入同类提示。
```

### 6.3 `handleStop`

```
1. 增量 hydration (R2):
    - 从 session.transcriptCursor 续读 transcript
    - 不需要全量回放
2. 检查 noEditSession (FR13):
    - if session.touched and session.edited are both empty (this session):
        log stop_no_edit_session; return [{ LOG }, { SAVE_SESSION }]
3. refreshReport（始终）:
    - 先写 .sdd-drift-report.md（OMO Stop block 兜底）
4. project.recomputeAllChangeDirs():
    - 对每个 dir 重算 conditions + state
5. FR2/FR3 完成基线判定:
    - 对每个 dir:
        if conditions.codeAheadOfDocs and 本会话有 SDD edits and 时序自然 (proposal seq < design seq < tasks seq < code seq, no out-of-order):
            标记为"实现阶段完成"
            刷新 dir.alignedAtMs = now()
            条件 codeAheadOfDocs 视为已消
6. buildPendingEnforcement(session, project):
    - peerGaps 优先于 codeGaps
    - 若 ALL dirs are ALIGNED / PROPOSAL_STAGE / ARCHIVED → 无 pending
7. 若无 pending:
    - log stop_allow_no_pending
    - return [SAVE_SESSION, SAVE_PROJECT, REFRESH_REPORT]
8. 若有 pending:
    - blockCount = state.stopBlocks[signature]
    - if blockCount < maxBlocks (CC=2, OMO=1):
        emit Stop enforcement (with inject_prompt for OMO)
        increment blockCount
    - else:
        log stop_allow_max_blocks; return []
9. Stop 允许后清理 stopBlocks / peerSyncs / stageOnlyRequirements
```

### 6.4 `handleUserPromptSubmit`（opt-in）

```
1. DTS 单次检测 (R3):
    - if isDtsContextText(input.prompt):
        session.dtsContext = { active: true, source: "user-prompt", ... }
2. parentSessionId 探测 (FR5):
    - if input.parentSessionId (OMO 才有):
        session.subagentContext = { parentSessionId: input.parentSessionId }
3. 首事件检测 (FR6):
    - if !session.firstEventAt:
        session.firstEventAt = isoNow
        project = loadProjectState(cwd)
        carryOver = collectCarryOverDrift(project)
        if carryOver.length:
            return [{
              EMIT_MESSAGE: buildClaudeCodeOutput("UserPromptSubmit", carryOverText),
            }, { SAVE_SESSION }]
4. 否则:
    - log + return [SAVE_SESSION]
```

### 6.5 `handlePreCompact`（opt-in）

```
1. 不需要锁项目级（只读）
2. 从 ProjectState 收集所有未归档 ChangeDir 的 drift 状态
3. 拼接 ≤5KB 摘要:
    "SDD drift summary (preserved across compaction):
     - sdd/changes/feature-x: CODE_PENDING_REVIEW
     - sdd/changes/feature-y: TASKS_PENDING_DESIGN
     ..."
4. return [{
    EMIT_MESSAGE: {
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: [text],
      }
    }
  }]
```

---

## 七、状态机与完成基线

### 7.1 状态机条件计算（每个 ChangeDir）

```js
StateMachine.computeConditions = (dir) => {
  const designExists = dir.docs.design?.exists === true
  const tasksExists = dir.docs.tasks?.exists === true
  const designEdited = dir.docs.design?.lastEditedMs ?? 0
  const tasksEdited = dir.docs.tasks?.lastEditedMs ?? 0
  const designReviewed = max(designEdited, dir.docs.design?.lastReviewedMs ?? 0)
  const tasksReviewed = max(tasksEdited, dir.docs.tasks?.lastReviewedMs ?? 0)
  const codeEdited = max(0, ...dir.linkedCode.map(c => c.lastEditedMs))
  const reviewTargets = [
    designExists && ["design", designReviewed],
    tasksExists && ["tasks", tasksReviewed],
  ].filter(Boolean)
  const codePendingDocs = reviewTargets
    .filter(([_, reviewedAt]) => codeEdited > reviewedAt)
    .map(([doc]) => doc)

  return {
    proposalOnly: dir.docs.proposal?.exists
                && !designExists
                && !tasksExists,
    designAheadOfTasks: designExists && tasksExists
                   && designEdited > tasksEdited && designEdited > 0,
    tasksAheadOfDesign: designExists && tasksExists
                   && tasksEdited > designEdited && tasksEdited > 0,
    codeAheadOfDocs: codePendingDocs.length > 0
                   && codeEdited > (dir.alignedAtMs ?? 0),
    codePendingDocs,
  }
}
```

注意：

- `designAheadOfTasks` / `tasksAheadOfDesign` 必须要求 peer 文件存在。若用户还在 proposal→design 的前期打磨阶段，不能强行要求创建 `tasks.md`。
- `codeAheadOfDocs` 必须逐个已有目标文档检查，不能用 `max(designReviewed, tasksReviewed)` 折叠。否则只评审了一个文档就会掩盖另一个文档未评审。
- `codeAheadOfDocs` 的第二个 AND 子句是 FR3 完成基线的核心：**alignedAtMs 之前的代码不算 drift**。

### 7.2 状态派生

```js
StateMachine.computeState = (conditions, archived) => {
  if (archived) return "ARCHIVED"
  if (conditions.proposalOnly) return "PROPOSAL_STAGE"
  const flags = [
    conditions.designAheadOfTasks,
    conditions.tasksAheadOfDesign,
    conditions.codeAheadOfDocs,
  ]
  const count = flags.filter(Boolean).length
  if (count === 0) return "ALIGNED"
  if (count > 1) return "MULTI_DRIFT"
  if (conditions.designAheadOfTasks) return "DESIGN_PENDING_TASKS"
  if (conditions.tasksAheadOfDesign) return "TASKS_PENDING_DESIGN"
  if (conditions.codeAheadOfDocs) return "CODE_PENDING_REVIEW"
}
```

### 7.3 alignedAtMs 刷新机制（FR2/FR3 核心）

```js
// 在 handleStop 内：
const refreshAlignedBaseline = (session, project) => {
  for (const dir of Object.values(project.changeDirs)) {
    if (dir.archived) continue

    const sessionEditedDocsForDir = session.edited.filter(f =>
      f.startsWith(dir.relDir + "/")
    )
    const sessionEditedCode = session.edited.filter(f => isCodePath(f))

    // 实现阶段判定：
    //   - 本会话编辑过该 dir 的 design 或 tasks
    //   - 且本会话有代码编辑
    //   - 且 SDD 编辑早于代码编辑（时序自然）
    //   - 且代码编辑后没有再回头改 SDD（无反复）
    const wasImplementationFlow =
      sessionEditedDocsForDir.length > 0 &&
      sessionEditedCode.length > 0 &&
      lastEditSeq(session, sessionEditedDocsForDir) < firstEditSeq(session, sessionEditedCode) &&
      !hadOutOfOrderEdits(session, dir)

    const conditions = computeConditions(dir)

    if (wasImplementationFlow && conditions.codeAheadOfDocs) {
      // 刷新基线
      dir.alignedAtMs = Date.now()
      dir.alignedAt = new Date().toISOString()
      // 重算 conditions（codeAheadOfDocs 现在应为 false）
      dir.conditions = computeConditions(dir)
      dir.state = computeState(dir.conditions, dir.archived)
    }
  }
}
```

**J1 序列**：

```
1. Edit proposal.md         (seq=1)
2. Edit design.md           (seq=2)
3. Edit tasks.md            (seq=3)
4. Edit src/foo.ts          (seq=4)
5. Stop:
   - conditions.codeAheadOfDocs = true (timestamps)
   - 但 wasImplementationFlow = true
   - → 刷新 alignedAtMs = now (≥ code edit time)
   - → 重算 conditions.codeAheadOfDocs = false
   - → state = ALIGNED
   - → 无提醒
```

**J3 序列**：

```
6. (新一轮) Edit src/foo.ts (seq=5, 假设)
7. Stop:
   - codeEdited = seq=5 时间戳 > alignedAtMs（刚刷新过的）
   - sessionEditedDocsForDir = [] (本轮无 SDD edit)
   - wasImplementationFlow = false
   - codeAheadOfDocs 保持 true
   - → emit code enforcement
```

—— alignedAtMs 是区分 J1 和 J3 的唯一关键字段。

---

## 八、代码归属与 LLM 评审

### 8.1 归属决策树

```js
Attribution.decide(session, project, codeFile) {
  const candidates = Object.values(project.changeDirs).filter(d => !d.archived)

  if (candidates.length === 0) return { kind: "no-attribution" }

  if (candidates.length === 1) {
    return { kind: "single", target: candidates[0] }
  }

  // 优先：本会话内 SDD 编辑过的 dir
  const sessionTouched = candidates.filter(d =>
    session.edited.some(f => f.startsWith(d.relDir + "/"))
  )
  if (sessionTouched.length === 1) {
    return { kind: "session-touched", target: sessionTouched[0] }
  }

  // 次：activeChangeDir 在 TTL 内 且路径相似
  const now = Date.now()
  if (project.activeChangeDir && now < (project.activeUntilMs ?? 0)) {
    const active = candidates.find(d => d.relDir === project.activeChangeDir)
    if (active && pathSimilar(codeFile, active.linkedCode)) {
      return { kind: "active-ttl", target: active }
    }
  }

  // 否则：模糊归属 → LLM 评审
  return { kind: "needs-review", candidates }
}

const pathSimilar = (codeFile, linkedCode) => {
  // 路径前缀重合启发式：codeFile 的前 N 段与 linkedCode 中至少一项的前 N 段重合
  // N = 2 (e.g., src/foo/) 作为默认
  return linkedCode.some(c => sharedPrefixDepth(codeFile, c.path) >= 2)
}
```

### 8.2 LLM 评审注入（FR11）

`handlePostToolUse` 检测到 `needs-review` 时：

```js
const signature = hash(JSON.stringify({
  codeFiles: recentCodeFiles.sort(),
  candidates: decision.candidates.map(c => c.relDir).sort(),
}))

// 节流：同一 signature 在 session 内最多注入 1 次
if (session.attributionReviews[signature]?.emittedAt) {
  return [{ LOG: "attribution_review_throttled" }]
}

session.attributionReviews[signature] = {
  signature,
  emittedAt: isoNow,
  candidates: decision.candidates.map(c => c.relDir),
}

const prompt = buildAttributionReviewPrompt(cwd, {
  codeFiles: recentCodeFiles,
  candidates: decision.candidates,
})

return [
  { LOG: "emit_attribution_review", signature },
  { SAVE_SESSION },
  { EMIT_MESSAGE: claudeCodeOutput("PostToolUse", prompt) },
]
```

### 8.3 LLM 后续动作观察

```js
// 在后续 PostToolUse 内调用（每次都做轻量检查）
Attribution.observeResolution(session, project, input):
  const pendingReviews = Object.entries(session.attributionReviews)
    .filter(([_, r]) => !r.resolution)

  for (const [sig, review] of pendingReviews) {
    const target = identifyResolutionTarget(input, review.candidates)
    
    if (target?.editedSddDoc) {
      review.resolution = "edit"
      review.resolvedToDir = target.relDir
      review.resolvedAt = isoNow
      project.activeChangeDir = target.relDir
      project.activeUntilMs = now + DEFAULT_TTL_MS
    } else if (target?.readSddDoc) {
      // 标记 read 但未确认；等 Stop 二次确认
      review.partialResolution = "read-only"
    } else if (target?.newChangeDirCreated) {
      review.resolution = "new-change-dir"
      review.resolvedToDir = target.newRelDir
      project.changeDirs[target.newRelDir] = createChangeDirFromFS(target.newRelDir)
    }
  }
```

### 8.4 二次 Stop 确认

```js
// 在 handleStop 内：
const unresolvedReviews = Object.values(session.attributionReviews)
  .filter(r => !r.resolution)

for (const review of unresolvedReviews) {
  if (review.partialResolution === "read-only") {
    // agent read 过文档，但没 edit → 视为"已评审、判断无关"
    // 沿用 codeReviewConfirmation 的双 Stop 机制
    review.resolution = "no-edit-confirmed"
    review.resolvedAt = isoNow
    log "codeReviewConfirmed_unrelated"
  } else {
    // 既无 read 也无 edit → 首次 Stop 阻断，重发评审
    // 第二次 Stop 接受
    review.resolution = "unrelated"
    log "attribution_unrelated_accepted"
  }
}
```

### 8.5 `ATTRIBUTION_REVIEW_RULES` 常量

见 PRD 附录 A。代码中按英文规则字符串数组实现，注入时拼接成 5 条编号规则。

---

## 九、跨会话 carry-over

### 9.1 触发路径（双轨）

**主路径**：`UserPromptSubmit`（用户注册时）

```js
handleUserPromptSubmit:
  if !session.firstEventAt:
    session.firstEventAt = isoNow
    project = loadProjectState(cwd)
    carryOver = collectCarryOverDrift(project)
    if carryOver.length:
      reminder = formatCarryOverReminder(carryOver, project)
      return [{ EMIT_MESSAGE: claudeCodeOutput("UserPromptSubmit", reminder) }]
```

**兜底路径**：PostToolUse 首次（用户未注册 UserPromptSubmit 时）

```js
handlePostToolUse 内部：
  if !session.firstEventAt && hasSddWorkspace(cwd):
    session.firstEventAt = isoNow
    project = ctx.project
    carryOver = collectCarryOverDrift(project)
    if carryOver.length:
      // 把 carryOver 前缀拼到本次的 enforcement 之前
      // 仅一次；后续 PostToolUse 不再触发
      prepend = "[Carry-over] " + formatCarryOverReminder(carryOver, project) + "\n---\n"
      enforcementMessage = prepend + enforcementMessage
```

### 9.2 `collectCarryOverDrift`

```js
collectCarryOverDrift(project):
  return Object.values(project.changeDirs)
    .filter(d => !d.archived)
    .filter(d => d.state !== "ALIGNED" && d.state !== "PROPOSAL_STAGE")
    .map(d => ({
      relDir: d.relDir,
      state: d.state,
      lastCodeAgeText: humanizeAge(d.linkedCode),
      lastDocAgeText: humanizeAge(d.docs),
    }))
```

### 9.3 文案模板

```
SDD carry-over drift (from prior sessions):
- sdd/changes/feature-x: CODE_PENDING_REVIEW
  (last code edit 2 days ago; design.md last touched 3 days ago)
- sdd/changes/feature-y: TASKS_PENDING_DESIGN
  (tasks.md edited 5h ago; design.md last edited 1d ago)

Active change-dir: sdd/changes/feature-x (TTL: 16h remaining)
```

---

## 十、健壮性与错误隔离

### 10.1 R 编号修复表（结构 + 健壮性）

| 编号 | 修复 | 实施位置 |
|------|------|----------|
| **R1** | session.files LRU 上限 1000 | §7 SessionState.gc |
| **R2** | transcript 增量 hydration（byteOffset cursor） | §9 Transcript.hydrateIncremental |
| **R3** | DTS 检测在 UserPromptSubmit 单次完成；其余路径用缓存 | §10 DtsContext.detectOnce |
| **R6** | OMO 端 parentSessionId 辅助；mtime 启发式保留兜底 | §16 Checkpoint.fromParentSession |
| **R7** | state.json 破损时 `*.corrupt-<ts>` 归档 | §7 SessionState.quarantineOnParseFail；§8 ProjectState 同 |
| **R8** | 错误率采样汇总日志 | §5 Log.summary |
| **R9** | stdin 5s 超时 | §6 Stdin.readWithTimeout |
| **R10** | SessionState v2→v3 自动迁移；ProjectState 首次扫描初始化 | §7 / §8 |
| **R11** | Dispatcher 替代 main() if-else | §22 |
| 不变量 | session + project 各 5 条不变量 | §7 / §8 |
| 熔断 | 单 hook 连续 5 次异常 → 60s 静默 | §22 CircuitBreaker |

### 10.2 ProjectState 专属健壮性

| 项 | 内容 |
|---|---|
| ProjectState 锁 | 与 session 同 FsLock；锁路径 `<stateDir>/project.json.lock` |
| ProjectState 不变量 | (a) 每 dir 的 state ↔ conditions 一致；(b) activeChangeDir ∈ changeDirs ∪ {null}；(c) linkedCode[*].path 不在 archived dir 下；(d) alignedAtMs 单调递增（不回退） |
| changeDirs 自动 GC | 每次 PostToolUse 检查 dir FS 是否仍存在；不存在 → archived=true（保留记录而非删除） |
| linkedCode 上限 | 每 dir 最多 200 项；LRU |

### 10.3 不变量违反处理

```
所有不变量违反 → log + 自动修复 + 不抛错
e.g., activeChangeDir 不在 changeDirs 中 → 清空 active
e.g., dir.state 与 conditions 不一致 → 重算 state
e.g., alignedAtMs 回退 → 保留较大值
```

### 10.4 Caps 能力降级矩阵

| 能力 | CC | OMO 3.17.2 |
|------|----|-----|
| PostToolUse emit | 完整 | 完整 |
| PreToolUse question checkpoint | 完整（permissionDecision deny） | 取决于 OMO 桥接；未支持时降级到 Stop / UserPromptSubmit |
| Stop block | 完整 | error / interrupt session 静默丢；`canStopBlock=false` 时降级 + 写报告 |
| UserPromptSubmit emit | 完整 | 完整（chat.message 桥接）|
| PreCompact emit | 完整 | 完整（experimental.session.compacting）|
| parentSessionId in UPS | 不提供 | 提供 |

---

## 十一、测试策略

### 11.1 Snapshot 基线（P0 必须）

每个旅程一份 fixture：

```
test/fixtures/journeys/
├── J1-single-session-full-flow/
│   ├── inputs.jsonl            # 一系列 hook input
│   ├── expected-stdout.jsonl   # 每步期望的 stdout
│   ├── expected-session.json   # 末态 session state
│   ├── expected-project.json   # 末态 project state
│   └── expected-events.jsonl   # 期望的诊断日志事件名
├── J2-subagent-impl/
...
├── J16-dts-mode/
```

驱动方式：扩展 `test/opencode-sdd-drift-e2e/scripts/test-hook.cjs`，逐 fixture 重放 input、断言每个输出。

### 11.2 不变量测试

用 `fast-check` 生成随机操作序列，验证：
- 5 条 SessionState 不变量
- 5 条 ProjectState 不变量
- alignedAtMs 单调性
- LRU 容量不超限

### 11.3 时延预算测试

`process.hrtime.bigint()` 围栏。fixture：
- 1MB ProjectState（≈100 ChangeDir）
- 1MB SessionState
- 10MB transcript（增量 hydration cursor）

每个 handler 单次执行：
- PreCompact ≤ 200ms
- UserPromptSubmit ≤ 300ms
- PostToolUse ≤ 500ms
- Stop ≤ 2s

### 11.4 LLM 评审 e2e（J11 / J13 专用）

```
J11 fixture（unrelated code）:
  step 1: 用户 prompt → UPS
  step 2: agent edit src/auth.ts → PostToolUse (含 ATTRIBUTION_REVIEW_PROMPT)
  step 3: agent Read sdd/changes/feature-x/design.md → PostToolUse
  step 4: agent 直接 Stop → 第一次 Stop block
  step 5: agent 再次 Stop → 接受为 unrelated；project 记录 codeReviewConfirmed

J13 fixture（multi-dir，LLM 选 X）:
  step 1: UPS
  step 2: Edit src/auth/login.ts → PostToolUse (review prompt with X+Y)
  step 3: Edit sdd/changes/feature-y/tasks.md → 归属解析到 Y
  step 4: Stop → project.activeChangeDir=Y, drift resolved
```

### 11.5 现有 e2e 不动

`test/opencode-sdd-drift-e2e/` 与 `test/claude-code-sdd-drift-e2e/` 保留，作为回归。

---

## 十二、分阶段实施

| 阶段 | 内容 | PRD FR/NFR 覆盖 | 旅程覆盖 |
|------|------|------------------|----------|
| **P0** | 16 个旅程的 snapshot 基线 fixture | – | 所有 |
| **P1** | 结构重排（§1-§7 / §9-§12 / §15-§20） + R7 R9 R10 | NFR1 NFR6 | – |
| **P2** | Dispatcher（§22）+ 熔断 + R11 + 不变量断言 | NFR1 NFR5 | – |
| **P3** | 容量与时延：R1 R2 R3 R8 | NFR2 NFR4 | – |
| **P4** | ProjectState（§8）基础 + StateMachine（§13）+ alignedAtMs（FR2/FR3）+ FR12 归档即时反映 + FR13 纯讨论静默 | FR1 FR2 FR3 FR7 FR9 FR10 FR12 FR13 NFR7 | J1 J2 J3 J4 J5 J9 J10 J15 |
| **P5** | UserPromptSubmit handler + PreCompact handler + R6 parentSessionId + PreToolUse question checkpoint | FR5（部分）FR6（CC 路径）FR7 NFR3 | J5 J8 J12 |
| **P6** | Attribution（§14）+ LLM 评审（FR11）+ `ATTRIBUTION_REVIEW_RULES` 常量 + FR6 carry-over（完整）+ FR8 active TTL | FR4 FR6（完整）FR8 FR11 | J6 J7 J8 J11 J13 J14 J16 |

**关键依赖**：
- P0 是所有后续阶段的安全网（**必须先做**）
- P1–P3 = 结构 + 健壮性（pre-PRD 范围）
- P4 引入 ProjectState，是 P5 / P6 的前置
- P5 引入新 hook，但功能 opt-in，对未配置用户透明
- P6 引入 LLM 评审，依赖 P5 的 active 概念

每阶段独立可发布。P5 依赖 P4，因为 UserPromptSubmit / PreCompact / PreToolUse 都需要读取 ProjectState 才能可靠聚合跨会话 drift。

---

## 十三、必须保留的契约

下列契约**重构必须字节级保留**：

| 契约 | 验收方式 |
|------|----------|
| stdout JSON 形态 | snapshot 字节级 diff |
| SessionState v2 字段保留 | normalize 自动加 v3 新字段，v2 字段不删 |
| `module.exports` 32 个内部函数 | grep 测试文件 + opencode 适配器 |
| 诊断日志 event 名 | 既有名不改；新事件用新名 |
| `SDD_DRIFT_*` env 变量名 | 既有名不改；新变量加新前缀 |
| `.sdd-drift-report.md` 格式 | snapshot |
| `<stateDir(cwd)>/` 目录布局 | 复用现有 stateDir 解析；新增 project.json 与 session state 并列 |

新增导出（不破坏既有）：
- `loadProjectState` / `saveProjectState`
- `StateMachine.computeConditions` / `computeState` / `refreshAlignedBaseline`
- `Attribution.decide`
- `buildAttributionReviewPrompt`
- `ATTRIBUTION_REVIEW_RULES`（常量）

---

## 十四、附录

### 附录 A：FR → 实施位置映射

| FR | 实施位置 | 阶段 |
|----|----------|------|
| FR1 ProjectState 持久化 | §8 ProjectState | P4 |
| FR2 实现阶段识别 | §13 StateMachine + handleStop | P4 |
| FR3 完成基线 alignedAtMs | §13 StateMachine + handleStop | P4 |
| FR4 双向 doc-doc drift（跨会话）| §15 Gaps + §8 ProjectState | P4 / P6 |
| FR5 子代理归属 | §16 Checkpoint + §21 UPS handler | P5 |
| FR6 跨会话 carry-over | §21 UPS handler + PostToolUse 兜底 | P5 / P6 |
| FR7 Stop 强制检测 | §21 Stop handler + PreToolUse question checkpoint | 现有，配合 P4 / P5 |
| FR8 active TTL | §14 Attribution + §8 ProjectState | P4 / P6 |
| FR9 归档跳过 | §11 Sdd.isArchivedChangeDir | 现有 |
| FR10 多 change-dir | §13 / §15 | 现有 + P4 |
| FR11 LLM 评审 | §14 Attribution + §17 Messages | P6 |
| FR12 归档即时反映 | §11 Sdd.detectArchiveAction | P4 |
| FR13 纯讨论 Stop 静默 | §21 Stop handler | P4 |

### 附录 B：旅程 → FR 覆盖

| Journey | 主要 FR | 主要阶段 |
|---------|---------|----------|
| J1 | FR2 FR3 FR7 | P4 |
| J2 | FR2 FR3 FR5 FR7 | P4 / P5 |
| J3 | FR3 FR7 | P4 |
| J4 | FR1 FR6 FR7 FR8 | P4 / P5 / P6 |
| J5 | FR4 FR7 | P4 |
| J6 | FR5 FR6 FR7 FR8 | P5 / P6 |
| J7 | FR5 FR6 FR7 FR8 | P5 / P6 |
| J8 | FR5 FR6 FR7 FR8 | P5 / P6 |
| J9 | （现有 stage reminder）| 现有 |
| J10 | FR2 FR3 | P4 |
| J11 | FR11 | P6 |
| J12 | FR1（lastReviewedMs） | P4 / P5 |
| J13 | FR11 | P6 |
| J14 | FR8 FR11 | P6 |
| J15 | FR12 | P4 |
| J16 | （现有 DTS） | 现有 + R3 优化 P3 |

### 附录 C：诊断日志事件名清单

既有（保留）：
- `hook_start` / `hook_exception`
- `stop_allow_no_pending` / `stop_allow_max_blocks` / `stop_block_emit` / `stop_allow_review_confirmed`
- `emit_peer_enforcement` / `emit_peer_stage_reminder` / `emit_code_enforcement`
- `emit_subagent_checkpoint_enforcement`
- `ignored_*`

新增：
- `stop_no_edit_session`（FR13）
- `emit_attribution_review`（FR11）
- `attribution_review_throttled`
- `codeReviewConfirmed_unrelated`（FR11 双 Stop）
- `attribution_unrelated_accepted`（FR11 双 Stop 无 read）
- `archive_detected`（FR12）
- `dts_context_active`（已存在但需正式化）
- `circuit_open` / `circuit_open_skip`
- `state_quarantined`（R7）
- `stdin_timeout`（R9）
- `handler_exception`
- `carry_over_emitted`（FR6）
- `pretooluse_question_checkpoint_emit`（J8）
- `pretooluse_question_allow_no_pending`（J8）
- `pretooluse_question_throttled`（J8）

### 附录 D：版本锁与升级路径

```
oh-my-opencode    3.17.2 (locked)
opencode-ai       1.2.27 (locked)
@opencode-ai/plugin 1.2.27 (locked)
```

升级风险点（不在本设计范围）：
- OMO 升级 → PreCompact 实验事件可能变名；Stop 处理可能变；UserPromptSubmit 桥接位置可能变
- OC 升级 → tool.execute.before/after 事件结构可能变
- 升级时先跑 16 个旅程的 snapshot 回归

---

## 下一步

1. **阶段 0**：本设计与 PRD 一致性核验，建立 16 个旅程的 snapshot fixture
2. **阶段 1 PR**：§1-§7 命名空间重排 + R7/R9/R10
3. **阶段 2 PR**：Dispatcher + 熔断
4. **阶段 3 PR**：性能修复
5. **阶段 4 PR**：ProjectState + StateMachine + alignedAtMs
6. **阶段 5 PR**：UPS + PreCompact + PreToolUse question checkpoint
7. **阶段 6 PR**：Attribution + LLM 评审 + carry-over 完整

每个 PR 单独评审；P0 fixture 在每个 PR 中作为回归测试基线。
