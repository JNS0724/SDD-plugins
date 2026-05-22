# `sdd-drift-check-hook.js` 重构计划

**版本:** 1.0
**日期:** 2026-05-22
**基线代码:** commit `b55230f` (Harden SDD drift hook from review)，3484 行
**关联文档:**
- [sdd-drift-check-hook.design.zh.md](./sdd-drift-check-hook.design.zh.md) v1.1（设计）
- [sdd-drift-check-hook.prd.zh.md](./sdd-drift-check-hook.prd.zh.md) v1.2（PRD）
- [sdd-drift-check-hook.review.zh.md](./sdd-drift-check-hook.review.zh.md) v1.0（审查 + 处理记录）

本计划聚焦审查 §6 处理记录中**暂缓**与**部分采纳**的工作项，给出阶段顺序、变更范围、必须保留的契约，以及每阶段的退出标准。

---

## 一、当前缺口（基于 b55230f）

| 项 | 状态 | 来源 |
|----|------|------|
| FR11 Attribution 五分支决策树 + LLM 评审 fork | 仅 single active 短路（行 1760-1774） | review B2 部分采纳 |
| HookHandlers 注册表 / `dispatch()` | 缺；`main()` 仍 532 行 if-else（行 2953-3484） | review 2.3 / R11 暂缓 |
| 5 个具名 handler（`handlePreToolUse` … `handlePreCompact`）| 缺；逻辑全在 `main()` | review 2.3 暂缓 |
| `Actions` 抽象 + `LOG→SAVE_PROJECT→SAVE_SESSION→REFRESH_REPORT→EMIT_MESSAGE` 排序不变量 | 缺；当前靠过程式顺序 | review 2.3 暂缓 |
| CircuitBreaker 异常熔断 | 字段已写入 `emptyState`（行 532）与 `normalizeState`（行 640），但**全文无读、无更新** | review 2.3 暂缓 |
| 16 旅程 snapshot fixture | 缺 | PRD §12 P0 暂缓 |
| PreToolUse question checkpoint 独立 handler | 仍嵌在 PostToolUse 分支内（行 3018、3037 旧位附近） | review 2.3 暂缓 |
| `ChangeDir.peerSyncs` schema 与设计文档不一致 | Codex 反驳保留；建议改名 `docSyncs` + 同步更新设计 §3.2 | review B4 反驳 |
| R8 错误率采样 | 未确认 | review 2.2 隐含 |

---

## 二、阶段顺序与边界

```
P0   测试安全网          P0.5 构建管线           P1   结构骨架抽离
──────────────           ──────────────          ──────────────
旅程 fixture     ─────►  src/ + bundler  ─────►  Handlers + Actions
                         dev↔dist 分离            + Dispatcher
                         产物字节级等价                 │
                                                        ▼
                          P2  CircuitBreaker      P3   FR11 Attribution
                          ──────────────          ──────────────
                          异常熔断接线             decision 五分支
                                                  + LLM 评审 fork
                                                        │
                                                        ▼
                                                  P4   Schema 收尾
                                                  ──────────────
                                                  peerSyncs → docSyncs
                                                  同步设计文档
```

**关键依赖**：

- **P0 是其余所有阶段的前置**。没有 fixture，P0.5 / P1 的纯重构没有验收手段，回归风险极高。
- **P0.5 必须先于 P1**。先把构建管线和 dev/dist 分离机制建立起来（且产物与当前文件字节级等价），P1 才能把 532 行 `main()` 物理拆进多个 `src/*.js` 文件。否则 P1 既要拆代码又要建构建链，回滚单元太大。
- P1 必做满 5 个 handler 的抽离 + Action 排序不变量；CircuitBreaker 与 LLM Attribution 都必须挂到这个骨架上，不能再回到 `main()` 内联。
- P2 与 P3 互相独立，可并行。
- P4 是文档化收尾，不动行为。

---

## 三、阶段 P0：旅程 snapshot fixture

### 范围

PRD 列举的 J1–J16 共 16 个旅程。最小必须覆盖：

| 旅程 | 覆盖意图 |
|------|----------|
| J1 | 单会话完整流，正常实现完成不报警 |
| J3 | 跨会话只改代码，触发 `CODE_PENDING_REVIEW` |
| J4 | 跨会话 carry-over 主路径 |
| J5 | doc-doc drift（design ↔ tasks）|
| J8 | PreToolUse question checkpoint |
| J11 | Attribution unrelated（FR11） |
| J13 | Attribution 多 dir 选择（FR11） |
| J15 | FR12 归档即时反映 |
| J16 | DTS 上下文跳过 |

P0 完成范围允许只先做 J1/J3/J4/J5/J8 五条，剩余可在对应阶段补齐。

### Fixture 结构

```
test/fixtures/journeys/<journey-id>/
├── inputs.jsonl           hook input 序列
├── expected-stdout.jsonl  每步期望的 stdout 行
├── expected-session.json  末态 session state
├── expected-project.json  末态 project state
└── expected-events.jsonl  期望诊断日志事件名
```

驱动方式：扩展 `test/opencode-sdd-drift-e2e/scripts/test-hook.cjs`，逐 fixture 重放并字节级比对 stdout 与状态末态。

### 退出标准

- 至少 5 条 fixture 在 CI 中跑通
- `process.stdout` 与 `.json` 状态文件均字节级一致
- 测试失败时输出 diff 易读（建议 `JSON.stringify(_, null, 2)` 后做行 diff）

---

## 三补：阶段 P0.5 — 构建管线（dev / dist 分离）

### 背景

设计文档 §4 原约束 "单文件部署，不引入 `lib/` 子目录、无 build step"。该约束的本意是：

- **用户安装路径上只需一个 `.js` 文件**（hook 配置简单、易部署）
- **避免编辑生效前需要构建**（开发反馈快）

随着 P1 把 532 行 `main()` 物理拆进多个 handler 文件，单源文件已不可持续。本阶段把原约束**重新表述**为：

> **分发产物**仍是单个 `.js` 文件；**开发态**允许多文件 + 构建工具，前提是：
> 1. 任意 commit 都能从源码确定性地重新生成产物
> 2. 产物文件在仓库内提交（用户 clone 即用，无需运行构建）
> 3. CI 守门：每次 push 必须验证 "源码 → 产物" 字节级等价

### 仓库布局

```
plugins/sdd-drift-check/
├── src/                                    ← 开发态（新增）
│   └── index.js                            ← P0.5 阶段仅有一个文件，内容 = 当前 hook.js
├── sdd-drift-check-hook.js                 ← 分发态产物（保持原路径不变）
├── sdd-drift-check-opencode.js             ← OMO 适配器（保持）
├── package.json                            ← 新增（仅含 build script + bundler 依赖）
└── build.mjs                               ← 新增（bundler 入口配置）

docs/sdd-drift-check/
├── sdd-drift-check.md                      ← 用户安装与使用文档
├── opencode-omo-getting-started.md         ← 入门文档
├── sdd-drift-check-hook.prd.zh.md          ← PRD
├── sdd-drift-check-hook.design.zh.md       ← 设计文档
├── sdd-drift-check-hook.review.zh.md       ← 评审记录
└── sdd-drift-check-hook.refactor.zh.md     ← 本文档
```

P0.5 阶段 `src/index.js` 与现有 `sdd-drift-check-hook.js` 内容完全一致——本阶段不做任何代码拆分。**P1 才开始往 `src/` 增加 handler/dispatcher 等子文件**。

### 构建工具选型

| 选型 | 优点 | 缺点 | 推荐 |
|------|------|------|------|
| **esbuild** | 零配置、CJS 原生支持、ms 级速度、社区主流 | 输出有轻微 banner | ⭐ 主推 |
| `@vercel/ncc` | 专为 Node 单文件分发设计 | 维护节奏偏慢 | 备选 |
| `rollup` | 输出最干净 | 配置复杂、依赖多 | 不推荐 |
| `bun build` | 极快 | 强制 bun 运行时，增加贡献者门槛 | 不推荐 |

主推 **esbuild**。理由：纯 CommonJS、无外部依赖（仅 Node built-ins）、产物可读、配置只需 5 行。

### `build.mjs` 草稿

```js
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [resolve(root, "src/index.js")],
  outfile: resolve(root, "sdd-drift-check-hook.js"),
  platform: "node",
  target: "node18",
  format: "cjs",
  bundle: true,
  minify: false,         // 保持可读，方便用户排查
  sourcemap: false,      // 产物不带 sourcemap，开发态本地可开
  banner: { js: "// AUTO-GENERATED from src/. Do not edit directly. Run `npm run build`." },
  legalComments: "none",
})
```

### `package.json` 草稿

```json
{
  "name": "sdd-drift-check",
  "private": true,
  "scripts": {
    "build": "node build.mjs",
    "build:check": "node build.mjs --check"
  },
  "devDependencies": {
    "esbuild": "^0.21.5"
  }
}
```

> 注意：不要在该目录设置 `"type": "module"`。`sdd-drift-check-hook.js` 和 `sdd-drift-check-opencode.js` 是用户直接执行/require 的 CommonJS `.js` 文件；若同目录 package 变成 ESM 包，实际 hook 运行会被破坏。`build.mjs` 依靠 `.mjs` 扩展名即可作为 ESM 运行。

### CI 守门

在已有 e2e 流水线最前面加一步：

```yaml
- name: Verify dist artifact matches src
  working-directory: plugins/sdd-drift-check
  run: |
    npm ci
    npm run build
    npm run build:check
```

`build:check` 会生成临时产物并与 `sdd-drift-check-hook.js` 字节级比较。非 0 即意味着有人改了 `src/` 没跑 `npm run build`，或直接改了产物文件——两种情况都拒绝合入。

### 必须保留的契约

| 契约 | 处理 |
|------|------|
| `module.exports` 32 个名字 | esbuild bundle 不改变模块导出形态；用 fixture 字节级 diff 验收 |
| `require("./sdd-drift-check-hook.js")` 工作 | opencode 适配器仍直接 require 产物文件，不动 |
| 用户 hook 配置路径不变 | `plugins/sdd-drift-check/sdd-drift-check-hook.js` 路径不动 |
| 单一外部依赖 | esbuild 仅 dev 依赖；运行时仍零依赖 |

### 退出标准

- `npm run build` 后 `git status` 无变化（产物与源码字节级一致）
- `npm run build:check` 在 CI 中作为最早检查项跑通
- `sdd-drift-check-opencode.js` 仍能正常 `require` 产物
- 旅程 fixture（P0 已落地）全部通过

### 范围之外

- **不做代码拆分**——任何 `src/` 多文件化都属于 P1 范围
- **不引入 TypeScript**——保持 JS 简洁，后续如要 TS 单独评估
- **不引入测试运行器替换**——`test-hook.cjs` 不变

---

## 四、阶段 P1：结构骨架抽离（R11 / §5 / §6 / §22）

### 4.1 命名空间整理

前提：**P0.5 已落地**，`src/` 目录与 `npm run build` 管线已可用。本阶段把当前 `src/index.js`（即原 532 行 `main()` 及周边逻辑）按设计 §4 的 24 段命名空间**物理拆进 `src/` 子文件**。

#### 目标布局

```
src/
├── index.js                     ← 入口：parseHookInput → dispatch
├── config.js                    §1 env 解析
├── caps.js                      §2 能力探测
├── paths.js                     §3 路径工具
├── fs-lock.js                   §4 FsLock
├── log.js                       §5 诊断日志
├── stdin.js                     §6 stdin + timeout
├── state/
│   ├── session-state.js         §7
│   ├── project-state.js         §8
│   └── circuit-breaker.js       §10 / P2 占位
├── transcript.js                §9
├── dts-context.js               §10
├── sdd.js                       §11
├── requirements.js              §12
├── state-machine.js             §13
├── attribution.js               §14 / P3 占位
├── gaps.js                      §15
├── checkpoint.js                §16
├── messages.js                  §17
├── notices.js                   §18
├── report.js                    §19
├── output.js                    §20
├── handlers/                    §21
│   ├── pre-tool-use.js
│   ├── post-tool-use.js
│   ├── stop.js
│   ├── user-prompt-submit.js
│   └── pre-compact.js
├── dispatcher.js                §22
└── exports.js                   §24 module.exports 契约
```

#### 5 个具名 handler 签名统一

```js
// 统一签名
function handleX(input, ctx) {
  // ctx = { cwd, sessionID, state, project, caps, now }
  return [/* Action[] */]
}
```

具体抽离来源（基于 b55230f 行号）：

| Handler | 抽离自 main() 行段 | 估计行数 | 目标文件 |
|---------|--------------------|----------|----------|
| `handleUserPromptSubmit` | 64-87 | ~30 | `src/handlers/user-prompt-submit.js` |
| `handlePreCompact` | 89-100 | ~15 | `src/handlers/pre-compact.js` |
| `handleStop` | 102-196 | ~120 | `src/handlers/stop.js` |
| `handlePostToolUse` | 197 至 PostToolUse 结尾 | ~250 | `src/handlers/post-tool-use.js` |
| `handlePreToolUse` | 现位于 PostToolUse 同分支末段（行 3054 附近） | ~50 | `src/handlers/pre-tool-use.js` |

### 4.2 `Actions` 抽象

```js
const Actions = {
  EMIT_MESSAGE: { type: "emit_message", payload },     // stdout（互斥）
  SAVE_SESSION: { type: "save_session" },
  SAVE_PROJECT: { type: "save_project" },
  REFRESH_REPORT: { type: "refresh_report" },
  LOG: { type: "log", event },
}

// Dispatcher 强制执行顺序：
//   LOG → SAVE_PROJECT → SAVE_SESSION → REFRESH_REPORT → EMIT_MESSAGE
async function runActions(actions, ctx) {
  const order = ["log", "save_project", "save_session", "refresh_report", "emit_message"]
  const buckets = Object.fromEntries(order.map((k) => [k, []]))
  for (const a of actions) buckets[a.type]?.push(a)
  for (const key of order)
    for (const a of buckets[key]) await runOne(a, ctx)
}
```

排序不变量保证：即便 `EMIT_MESSAGE` 后进程崩，state 已落盘。

### 4.3 `HookHandlers` 注册表

```js
const HookHandlers = {
  PreToolUse: {
    requiresSession: "write", requiresProject: "read",
    lockPolicy: { sessionWait: 1000, projectWait: 500 },
    handle: handlePreToolUse,
  },
  PostToolUse:      { requiresSession: "write", requiresProject: "write",
                      lockPolicy: { sessionWait: 5000, projectWait: 2000 },
                      handle: handlePostToolUse },
  Stop:             { ...同上, handle: handleStop },
  UserPromptSubmit: { requiresSession: "write", requiresProject: "read",
                      lockPolicy: { sessionWait: 1000, projectWait: 500 },
                      handle: handleUserPromptSubmit },
  PreCompact:       { requiresSession: "read",  requiresProject: "read",
                      lockPolicy: { sessionWait: 500,  projectWait: 500 },
                      handle: handlePreCompact },
}
```

### 4.4 `dispatch(input)`

```js
async function dispatch(input) {
  const caps = Caps.detect(input)
  if (CircuitBreaker.isOpen(input.hook_event_name)) {
    writeDiagnosticLog(cwd, { event: "circuit_open_skip", hook: input.hook_event_name })
    return
  }
  const handler = HookHandlers[input.hook_event_name]
  if (!handler) {
    writeDiagnosticLog(cwd, { event: "unsupported_event", hook: input.hook_event_name })
    return
  }
  const ctx = await buildContext(input, handler)   // 加锁 + load state/project
  try {
    const actions = await handler.handle(input, ctx)
    await runActions(actions, ctx)
    CircuitBreaker.recordSuccess(input.hook_event_name, ctx)
  } catch (err) {
    CircuitBreaker.recordFailure(input.hook_event_name, ctx)
    writeDiagnosticLog(cwd, { event: "handler_exception", hook: input.hook_event_name, err })
  } finally {
    await releaseLocks(ctx)   // reverse order
  }
}

async function main() {
  const input = parseHookInput(await readStdin())
  await dispatch(input)
  process.exit(0)
}
```

### 4.5 PreToolUse question checkpoint 独立化

把现在挂在 PostToolUse 路径里的 `buildQuestionCheckpointEnforcement`（行 2525-2611）调用从 PostToolUse 摘出，挪进 `handlePreToolUse`，并以 `permissionDecision="deny"` 输出。这里要严格按设计 §6.1 的节流：同一 signature 一次会话最多 deny 一次。

### 4.6 必须保留的契约

| 契约 | 说明 |
|------|------|
| `module.exports` | 现有 32 个导出名字节级保留；可新增 `dispatch`、`HookHandlers`、`Actions`、`runActions`、`CircuitBreaker` |
| 诊断日志事件名 | 既有名不改；新事件用新名（如 `handler_exception` / `circuit_open` / `circuit_open_skip`） |
| 单文件分发 | **分发产物**仍是单个 `plugins/sdd-drift-check/sdd-drift-check-hook.js`；开发态拆进 `src/` 由 esbuild 打包（见 P0.5） |
| `.sdd-drift-report.md` 格式 | 不变 |
| `SDD_DRIFT_*` env 名 | 既有名不改；新变量用新名 |
| stateDir 扁平布局 | `project.json` 与 session state 并列 |

### 4.7 退出标准

- P0 fixture 全部通过
- `main()` ≤ 50 行
- 每个 handler ≤ 200 行
- `module.exports` 既有名 grep 全部命中
- 现有 `test/opencode-sdd-drift-e2e/` 与 `test/claude-code-sdd-drift-e2e/` 回归全绿

---

## 五、阶段 P2：CircuitBreaker 接线

### 范围

`emptyState.circuitBreaker`（行 532）已存在但无人用。需要：

1. **状态读写 API**：
   ```js
   const CircuitBreaker = {
     isOpen(state, hookName, now = Date.now()) {
       const s = state.circuitBreaker[hookName]
       return Boolean(s && now < s.openUntilMs)
     },
     recordFailure(state, hookName, now = Date.now()) {
       const s = state.circuitBreaker[hookName] || { failures: 0, openUntilMs: 0 }
       s.failures += 1
       if (s.failures >= MAX_FAILURES) {
         s.openUntilMs = now + COOLDOWN_MS
         s.failures = 0
       }
       state.circuitBreaker[hookName] = s
     },
     recordSuccess(state, hookName) {
       const s = state.circuitBreaker[hookName]
       if (s) s.failures = 0
     },
   }
   ```

2. **常量**：`MAX_FAILURES = 5`、`COOLDOWN_MS = 60_000`（可经 env 覆盖：`SDD_DRIFT_CIRCUIT_MAX_FAILURES` / `SDD_DRIFT_CIRCUIT_COOLDOWN_MS`）。

3. **接线点**：`dispatch()` 入口处 `isOpen` 检查、异常 catch 内 `recordFailure`、handler 成功返回处 `recordSuccess`。

4. **诊断日志**：`circuit_open`（触发开启）、`circuit_open_skip`（事件被丢弃）、`circuit_close`（重置）。

### 退出标准

- 单 handler 连续 5 次异常 → 第 6 次起 60s 内被静默
- 60s 后下一次事件能恢复（不是永久 open）
- fixture 中新增 1 条 "故意抛错 6 次" 用例验证开关闭路径

---

## 六、阶段 P3：FR11 Attribution + LLM 评审 fork

### 6.1 `Attribution.decide` 五分支

```js
function decide(session, project, codeFile) {
  const candidates = Object.values(project.changeDirs).filter((d) => !d.archived)
  if (candidates.length === 0) return { kind: "no-attribution" }
  if (candidates.length === 1) return { kind: "single", target: candidates[0] }

  const sessionTouched = candidates.filter((d) =>
    session.edited.some((f) => f.startsWith(d.relDir + "/"))
  )
  if (sessionTouched.length === 1) return { kind: "session-touched", target: sessionTouched[0] }

  const now = Date.now()
  if (project.activeChangeDir && now < (project.activeUntilMs ?? 0)) {
    const active = candidates.find((d) => d.relDir === project.activeChangeDir)
    if (active && pathSimilar(codeFile, active.linkedCode)) {
      return { kind: "active-ttl", target: active }
    }
  }

  return { kind: "needs-review", candidates }
}

function pathSimilar(codeFile, linkedCode) {
  return linkedCode.some((c) => sharedPrefixDepth(codeFile, c.path) >= 2)
}
```

### 6.2 LLM 评审 fork（needs-review 分支）

`handlePostToolUse` 检测到 `needs-review` 时：

1. 计算 signature = `hash(JSON.stringify({ codeFiles: sorted, candidates: sorted }))`
2. 节流：同 signature 在 session 内最多一次（查 `session.attributionReviews[signature]?.emittedAt`）
3. 记录 `session.attributionReviews[signature] = { signature, emittedAt, candidates }`
4. 调用 `buildAttributionReviewPrompt(cwd, { codeFiles, candidates })`，输出走 `EMIT_MESSAGE` 通道，附带 `formatAttributionReviewRules()`（已存在，行 148）

### 6.3 观察后续动作（`Attribution.observeResolution`）

在每次后续 `PostToolUse` 内做轻量检查：

| LLM 后续动作 | 解析 | ProjectState 联动 |
|--------------|------|--------------------|
| Edit 某 dir 的 SDD doc | `resolution = "edit"` | 回填 `activeChangeDir + activeUntilMs` |
| 仅 Read SDD doc | `partialResolution = "read-only"` | 等 Stop 二次确认 |
| 创建新 change-dir | `resolution = "new-change-dir"` | 同步 `changeDirs[newRelDir]` |
| 直接 Stop（无 Read/Edit）| Stop handler 内第一次阻断、第二次接受为 `resolution = "unrelated"` | 沿用 stopBlocks 双 Stop 机制 |

### 6.4 二次 Stop 接收

在 `handleStop` 内遍历 `session.attributionReviews` 未解析项，按 review §8.4 规则收尾。

### 6.5 退出标准

- J11 fixture（unrelated code）跑通：双 Stop 后 `resolution = "unrelated"`
- J13 fixture（multi-dir，LLM 选 X）跑通：edit X 的 doc 后 `activeChangeDir = X`
- 单 dir 场景行为不变（落到 `kind: "single"`）
- `ATTRIBUTION_REVIEW_RULES`（已存在）被 `buildAttributionReviewPrompt` 实际拼接

---

## 七、阶段 P4：Schema 收尾

### 7.1 `peerSyncs` → `docSyncs`（B4 反驳后续）

Codex 已说明 ChangeDir 上的 `peerSyncs` 不是设计文档误用、而是为了**避免 design↔tasks ping-pong** 的跨会话证据。但字段名与 SessionState 同名造成 schema 等价类污染。建议：

1. 在 ProjectState 层把字段改名为 `docSyncs`（语义：跨会话观察到的 doc 间同步证据）
2. 同步更新设计文档 §3.2 在 `ChangeDir` 内补上 `docSyncs: Record<doc, PeerSyncBucket>` 与不变量描述
3. 加迁移：`normalizeProjectChangeDir` 读到旧 `peerSyncs` 时改写为 `docSyncs`，旧字段不再持久化

### 7.2 R8 错误率采样

`writeDiagnosticLog` 增加按事件名的滚动窗口计数器，按窗口结束时写 `summary` 行，避免错误风暴堆爆日志文件。

### 7.3 设计文档版本号

完成 P4 后将设计文档升至 v1.2，记录：
- §3.2 `docSyncs` 字段
- §10.1 R8 采样
- §22 `dispatch()` 与 `CircuitBreaker` 已实施

### 7.4 退出标准

- `project.json` 老文件能透明升级
- 设计文档与代码 schema 字段名一致

---

## 八、不在本计划范围的事项

- **新增功能**：本计划不引入设计文档以外的能力
- **OMO/OC 版本升级**：仍锁定 `oh-my-opencode@3.17.2` / `opencode-ai@1.2.27`
- **`opencode-sdd-drift-e2e` 测试基建大改**：仅做必要适配
- **多语言适配**：仅维护中文文档体系

---

## 九、风险与回滚

| 风险 | 缓解 |
|------|------|
| 重构破坏现有用户行为 | P0 fixture 必须先行；P1 完成时既有 e2e 必须全绿 |
| LLM Attribution 反复 deny / loop | signature 节流 + 二次 Stop 接受兜底；fixture J11 覆盖 |
| CircuitBreaker 误触发吃掉真实告警 | 默认 cooldown 60s 较短；env 可调；诊断日志 `circuit_open` 必报 |
| Action 排序变更引入新崩溃路径 | `runActions` 单元测试覆盖 5 种类型在不同子集下的执行顺序 |
| `peerSyncs` → `docSyncs` 迁移漏数据 | 迁移函数双写一个版本，下个版本删旧字段 |

---

## 十、里程碑与提交策略

| 里程碑 | 范围 | 单独 PR |
|--------|------|---------|
| M1 | P0 fixture（≥5 条）+ 现有 e2e 接入 fixture 驱动 | ✓ |
| **M1.5** | **P0.5 构建管线：`src/` + esbuild + `package.json` + CI 守门；`src/index.js` 内容 = 现产物** | **✓** |
| M2 | P1 Dispatcher + 5 handler + Actions 物理拆入 `src/handlers/`、`src/dispatcher.js` 等子文件（不含 CircuitBreaker、不含 Attribution）| ✓ |
| M3 | P2 CircuitBreaker 接线 + 错误用例 fixture | ✓ |
| M4 | P3 FR11 Attribution 完整 + J11/J13 fixture | ✓ |
| M5 | P4 schema 收尾 + 设计文档 v1.2 | ✓ |

每个里程碑独立可发布。**M1.5 完成后**，开发态多文件、分发态单文件已稳定；M2 完成后，新增 hook 类型只需 ① 写 handler 文件 ② 在 `src/dispatcher.js` 的 `HookHandlers` 注册——`main()` 不再变更，`npm run build` 产物自动更新。

---

## 十一、实施记录

### 2026-05-22：P0 / P0.5 起步

- 新增旅程 fixture 驱动 `test/opencode-sdd-drift-e2e/scripts/test-journeys.cjs`，覆盖 J1/J3/J4/J5/J8。
- 旅程 fixture 会真实执行 hook 命令，检查 stdout、session state、project state 与诊断日志事件。
- 修复 `recordFile()` 事件时间未纳入文件 mtime 的竞态，避免 project state 偶发反转。
- 收紧 project `peerSyncs` 推断：不再仅凭文件时间判断某文档已从 peer 同步，必须有 session 证据、同会话顺序证据，或项目态先前已明确处于 opposite-ahead 状态。
- 建立 P0.5 开发态入口 `plugins/sdd-drift-check/src/index.js`、`build.mjs` 与 `package.json`；分发态 `sdd-drift-check-hook.js` 路径保持不变。
- `build:check` 使用临时产物与 dist 字节比较，避免在本地脏工作区被 `git diff` 误伤。
- 开始 P1 物理拆分：抽出 `src/stdin.js`，`src/index.js` 通过 `require("./stdin")` 使用；`sdd-drift-check-hook.js` 由 esbuild 重新生成并通过现有单测、原生 OpenCode 适配器测试与旅程 fixture 测试。
