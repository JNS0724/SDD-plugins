# SDD Review-Ledger 详细设计（指导开发）

**版本:** 0.3（0.1 初稿 + §十六 MVP 切割 + R1 去 git 状态依赖 + R2 GateGuard 可借鉴边界）
**日期:** 2026-05-30
**作者:** Claude（Opus 4.8）+ 用户协同
**修订:** R1 — 去 git 状态依赖（详见 [`sdd-review-ledger-git-independence.zh.md`](./sdd-review-ledger-git-independence.zh.md)）：候选池 `gitChangedFiles` → `scanWorkTree`（工作树扫描，mtime 仅作跳过提示）；推送去 `git diff`（改读当前内容 +v0.2 快照 diff）；`init` 改扫描 + auto-baseline 升正式机制；`findNearestGitDir` → `findRepoRoot`（不要求 git）。本文受影响段（§一/§二/§6.3/§七/§八/§9.2/§十~§十四/§十六）已打补丁。
**修订:** R2 — GateGuard 可借鉴边界（详见 [`sdd-review-ledger-gateguard-lessons.zh.md`](./sdd-review-ledger-gateguard-lessons.zh.md)）：采纳逃生阀总开关 `SDD_REVIEW=off`（`config.js` `isDisabled()`）、`session-key.js` 多级回退、`atomic.js` 保留 Windows rename unlink-retry、`paths.js` `sanitizePath` 渲染侧消毒、§9.2 推送模板 fact-forcing 化、§9.3 批次边界定义、裸理由展示侧标记。拒绝 FactGate 中间路（违 §2）/merge-on-save/TTL。本文受影响段（§一/§二/§七/§9.2/§9.3/§6.5/§十二/§十四/§十六）已打补丁。**三文档冲突时：R2 > R1 > 架构 > 本文。**
**定位:** 把 [架构文档](./sdd-review-ledger-architecture.zh.md)（决策与"为什么"）翻译成**可据以实现**的工程设计（模块、类型、纯函数签名、伪代码、管线、双平台适配、测试验收）。架构文档是真相源；本文与之冲突时以架构文档为准，并回填修订。

---

## 一、范围与已锁决策

本文实现架构文档已锁的合约。逐条对照：

| 架构决策 | 本文落点 |
|---|---|
| §2/§3 工具不算 drift，只做"评审编排 + 记账"，判断全交 LLM | §四 不变量 / §六 纯函数 |
| §4 两层：Layer A doc↔doc 纯函数 / Layer B code↔doc | §六 `computeNeedsReview` |
| §5 极简账本 + §13#1 JSON map + 本地 gitignore + FsLock + 原子写 | §五 数据模型 / §七 管线 |
| §5.3 ingest-before-render + 哈希钉选 | §七 管线 / §六 `ingestCheckoffs` |
| §6.3 主推送=编辑时工具结果 +（R1）读当前内容定位；§6.4 obligation 锚定模型 | §九 投递层 |
| R1 去 git：候选池 `scanWorkTree`、推送去 git diff、init 扫描 + auto-baseline、repo-root 不要求 git | §6.3/§七/§八/§九 + `core/scan.js` |
| R2 GateGuard 借鉴：逃生阀总开关 / session-key 回退 / Windows rename 重试 / sanitizePath 渲染侧 / §9.2 fact-forcing / 批次边界 / 裸理由展示标记 | §二/§七/§9.2/§9.3/§6.5/§14 + `core/{config,session-key,atomic,paths}.js` |
| §7 三关键陷阱（编辑时推送 / 不 auto-synth / 不归一化）+ §7.5 永不阻断精确边界（R2：排除 DENY、FactGate 违 §2） | 贯穿 / §九 |
| §8 清除=**唯一勾选**，编辑从不清除（2026-05-30 定 checkoff-only） | §六 `ingestCheckoffs` / §九 |
| §13#3 锚点粒度=整文件哈希 | §六 `hashElement` |

**本文顺带定（架构 §13 余项，用与已锁决策一致的默认值，标注可调）：**
- **#2 代码元素粒度** → **文件级**（v1）。函数级/AST 延后，先量化文件级的无害多提醒一次的比率（§十一）。
- **#5 节流** → 主动提醒默认**不设 session/批次上限**，每次相关 code/SDD-doc 编辑都可提醒；只保留可选 env 硬上限和总逃生阀（§九 / §十二）。
- **#6 双平台投递矩阵** → §十 明确给出。

---

## 二、代码库结构（开发态拆分 → 分发态打包）

沿用 sibling `sdd-drift-check` 的"多源文件 → esbuild 打包成单文件发布件 + `build:check` 字节校验"模式（其 `build.mjs` / `package.json` 可直接改名复用）。

```
plugins/sdd-review-ledger/
  package.json                      # build / build:check 脚本 + esbuild devDep
  build.mjs                         # 两个 entry → 两个发布件（字节校验）
  sdd-review-ledger-hook.js         # 发布件：Claude Code command hook（打包产物）
  sdd-review-ledger-opencode.js     # 发布件：OpenCode native plugin（打包产物）
  sdd-review-rules.md               # 运行时可定制的评审规则（动态读取，不打包）
  src/
    core/                           # 纯逻辑，无平台依赖，可单测
      hash.js                       #   hashElement（整文件 sha256→前16hex）
      paths.js                      #   normalizeKey/rel/resolveFile（移植）+ sanitizePath（R2：剥控制字符/bidi/换行+截断500，渲染侧消毒）
      classify.js                   #   classifyPath：code | sdd-doc | other
      change-dirs.js                #   discoverChangeDirs + isArchived（移植旧 isArchivedChangeDir）
      scan.js                       #   scanWorkTree（R1：工作树扫描发现 code 候选池；ignore-globs + mtime/size 跳过提示 + 预算）
      blobs.js                      #   （v0.2）已评审内容快照，内容寻址，供精确 since-last-review diff（R1 §5.2）
      ledger.js                     #   load/save/empty + 类型；JSON map（record 增 mtimeMs/size 优化字段）
      todo.js                       #   parseTodo / renderTodo（格式契约 §8.6）
      compute.js                    #   computeNeedsReview（Layer A+B，纯函数）
      ingest.js                     #   ingestCheckoffs（勾选→verdict，哈希钉选）
      locks.js                      #   acquireFileLock/releaseFileLock（移植）
      atomic.js                     #   writeTextAtomic（移植，砍非原子 fallback；R2：保留 rename 的 EEXIST/EPERM unlink-retry，Windows 必需）
      state-dir.js                  #   stateDir/findRepoRoot（R1：多标记 .git/sdd/package.json/...，不要求 git）
      session-key.js                #   resolveSessionKey（R2：CC/OpenCode session_id + transcript hash + repoRoot hash 多级回退；节流维度会话键，与账本 per-project 正交）
      prompts.js                    #   system-reminder 模板（snapshot 契约；R2：fact-forcing 化 + sanitizePath path）
      config.js                     #   env 开关（含 R1 的 SCAN_*/IGNORE/BOOTSTRAP_THRESHOLD；R2：isDisabled() 总开关 SDD_REVIEW=off）
      diagnostics.js                #   JSONL 诊断日志（移植）
    pipeline.js                     #   单次运行编排：acquire→ingest→capture→compute→render→write→deliver
    handlers/
      on-edit.js                    #   PostToolUse / tool.execute.after：捕获 + 投递
      on-prompt.js                  #   UserPromptSubmit：carry-over；OpenCode chat.message 只做批次边界/诊断
      on-precompact.js              #   PreCompact：注入 pending 摘要
      on-stop.js                    #   Stop / idle：best-effort + 刷新 todo
      cli.js                        #   sdd-review status / init
    adapters/
      claude-code/command-hook.js   # entry：读 stdin event → 调 handlers → 写 stdout
      opencode/native-plugin.js     # entry：监听 tool.execute.before/after / chat.message / session.idle
```

**移植自旧实现的原语**（已读源、行为已知，直接改名复用）：
- `locks.js`：`acquireFileLock(target,{staleMs,waitMs,retryMs=25})`（O_EXCL `wx` + 有界重试 + stale-mtime 反捕）/ `releaseFileLock`。
- `state-storage.js` 的 `writeTextAtomic`（tmp+`renameSync`）→ 拆进 `atomic.js`，**删掉其 rename 失败后的非原子 `writeFileSync` 降级分支**（§5.2 决策；rename 失败 = 保留 tmp + 本轮放弃写）。**但保留 rename 的 EEXIST/EPERM unlink-retry（R2 #3b，与砍非原子 fallback 正交）**：移植 GateGuard `saveState` 174-187 的"EEXIST/EPERM → unlink 旧文件 → 重试一次 rename"。否则 Windows 覆盖写每次抛 EEXIST → fail-open 跳过写 → 账本永停初始态 = **系统性误判成"已评审"（false-clean）**（不是无害地丢一次）。
- **新增 `session-key.js`（R2 #2）**：移植 GateGuard `resolveSessionKey`（hook 79-96）+ `sanitizeSessionKey`（长度/字符净化）。候选：CC/OpenCode `session_id` 字段 → `CLAUDE_SESSION_ID` → transcript path hash → repoRoot hash 保底。**节流（§9.3）依赖它**：§七 `ctx.sessionId` 此前未定义来源，空键串台或每次不同键都会让节流失效。
- **`paths.js` 增 `sanitizePath`（R2 #8）**：移植 GateGuard hook 245-255（剥 ASCII 控制字符 + bidi override + 换行，截断 500）。
- **`config.js` 增 `isDisabled()`（R2 #1）**：移植 GateGuard hook 49-59 的 `normalizeEnvValue` + `ECC_DISABLE_VALUES` 集合（`0/false/off/disabled/disable`），读 `SDD_REVIEW` / `SDD_REVIEW_DISABLED`。
- `stateDir/findNearestGitDir` → **`findRepoRoot`**（R1）：状态目录定位（目录名由 `sdd-drift-hook-state` 改为 `sdd-review-ledger-state`）。`.git` 仅作 repo-root 标记之一（与 `sdd/`、`package.json`、`pyproject.toml`、`go.mod`、`Cargo.toml` 并列），**无 git 仓库也能定位**；不读 git 状态。
- `paths.js`、`diagnostics`、`change-dir/archived` 检测、`file-classifier`（扩展名→是否 code）。
- **新增 `scan.js`（R1）**：复用 sibling `project-state.js`/`hydration.js` 的 `readdirSync` walk 模式实现 `scanWorkTree`（取代已删的 `git.js`）。

---

## 三、核心概念与唯一不变量

- **element（被追踪的文件）**：一个文件路径（相对 repo 根、posix 归一化）。两类：`sdd-doc`（change-dir 下的 `proposal/design/tasks.md`）与 `code`（其余源文件）。**粒度=整文件**（#2/#13#3）。
- **obligation（待评审项）**：派生概念，不持久化。= "某 element 当前哈希 ≠ 账本里它的 `reviewedHash`"。即"它变过、还没被显式评审过当前版本"。
- **verdict（评审结论）**：一条显式 ack，绑定到那一版内容的哈希。由勾选产生（§8）。
- **ledger（评审记录，即 ledger）**：`path → record` 的 JSON map（§五）。

> **唯一不变量**：`needsReview(element) ⇔ hash(element) ≠ ledger[element].reviewedHash`。这是 `(工作树, 账本)` 的纯函数。工具只回答这个**机械**问题；"变了要不要改 / 改哪 / 归到哪个 change-dir"全部是 LLM 在推送时的**语义**判断。

---

## 四、运行时产物与位置

| 产物 | 位置 | checked-in | 角色 |
|---|---|---|---|
| `ledger.json` | `<nearest .git>/sdd-review-ledger-state/`（保底 `<cwd>/.sdd-review-ledger-state/` → `%TEMP%/`） | **否**（gitignore） | 机器真相源 |
| `.sdd-review-todo.md` | repo 根 | **否**（gitignore） | 人可见保底 + ack 入口 |
| `sdd-review.log.jsonl` | state 目录 | 否 | 诊断 |

**硬规则（§5.2）**：`ledger.json` 与 `.sdd-review-todo.md` 的 git track 状态必须一致。`init` 同时把两者写入 `.gitignore`；启动时检测 `todo tracked XOR ledger tracked` → 诊断告警（不阻断）。v0.2 团队模式才允许两者一起 commit（届时账本升 JSONL+并集）。

---

## 五、数据模型

### 5.1 Ledger

```jsonc
{
  "version": 1,
  "records": {
    // key = repo 相对 posix 路径
    "src/greet.ts": {
      "kind": "code",                 // "code" | "sdd-doc"
      "reviewedHash": "a1b2c3d4e5f60718",   // 16-hex sha256 前缀；null = 追踪中但从未评审
      "verdict": "synced",            // "synced"|"no-change"|"unrelated"|null；仅展示
      "rationale": "按新增行为更新了 design",  // ≤200 字符，原样存，不解析
      "reviewedAt": "2026-05-30T10:00:00Z",
      "by": "agent"                   // "agent"|"user"
    },
    "sdd/changes/greeting/design.md": { "kind": "sdd-doc", "reviewedHash": "d4e5f6...", "...": "..." }
  }
}
```

- `code` 记录由**捕获**写入（首见 reviewedHash=null）；`sdd-doc` 记录由**勾选**或捕获写入（doc 本就靠 change-dir 扫描发现，不依赖捕获）。
- **有界**：`records` 中 `code` 项受 LRU 上限约束（默认 1000，`SDD_REVIEW_LEDGER_CODE_CAP`，按 `reviewedAt` 淘汰最旧的已评审项；从不淘汰待评审项）。
- 损坏自愈：解析失败 → 当空账本（删重建）。

### 5.2 NeedsReviewItem（computeNeedsReview 输出，瞬态）

```jsonc
{ "path": "src/greet.ts", "kind": "code", "currentHash": "9f3a...",
  "candidates": ["sdd/changes/greeting", "sdd/changes/refund"],  // 候选 change-dir（doc 项=自身 dir；code 项=全部未归档 dir）
  "reason": "never-reviewed" }   // "never-reviewed" | "changed-since-review"
```

### 5.3 TodoEntry（parseTodo 输出）

```jsonc
{ "checked": true, "path": "src/greet.ts", "inlineHash": "a1b2c3d4e5f60718", "rationale": "仅 gofmt，无需改文档" }
```

---

## 六、核心纯函数（签名 + 伪代码）

所有 core 函数**无副作用、可单测、任意触发点同一输入同一输出**。

### 6.1 hashElement

```
hashElement(absPath) -> string | null
  if !exists(absPath): return null
  return sha256(readFileBytes(absPath)).hex().slice(0,16)   // 整文件；16-hex 前缀
```
整文件哈希（§13#3）：标题/段落/格式怎么变都只是"这个文件变了"，零锚点纪律。对 markdown 与 code 一致处理。

### 6.2 discoverChangeDirs

```
discoverChangeDirs(repoRoot) -> ChangeDir[]
  dirs = glob(repoRoot, "{sdd,.sdd}/changes/*/")
  return dirs.filter(d => !isArchived(d)).map(d => ({
    relDir, docs: existing(d, ["proposal.md","design.md","tasks.md"]),
    designFirstLine: firstNonEmptyLine(d/"design.md")   // 推送摘要用
  }))
```
`isArchived` 移植旧 `isArchivedChangeDir`（目录名/标记文件/`status: archived`）。

### 6.3 computeNeedsReview（Layer A + Layer B）— 纯函数核心

```
computeNeedsReview(repoRoot, ledger) -> NeedsReviewItem[]
  needs = []
  changeDirs = discoverChangeDirs(repoRoot)

  // —— Layer A + 反向：doc 元素（靠扫描发现，不依赖捕获）——
  for dir in changeDirs:
    for docName in ["design.md","tasks.md","proposal.md"]:
      p = dir.relDir + "/" + docName
      if not exists(p): continue
      h = hashElement(abs(p))
      if h != ledger.records[p]?.reviewedHash:
        needs.push({path:p, kind:"sdd-doc", currentHash:h,
                    candidates:[dir.relDir], reason: ledger.records[p] ? "changed-since-review":"never-reviewed"})

  // —— Layer B：code 元素 —— 候选池 = (账本追踪的 code) ∪ (工作树扫描出的 code 文件)  ← R1：去 git
  scan = scanWorkTree(repoRoot, ledger)        // R1：文件系统真相，与 commit 无关；mtime 仅作跳过 re-hash 的提示
  codePaths = union(
    keys(ledger.records).filter(k => ledger.records[k].kind=="code" && exists(k)),
    scan.codePaths                              // 捕获保底：shell 写/未捕获子代理编辑、且**已 commit 也照抓**（在盘上即可见）
  )
  nonArchived = changeDirs.map(d=>d.relDir)
  for p in codePaths:
    if not exists(p): continue                     // 删除 → 不再追踪（§十三 边界）
    h = hashElement(abs(p))
    if h != ledger.records[p]?.reviewedHash:        // 无记录视为 reviewedHash=undefined ≠ h
      needs.push({path:p, kind:"code", currentHash:h,
                  candidates: nonArchived, reason: ledger.records[p] ? "changed-since-review":"never-reviewed"})
  if scan.truncated: needs.meta = { scanTruncated:true, skipped:scan.skipped }   // R1：超预算非静默
  return needs
```

**关键设计点：**
- doc 与 code 的**触发都是 per-element 哈希比对**——doc 变了产生"评审下游"义务，code 变了产生"评审 doc"义务。受影响的对应文件**不在此枚举**，留给推送时 LLM 读当前内容（v0.2 +快照 diff）圈定（§6.4 obligation 模型，防 N-fold）。
- code 候选池并入 `scanWorkTree`（R1，取代 `gitChangedFiles`），从而恢复 `computeNeedsReview` 作为 `(工作树,账本)` 真·纯函数的不变量、并让 commit 之后漏捕获的文件仍重新出现在待评审清单。理由（commit 边界为何破坏纯函数）见架构 §7.4 / R1 §3-§4。残余仅剩"不在被扫描位置"（被 ignore-glob 排除 / 扫描预算截断尾部，两者皆有日志、非静默，R1 §4.4/§8）。

### 6.4 parseTodo / renderTodo（格式契约 §8.6）

```
parseTodo(text) -> TodoEntry[]
  对每行匹配 /^- \[( |x)\] (\S+)@([0-9a-f]+)(?: — (.*))?$/
  命中 → {checked: $1=="x", path:$2, inlineHash:$3, rationale:$4||""}
  不命中 → 跳过（不解析 NL、不猜测）
```
```
renderTodo(needs, ledger) -> text
  头部一行："只在「待评审」区把已完成评审的行原地从 [ ] 改为 [x]；不要移动、复制或改写 path@hash。"
  "## 待评审"：needs 每项 → `- [ ] <sanitizePath(path)>@<currentHash>  (候选: <candidates>)`   // R2 #8 渲染侧消毒
  "## 审计历史（只读，勿编辑）"：ledger 中 hash==reviewedHash 的项，按 reviewedAt 取近 N（默认 50）
                              → `- [x] <sanitizePath(path)>@<reviewedHash> — <rationale><thinMark?>`
  // R2 #4b：thinMark = 当 rationale 过简（如纯"无关"/"ok"/空）时追加可见标记"（理由过简，建议补充）"
  //         ——纯展示，不影响清除、不做语义校验（守 §8.2 机械可观测 + §7.3 不解析 NL）
```
渲染**幂等**：同 (needs, ledger) → 同字节（排序固定，按 path 字典序）。`sanitizePath` 与 thinMark 都是**纯函数 of 输入**，不破坏幂等。

### 6.5 ingestCheckoffs（勾选 → verdict，哈希钉选 §5.3）

```
ingestCheckoffs(ledger, todoEntries, now, actor) -> ledger'   // 纯函数，返回新账本
  for e in todoEntries where e.checked:
    if classifyPath(e.path) == "other": continue          // 非追踪元素，忽略
    ledger'.records[e.path] = {
      kind: classifyPath(e.path),
      reviewedHash: e.inlineHash,        // ★ 钉死内联哈希，不是当前哈希（防跨版本 false-clean）
      verdict: labelFromRationale(e.rationale) || "reviewed",
      rationale: clamp(e.rationale, 200),
      reviewedAt: now, by: actor
    }
  return ledger'
```
**编辑从不在这里清除**（checkoff-only，§8.2）：本函数只处理 `[x]`；agent 编辑 doc/code 只改哈希，由后续它自己的勾选清除。

---

## 七、运行管线（单次 run 编排）

`pipeline.run(ctx)` —— 所有 handler 的公共主干。`ctx = {repoRoot, event, editedPath?, sessionId, actor, runtime}`。

```
run(ctx):
  try:
    if isDisabled(): return SILENT                                         // R2 #1：逃生阀总开关 SDD_REVIEW=off / SDD_REVIEW_DISABLED=1，第一行短路
    if not isSddProject(ctx.repoRoot) and ledgerEmpty(): return SILENT     // 非 SDD 项目：静默退出
    lock = acquireFileLock(ledgerPath, {waitMs:500, retryMs:25, staleMs:30000})
    if !lock:
      // fail-open：拿不到锁 → 只读重算 + 投递，跳过写，ingest 推迟下轮（§5.2）
      ledger = loadLedger(readOnly=true)
      needs  = computeNeedsReview(ctx.repoRoot, ledger)
      return deliver(needs, ctx)
    try:
      ledger = loadLedger()                                   // 损坏 → 空账本自愈
      ledger = ingestCheckoffs(ledger, parseTodo(readTodo()), now(), ctx.actor)   // INGEST 必须先于 render
      if ctx.editedPath and classifyPath(ctx.editedPath)=="code":
        trackCodePath(ledger, ctx.editedPath)                 // 捕获：确保被追踪（不覆盖已有 reviewedHash）
      needs = computeNeedsReview(ctx.repoRoot, ledger)
      writeTextAtomic(ledgerPath, JSON.stringify(ledger))     // 原子；rename 失败→保留 tmp 放弃写
      writeTextAtomic(todoPath, renderTodo(needs, ledger))
    finally:
      releaseFileLock(lock)
    return deliver(needs, ctx)
  catch e:
    diag(e); return SILENT                                    // NFR：永不抛给用户
```

**次序铁律**：INGEST → CAPTURE → COMPUTE → WRITE → DELIVER。ingest 先于 render（写 todo）防止重渲染冲掉刚勾的框（§5.3）。

**`ctx.sessionId` 的来源（R2 #2）**：经 `core/session-key.js` `resolveSessionKey(event)` 解析（多级回退，§二），**绝不**直接信任单一字段。它是可选提醒上限与诊断状态的会话键，**与账本的 per-project 持久正交**——账本不按 session 分。空键串台会让可选上限跨会话误合并；每次不同键会让可选上限形同虚设。**逃生阀（R2 #1）**：`run` 第一行 `isDisabled()` 短路，先于一切（含 `isSddProject` 与锁），保证"嫌吵或在做无关重构"的用户能一键整程静默——"永不阻断"治不了"持续投递 + 持续重写 todo + 持续扫全树"的噪音，逃生阀正是它的补集。

**init / auto-baseline（冷启动，§9 架构 + R1 §6.1）**：`sdd-review init` 扫描当前工作树所有 change-dir 的 doc + **`scanWorkTree` 扫出的全部 code（R1：不再依赖 git「已变更」）**，把它们的当前哈希**全部写为 reviewedHash（verdict=`bootstrap`，并记 mtimeMs/size）**、不触发评审 → 避免存量 repo 满屏"待评审"。同时写两行 `.gitignore`。
- **auto-baseline 升为正式机制（R1 关键依赖）**：**首次 compute 遇「账本空 且 扫到 ≥ `SDD_REVIEW_BOOTSTRAP_THRESHOLD`（默认 1）个既有文件」即自动执行上述 baseline**、本轮不刷屏，并在 todo 头 + 日志注明"已对现有 N 个文件建立 baseline（未回溯评审）"。不能仅靠显式 `init`——多数 vibe 用户不会先跑 init。为什么去 git 后 auto-baseline 升为关键依赖，详见 R1 §6.1。
- 这是一次诚实标注的静默 baseline（"不回溯存量"，非"已验证"）。

---

## 八、捕获层

- 监听**写**工具：`Edit` / `Write` / `MultiEdit`（CC）、`edit`/`write`/`patch` 等（OpenCode `tool.execute.after`）。**不监听 Read**（§8.3）。
- 对 `editedPath` 调 `classifyPath`：
  - `sdd-doc`（change-dir 下 proposal/design/tasks.md）→ 不需特别记账（compute 时扫描发现）；它触发一次 run（→ 投递/刷新 todo）。
  - `code`（源扩展名，移植旧 file-classifier：含 html/css/js/ts/各框架/常见后端扩展，前端单文件原型如 `index.html` 也算）→ `trackCodePath`（首见 reviewedHash=null）。
  - `other`（lockfile/二进制/非源文件）→ 忽略。
- **不依赖捕获 100%**：compute 的 code 候选池并入 `scanWorkTree`（§6.3，R1 取代 git），捕获只是"即时性优化"，丢了由**工作树扫描**保底（与 commit 无关，已 commit 也照抓）。

---

## 九、投递层

### 9.1 主通道 = 编辑时工具结果（§6.3 / §7.1）

handler `on-edit` 在 run 之后，若 `needs` 非空且未超节流，**返回**一段 `<system-reminder>` 文本，由适配器挂到**这次编辑的工具结果**上（CC: PostToolUse 输出；OpenCode: append 到 `tool.execute.after` 的 output）。编辑时即送达，不依赖后续工具调用，不押 Stop。

### 9.2 system-reminder 提示契约（`prompts.js`，snapshot 测试）

**模板已按 fact-forcing 重写（R2 #4）。** 新模板要求**先并排产出具体事实、再下 verdict**——把"调查"从可跳过的建议变成"裁决"的前置步骤（虽无拦截（DENY）强制力，但显著抬高走过场盖章的最省力出口）。为何旧模板是变相自评、为何这么改，详见 R2 #4 / 架构 §7.5。

```text
<system-reminder>
[SDD-REVIEW: NEEDS-REVIEW]

CHANGED (未评审，本批):
  - src/greet.ts        (候选 change-dir: greeting, refund)
  - sdd/changes/greeting/design.md

REVIEW（你是唯一语义裁判；下结论前必须先取证，不接受裸判断）:
  对每一项，先读当前内容，再按此结构给出事实，最后才下 verdict：
    1. design/tasks 此刻声称什么（引用具体一句/一段）
    2. code 此刻实现什么（引用具体函数/行为）
    3. 二者是否一致（指出冲突点，或写"经对照无冲突"）
    4. verdict：需改 → 直接编辑对应 design/tasks（这本身是同步动作）；
                无需改（纯重构/格式化/无关）→ 在 .sdd-review-todo.md 勾掉，理由须含上面第 3 步的依据
  （Layer A 纯文档对纯文档：第 2 步替换为"另一篇 doc 此刻声称什么"，不强求 importer 式取证。）
  规则见 sdd-review-rules.md（§归属评审规则）。

ACTION: 完成上述后回到用户原始任务。无论编辑还是勾选，最终都需在 .sdd-review-todo.md 勾掉你评审过的每一项（编辑文件不自动清除）。
</system-reminder>
```
- 含**候选 change-dir + design 首行摘要**（§6.4 受影响的对应文件交 LLM 圈定）。
- 指示 LLM **读取列出文件的当前内容**自行定位段落（R1：去 git diff；整文件粒度"损失的段定位"由 LLM 读当前内容补回，v0.2 起 + 已评审内容快照 diff 给"自上次评审"的精确基线，R1 §5）。
- **fact-forcing（强制先取证再下结论）限定（R2 #4）**：① **Layer B（code↔doc）全力取证**，Layer A 纯文档对纯文档退化为"引用两篇 doc 互相矛盾/相关的两句"，**不强加 importer 式取证**（那正是 GateGuard 误伤文档的复刻）；② 默认每次相关编辑都投递重模板，原因是漏审比多提醒更危险；③ **诚实标注增益上限**：这只降低走过场盖章的"最省力出口"，**绝不复制 DENY 的强制力、增益不量化**，且结构性远低于 GateGuard 的 +2.25（真正起作用的部分来自强制、非措辞，见架构 §10#9）。
- 评审规则从 `sdd-review-rules.md` 动态加载（移植旧规则文件机制），缺失则内置默认。
- 该段做**字节级 snapshot 测试**（契约稳定性）。path 拼接前过 `sanitizePath`（R2 #8，渲染侧消毒）。

### 9.3 主动提醒策略（#5 更新）

- **默认无 session/批次上限**：每次相关 code / SDD-doc 编辑后，只要 `needs` 非空，就可把 fact-forcing 提醒追加到本次工具结果。真实长任务里，漏掉后半程重要变更比多提醒更危险。
- **相同 pending 短窗口去重**：若并发/连续工具写入导致同一个 `path@hash` 集合在极短时间内重复出现，只投递一次，避免同一段提醒在同一批 multi-write 中复制刷屏。默认窗口 `SDD_REVIEW_REMINDER_DEDUPE_MS=2000`。
- **会话维度按 `core/session-key.js` 分桶（R2 #2）**：见 §七；仅用于可选硬上限和诊断状态，账本仍是 per-project 持久。
- **插件状态文件不自触发**：编辑 `.sdd-review-todo.md` / ledger 等 housekeeping 文件只做 ingest + 刷新，不主动再提醒，避免模型勾选后被自己的勾选动作再次打扰。
- **可选硬上限**：`SDD_REVIEW_SESSION_MAX_REMINDERS=N` 可限制单会话主动提醒次数；默认不限制。设 `0` 可把主动提醒完全关掉、纯靠 todo。
- **被动 todo 无限留存**：每次 run 都刷新 `.sdd-review-todo.md`，从不因节流而丢项。
- 整程静默另见逃生阀总开关 `SDD_REVIEW=off`（R2 #1，比 `0` 更彻底：连 todo 重写/扫描都停）。

### 9.4 carry-over / 保底

- `on-prompt`（Claude Code `UserPromptSubmit`）：新会话/下一轮首事件 → 若 `needs` 非空，注入紧凑 carry-over 摘要（跨会话不丢，因账本持久）。
- OpenCode `chat.message`：只打开新批次并记录 carry-over 状态，**不改写消息输出**；OpenCode 1.2.27 对 `chat.message` 输出 schema 校验严格，改写消息结构会导致运行失败。模型可见主通道仍是下一次 `tool.execute.after`，人可见兜底是 `.sdd-review-todo.md`。
- `on-precompact`：压缩前注入 pending 摘要。
- `on-stop`（Stop / idle）：best-effort 提醒；**始终先刷新 todo + 诊断日志**，保证 continuation 失效时用户仍可见（移植旧 refreshReport 思路）。

---

## 十、双平台投递矩阵（#6 已定）

| 能力 | Claude Code command hook | OpenCode native plugin |
|---|---|---|
| 编辑捕获 | `PostToolUse`（可靠） | `tool.execute.after`（可靠，转换得来） |
| **主投递**（编辑时提醒） | PostToolUse stdout / additionalContext | **append 到 `tool.execute.after` 的 output**（OpenCode 最可靠模型可见通道） |
| 下一轮 carry-over | `UserPromptSubmit` | `chat.message` 只记录/重置批次，不改写消息；下一次 `tool.execute.after` 再投递 |
| 压缩保底 | `PreCompact` | （无则跳过） |
| Stop continuation | `Stop` hook（可用） | `session.idle` / idle `session.status`（**best-effort，不可靠**） |
| shell 写 / 未捕获子代理 | compute 时 `scanWorkTree` 保底（R1：已 commit 也照抓） | 同左（`src/core` 逐字节复用） |
| todo 人可见保底 | 始终写 | 始终写 |

**结论**：两平台**主投递都走编辑时工具结果**，绝不把正确性押在 Stop。OpenCode 的 Stop 仅作 best-effort + todo 刷新。共享 `src/core` + `src/handlers`，仅 `src/adapters/*` 不同（entry 形态 + 事件转换）。

---

## 十一、代码元素粒度（#2 已定）

- **v1 = 文件级整文件哈希**（与 §13#3 doc 决策同逻辑）。同文件多关注点 → 改无关函数也触发 → 但这是**无害的多提醒一次**（LLM 一句"无关"勾掉），非有害结论（§7.3）。
- **不预先上 AST/函数级**。仅当 §十二 误报对账实测出文件级的多提醒一次比率痛到不可接受时，才在**投递层**（不是账本层）用**已评审内容快照 diff**（R1 §5.2，非 git diff）的 hunk 把"只把变更段喂给裁判"作 token 优化；触发/记账永远文件级。为何不预先上 AST，详见架构 §13#2。

---

## 十二、测试与验收

### 12.1 纯函数单测（core，无 IO）
- `hashElement`：同字节同哈希；格式化/重排改字节 → 改哈希（确认是良性触发源，非 bug）。
- `computeNeedsReview`：Layer A（doc 变→待评审）、Layer B（code 变→待评审）、never-reviewed vs changed-since-review、**scan 候选并入（R1）**、删除文件不报。**同输入任意次同输出**（R1：去 git 后此决定性才真正成立）。
- `scanWorkTree`（R1 新增）：ignore-glob 命中跳过；mtime/size 命中 → 复用账本哈希、不读文件；mtime 变 → 重哈希；超预算 → `truncated=true`+`skipped`。
- **commit 不变性（R1 核心回归）**：写 X 不经捕获 → 重新出现在待评审清单；`git commit` 后再 compute → **仍出现 X**（v0.1 git 版会消失）；无 git 仓库同样出现。
- `parseTodo`：合法行解析；畸形行跳过；`[x]/[ ]`、`@hash`、理由提取。
- `ingestCheckoffs`：勾选钉**内联哈希**（非当前哈希）；重复勾选幂等；非追踪路径忽略。
- `renderTodo`：幂等、字节稳定、排序固定；**R2：裸理由 thinMark 纯展示且不影响清除、不破坏幂等**。
- `prompts`：**字节级 snapshot**（契约稳定；R2：fact-forcing 重模板的新 snapshot）。
- **`sanitizePath`（R2 #8）**：剥控制字符/bidi override/换行 → 空格、截断 500；含 bidi/换行的恶意路径不污染 todo 与提示。
- **`session-key.js` `resolveSessionKey`（R2 #2）**：多级回退链——有 `session_id` 用之；缺失退 transcript hash；再缺退 repoRoot hash；长键/含非法字符走 `sanitizeSessionKey` 哈希；同输入稳定同键、不同输入不串台。
- **`config.isDisabled()`（R2 #1）**：`SDD_REVIEW=off`/`SDD_REVIEW_DISABLED=1`（含 `0/false/off/disabled/disable` 集合）→ true；未设/其他值 → false。

### 12.2 协调/管线测（有 IO，临时 repo）
- **ingest-before-render**：勾完一项后下一次 run → 该项落"已评审"、不被重渲染冲回。
- **哈希钉选防 false-clean**：勾 `path@H1` 后文件改成 H2 → 仍待评审（H2 ∉ verdict）。
- **编辑不清除（checkoff-only）**：编辑 doc 同步后，code 项仍待评审，直到显式勾掉。
- **冷启动 init**：500 文件存量 repo → init 后 0 待评审；此后改一个文件 → 仅它待评审。
- **gitignore 一致性**：`todo tracked XOR ledger tracked` → 告警。

### 12.3 并发/崩溃测
- 双进程（模拟父+子代理）并发写 → FsLock 串行化；落败者 fail-open 跳过、下轮补；**断言无损坏、无 false-clean**（最坏丢一条 ack → 重审，安全侧）。
- 写中途 kill → tmp/rename 原子性：读者只见旧或新完整账本；损坏账本 → 自愈当空。
- **Windows rename unlink-retry（R2 #3b）**：模拟 `renameSync` 抛 EEXIST/EPERM（目标已存在）→ 断言 `atomic.js` unlink 旧文件后重试成功、账本被更新（**回归靶**：不修则 Windows 覆盖写恒失败 → 账本永停初始态 = 系统性 false-clean）。
- **逃生阀（R2 #1）**：`SDD_REVIEW=off` → `run` 第一行 SILENT、不写任何文件、不扫描。
- **默认重复提醒**：同一 session 一个 turn 内 4 个相关 `on-edit` 到达 → 4 次工具结果都可携带提醒；todo 含全部最新 needs。若项目嫌吵，用 `SDD_REVIEW_SESSION_MAX_REMINDERS` 或 `SDD_REVIEW=off` 降噪。

### 12.4 误报对账（一等验收，对应"不误报"）
构造真实编辑序列并断言**不产生有害错误结论**（只允许良性"请评审"提示、可一句勾掉）：① 多关注点文件改无关函数；② 全仓 gofmt；③ design 段润色/重组；④ design-first 改后 code 跟进（反向偏差被端出）；⑤ 子代理 / shell 写**后 commit**（R1：scan 保底捕获，直接覆盖 §3.2 commit 洞）。并与旧 mtime 方案在同序列上对账误报数。

### 12.5 旅程用例（J1–J16 作回归）
架构 §11：J1–J16 期望行为统一简化为"该评审的有没有被可靠端出、且能被显式勾选清除而不再刷屏"。逐条转成 e2e（双平台 × 真实模型，沿用 sibling 的 e2e 矩阵骨架）。

---

## 十三、边界与失败模式

| 场景 | 处理 |
|---|---|
| 非 SDD 项目（无 change-dir 且账本空） | 静默退出，不写任何文件 |
| Hook 异常 | `catch → SILENT`，永不抛给用户（NFR fail-open） |
| 账本损坏 | 解析失败 → 当空账本（删重建），最坏重判一轮 |
| 锁拿不到 | fail-open 跳过写、只读投递，ingest 推迟下轮 |
| 文件被删 | computeNeedsReview 跳过不存在路径；账本可保留陈旧记录（LRU 自然淘汰），不报 ORPHAN（v0.1 不引入 ORPHAN 态，避免治理盲区） |
| 跨段 false-clean | 整文件粒度代价：勾掉整 doc 连带清同文件未评审别段。处理：投递含完整 diff，硬化留到 v0.2、不引入段级锚点纪律（见架构 §10#6 / R1 §5.2） |
| ack 延迟一轮 | 锁争用或勾选落临界区后 → 延迟一轮出现；todo 持久不丢，头部注"勾选下次运行生效"管理预期（见架构 §10 / §5.3） |
| 网络/同步盘（NFS/Dropbox） | rename/O_EXCL 原子性不保证 → 靠损坏自愈保底（见架构 §10） |
| 不在被扫描位置的 code 写（ignore-glob 排除 / 扫描预算截断尾部） | 残余只剩"压根没扫到"，有日志、非静默，可经 `SCAN_ROOTS`/`IGNORE` 调（见架构 §10 / R1 §4.4/§8） |
| 扫描超预算（巨型 monorepo） | `SDD_REVIEW_SCAN_BUDGET_MS` 截断 → `truncated`+`skipped`，投递/todo 头/日志告警，下轮继续（见架构 §10 / R1 §4.4） |
| 内容变但 mtime 未变（极罕见） | scan 跳过提示漏；会话内编辑走捕获直哈希不受影响；`SDD_REVIEW_SCAN_ALWAYS_HASH=1` 可关优化（见架构 §10 / R1 §4.3） |

---

## 十四、配置开关（env）

| 变量 | 默认 | 作用 |
|---|---|---|
| `SDD_REVIEW_SESSION_MAX_REMINDERS` | 无上限 | 可选每会话主动提醒硬上限；`0`=纯靠 todo |
| `SDD_REVIEW_REMINDER_DEDUPE_MS` | `2000` | 相同 pending 集合短窗口去重；`0`=不去重 |
| `SDD_REVIEW_LEDGER_CODE_CAP` | `1000` | 账本 code 记录 LRU 上限 |
| `SDD_REVIEW_RULES_FILE` | — | 覆盖 `sdd-review-rules.md` 路径 |
| `SDD_REVIEW_LOG` / `SDD_REVIEW_LOG_PATH` | on / state 目录 | 诊断日志开关/路径 |
| `SDD_REVIEW_HASH_LEN` | `16` | element 哈希 hex 前缀长度 |
| `SDD_REVIEW_IGNORE` | — | 追加扫描忽略 glob（逗号分隔）（R1 §4.2） |
| `SDD_REVIEW_SCAN_ROOTS` | repo 根 | 限定只扫某些子树（逗号分隔）（R1 §4.2） |
| `SDD_REVIEW_SCAN_BUDGET_MS` | `1500` | 单次扫描时间预算；超出 → 截断 + 告警（非静默）（R1 §4.4） |
| `SDD_REVIEW_SCAN_ALWAYS_HASH` | `0` | `1`=禁用 mtime 跳过、永远全哈希（R1 §4.3） |
| `SDD_REVIEW_MAX_FILE_BYTES` | `2 MiB` | 超此大小的文件不扫（R1 §4.2） |
| `SDD_REVIEW_BOOTSTRAP_THRESHOLD` | `1` | 空账本扫到 ≥N 个既有文件即 auto-baseline（R1 §6.1） |
| `SDD_REVIEW` / `SDD_REVIEW_DISABLED` | — | **逃生阀总开关（R2 #1）**：`off`/`0`/`false`/`disabled`/`1` → `run` 第一行整程静默（比 `SESSION_MAX_REMINDERS=0` 更彻底：连 todo 重写/扫描都停）。移植 GateGuard `ECC_GATEGUARD` 语义 |

---

## 十五、实现里程碑（build order）

1. **M1 core 纯函数 + 单测**：hash / classify / change-dirs / ledger / todo(parse+render) / compute / ingest。无 IO，先把不变量与误报对账（§12.1/§12.4）跑绿——这是核心赌注的证伪点。
2. **M2 管线 + 并发/原子**：pipeline.run + locks + atomic + state-dir + init；§12.2/§12.3 跑绿。
3. **M3 Claude Code 适配器 + 投递**：on-edit / on-prompt + prompts + 节流；Claude Code 端到端。
4. **M4 OpenCode 适配器（已实现）**：native-plugin（tool.execute.before 参数缓存 + tool.execute.after 主投递 + chat.message 批次边界/诊断 + idle 被动刷新）。
5. **M5 双平台真实模型 e2e（J1–J16）+ 文档硬化**。

每个里程碑独立可验证；M1 通过即证伪/证实核心赌注，再决定是否继续。

---

## 十六、MVP 切割（v0.1 首发范围）

> 本节定义**第一个可发布、可在真实 vibe coding 回路里跑**的最小产品，并逐条说明每个"砍掉"为何**只砍能力、不砍核心赌注的正确性**。当前 MVP = §15 的 **M1+M2+M3+M4**（Claude Code + OpenCode 双入口）；M5 与 §十七 后置。
>
> **引用约定**：本节裸 `§x` 指**本文**；引用架构文档一律写 `架构 §x`（因两文档存在同号子节，如 §5.3/§6.3/§6.4，必须区分）。

### 16.1 MVP 要验证的核心赌注（窄化自 架构 §12）

> **「需评审 = (工作树, 账本) 的纯函数」+「判断全外包给 LLM」，在 Claude Code / OpenCode 真实编辑回路里，能不静默漏报、不有害误报地辅助评审。**

先用 Claude Code 启动、再补 OpenCode adapter 的理由：`src/core` 平台无关、两平台复用同一套 ledger/todo 核心，核心赌注与平台正交；OpenCode 只加薄适配器，`src/core` 零改动。

### 16.2 范围 IN（MVP 必须有）

逐项是 §二 结构的子集 + §15 的 M1–M4：

| 模块 / 能力 | 落点 | 为何不可砍 |
|---|---|---|
| 内容哈希 + 极简账本（JSON map load/save/empty） | §五 / `core/{hash,ledger}.js` | 唯一不变量（§三）的状态基础 |
| `computeNeedsReview`（Layer A+B，纯函数） | §6.3 / `core/compute.js` | **核心赌注本体**；M1 证伪点 |
| `parseTodo`/`renderTodo` + `ingestCheckoffs`（哈希钉选、ingest-before-render） | §6.4/§6.5/§七 | 唯一清除信号 + 防丢勾选 + 防跨版本 false-clean |
| change-dir 发现 + archived 过滤 + 路径分类 | §6.2 / 移植 `file-classifier`+`isArchivedChangeDir` | Layer A/B 的触发输入 |
| 管线（acquire→ingest→capture→compute→write→deliver）+ FsLock + 原子写 + state-dir | §七 / 移植 `locks`+`atomic`+`state-dir` | 单次 run 主干；并发失败安全 |
| `init` + **auto-baseline**（扫描化，R1）+ 写 `.gitignore` 两行 | §七 / 架构 §9 / R1 §6.1 | 否则存量 repo 满屏"待评审"；去 git 后扫描暴露全仓 → auto-baseline 成关键依赖，必须进 MVP |
| Claude Code 适配器：`PostToolUse`（捕获+编辑时投递）、`UserPromptSubmit`（carry-over） | §九/§十 / `adapters/claude-code` | Claude Code 主投递通道 + 跨会话主动浮出 |
| OpenCode 适配器：`tool.execute.before`（参数缓存）、`tool.execute.after`（捕获+编辑时投递）、`chat.message`（批次/诊断，不改写消息）、idle 被动刷新 | §九/§十 / `adapters/opencode` | OpenCode 主投递通道 + 批次重置 + todo 兜底刷新 |
| `scanWorkTree` 发现 code 候选池（R1，取代 `gitChangedFiles`） | §6.3 / `core/scan.js` | **彻底**关掉子代理/shell 写盲区（含已 commit）；恢复纯函数不变量 → 关键依赖，进 MVP |
| system-reminder 模板（字节级 snapshot） | §9.2 / `core/prompts.js` | 模型可见契约，必须稳定 |
| 默认每次相关编辑提醒、可选会话上限、`sdd-review-rules.md` 默认规则、最小诊断日志、env 开关 | §9.3/§十四 / 移植 | 优先不漏审，同时保留降噪开关 |
| core 单测 + 误报对账 + 少量管线集成测 | §12.1/§12.2/§12.4 | **证伪闸门**（见 16.5） |

### 16.3 范围 OUT（v0.1 明确后置，附"为何安全"）

| 后置项 | 归宿 | 砍掉只损失什么 / 为何不伤核心 |
|---|---|---|
| **PreCompact / Stop handler** | M3 后 fast-follow | 主投递本就**不押 Stop**（架构 §7.1）；跨会话/续跑由"持久 todo + `UserPromptSubmit` carry-over"覆盖（§9.4）。砍掉只少几次 best-effort 主动 nudge，**无正确性损失**。 |
| **账本 code 记录 LRU 上限** | 量化后再加 | 验证期 repo 远不到上限；不加只在超长寿大仓无界增长，属验证后问题。 |
| **熔断器（circuit breaker）** | 诊断见重复异常再加 | 顶层 `try/catch → SILENT`（§七/§十三）已保证 fail-open / 永不抛给用户（NFR）；熔断只优化"持续失败"的重试成本，MVP 用不到。 |
| **团队模式**（checked-in + JSONL + 并集归并） | v0.2（架构 §13#1） | v0.1 本就声明本地 / gitignore（架构 §10#5 诚实标注）。 |
| **跨段 false-clean 硬化** | v0.2（架构 §6.4/§10#6） | 投递含完整 diff 已缓解；残余诚实标注（16.6）。 |
| **函数级 / AST 粒度** | 量化后（架构 §13#2） | 文件级误触发是**良性**（架构 §7.3 / §十一）；只在 §12.4 实测痛时上，且仅投递层。 |
| **双平台 × 真实模型 e2e 矩阵（J1–J16）** | M5 | MVP 以 core 单测 + 管线集成 + 误报对账证伪（§15 M1 即证伪点）；真实模型矩阵是后置硬化。 |

> **MVP 相对详细设计的唯一"减法"是删模块，不是改模型。** 所有 IN 模块的行为与已锁合约（§三 不变量、架构 §7 三关键陷阱、架构 §8 唯一勾选清除）逐字不变——MVP 不放松任何安全属性，只缩小覆盖面。

### 16.4 MVP 代码库（§二 结构的 MVP 子集）

```
src/
  core/   hash · paths · classify · change-dirs · scan · ledger · todo · compute ·
          ingest · locks · atomic · state-dir · prompts · config · diagnostics          ← 全进（R1：git→scan）
          blobs                                                                          ← 后置（v0.2 精确快照 diff）
  pipeline.js                                                                            ← 进
  handlers/  on-edit · on-prompt · cli(init/status)                                      ← 进
             on-precompact · on-stop                                                     ← 后置（M3后/M4）
  adapters/claude-code/command-hook.js                                                   ← 进
  adapters/opencode/native-plugin.js                                                     ← 进
```

发布件：MVP 产 **2 个**：`sdd-review-ledger-hook.js`（Claude Code）和 `sdd-review-ledger-opencode.js`（OpenCode）；`build.mjs` 同时维护两个 entry。

### 16.5 MVP 验收闸门（窄化自 §12；过则可发，不过则停）

1. **纯函数正确性 + 决定性**：Layer A（doc 变→待评审）、Layer B（code 变→待评审、**scan 候选并入**）、never-reviewed vs changed、删除文件不报；同输入任意次同输出。**含 R1 commit 不变性回归**（写后 commit 仍浮出）——去 git 后此决定性闸门才真正可过（§12.1/§9.2）。
2. **三条 false-clean 守卫**：checkoff-only（编辑不清除）、哈希钉选（勾 `path@H1` 后改成 H2 仍待评审）、Read 不清除。（架构 §7.2/§8 / §12.2）
3. **ingest-before-render**：勾完下一次 run → 该项落"已评审"、不被重渲染冲回。（§七 次序铁律 / §12.2）
4. **编辑时投递 + 保底**：CC `PostToolUse` / OpenCode `tool.execute.after` 编辑时即送达；`.sdd-review-todo.md` 每次 run 必写；跨会话经持久账本 + Claude Code `UserPromptSubmit` carry-over / OpenCode 下一次写工具结果重新浮出。（§九 / §12.5 子集）
5. **冷启动不刷屏**：`init` 后 0 待评审；此后改一个文件 → 仅它待评审。（§12.2）
6. **不误报（一等验收）**：gofmt / 多关注点改无关函数 / doc 段润色 → 只产良性"请瞥一眼"、可一句勾掉；与旧 mtime 方案在同序列上对账，误报数下降。（§12.4）
7. **fail-open**：任何异常 → SILENT，绝不阻断用户主流程；拿不到锁 / 账本损坏走 §七 既定降级。
8. **主通道忽略率量化（R2 #7，证伪非阻断弱点的科学前提）**：在 e2e（真实模型）里量化"模型收到 PostToolUse 提醒后**实际去评审/勾选**的比例"。这是架构 §10#9"主投递无强制力"的可观测代理指标——**MVP 刻意先裸测纯非阻断主通道**，把忽略率作为"是否需要更强机制"的证伪输入。低于阈值（待 e2e 标定）即证实非阻断主通道的结构性弱点，但**不在 MVP 内引入任何 DENY**（违 §1，且 FactGate 违 §2，架构 §7.5）；仅记录为 v0.2+ 的决策输入。

### 16.6 MVP 诚实残余（v0.1 知情放弃，附降级方式）

- **OpenCode 主投递 best-effort**：OpenCode 通过 `tool.execute.after` 追加工具结果，仍可能被模型忽略；`.sdd-review-todo.md` 是兜底。
- **本地、不共享**：跨人 / 换机失效；不比旧实现差。降级：v0.2 团队模式（见架构 §10#5）。
- **扫描覆盖之外的窄缝**（R1）：只剩"不在被扫描位置"（ignore-glob 排除 / 扫描预算截断尾部），有日志、非静默，可经 `SCAN_ROOTS`/`IGNORE` 调；"已 commit"不再是盲区（见架构 §10 / §13）。
- **扫描成本 / mtime 极罕见漏**（见架构 §10 / §13）：超大仓首扫贵，mtime 门控后稳态廉价、超预算有告警；可 `SCAN_ALWAYS_HASH=1` 关。
- **跨段 false-clean、LLM 评审质量上限**：与全量设计同源，非 MVP 新增、亦非 MVP 能解（见架构 §10#6 / §10#1）。
- **主投递无强制力**：主投递是 best-effort 让模型自愿调查，模型可零成本忽略；MVP **知情接受**此上限以换"永不卡用户"，并用 §16.5#8 忽略率量化它。**绝不**在 MVP 引入 DENY（违 §1）或 FactGate（违 §2）（见架构 §10#9 / §7.5）。

### 16.7 MVP 构建顺序（= §15 M1→M2→M3→M4）

- **MVP-1 = M1**：core 纯函数 + 单测 + 误报对账 → **证伪闸门**。绿了再继续；不绿则核心赌注被证伪，回到架构层，不进 M2。
- **MVP-2 = M2**：管线 + 锁 + 原子 + state-dir + `init` → 可跑的单次引擎（§12.2/§12.3 子集）。
- **MVP-3 = M3**：CC 适配器（`PostToolUse` 捕获+投递、`UserPromptSubmit` carry-over）+ prompts snapshot + 节流。
- **MVP-4 = M4**：OpenCode adapter（`tool.execute.before` 参数缓存、`tool.execute.after` 主投递、`chat.message` 批次/诊断、idle 被动刷新）+ 发布件。
- **MVP 后**：M5（双平台真实模型 e2e），再进 §十七。

---

## 十七、仍开放 / v0.2

- **团队模式**（checked-in 共享）：两文件一起 commit、账本升 JSONL+内容寻址并集、"同元素冲突 verdict = 重评审"归并。
- **跨段 false-clean 硬化**：verdict 只覆盖 LLM 本回合显式点名对应文件——但坚决不引入段级锚点纪律。
- **代码函数级/AST 粒度**：仅在 §12.4 实测文件级误报率痛时，且只在投递层。
- **`sdd-review-rules.md` 默认规则全文**：M3 前定稿（移植旧 ATTRIBUTION/SDD-EDIT 规则并按新模型改写）。
