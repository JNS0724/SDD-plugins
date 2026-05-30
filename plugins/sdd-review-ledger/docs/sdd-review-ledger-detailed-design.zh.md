# SDD Review-Ledger 详细设计（指导开发）

**版本:** 0.1（初稿 + §十六 MVP 切割）
**日期:** 2026-05-30
**作者:** Claude（Opus 4.8）+ 用户协同
**定位:** 把 [架构文档](./sdd-review-ledger-architecture.zh.md)（决策与"为什么"）翻译成**可据以实现**的工程设计（模块、类型、纯函数签名、伪代码、管线、双平台适配、测试验收）。架构文档是真相源；本文与之冲突时以架构文档为准、并回填修订。

---

## 一、范围与已锁决策

本文实现架构文档已锁的合约。逐条对照：

| 架构决策 | 本文落点 |
|---|---|
| §2/§3 工具不算 drift，只做"评审编排 + 记账"，判断全交 LLM | §四 不变量 / §六 纯函数 |
| §4 两层：Layer A doc↔doc 纯函数 / Layer B code↔doc | §六 `computeNeedsReview` |
| §5 哑账本 + §13#1 JSON map + 本地 gitignore + FsLock + 原子写 | §五 数据模型 / §七 管线 |
| §5.3 ingest-before-render + 哈希钉选 | §七 管线 / §六 `ingestCheckoffs` |
| §6.3 主投递=编辑时工具结果 + git diff；§6.4 obligation 锚定模型 | §九 投递层 |
| §7 三要害（编辑时投递 / 不 auto-synth / 不归一化） | 贯穿 |
| §8 清除=**唯一勾选**，编辑从不清除（2026-05-30 定 checkoff-only） | §六 `ingestCheckoffs` / §九 |
| §13#3 锚点粒度=整文件哈希 | §六 `hashElement` |

**本文顺带定（架构 §13 余项，用与已锁决策一致的默认值，标注可调）：**
- **#2 代码元素粒度** → **文件级**（v1）。函数级/AST 延后，先量化文件级良性误触发率（§十一）。
- **#5 节流** → 主动提醒**每会话有界**（默认每会话 ≤ N、每批次 ≤ 1），被动 todo 无限留存（§九 / §十二）。
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
      paths.js                      #   normalizeKey/rel/resolveFile（移植）
      classify.js                   #   classifyPath：code | sdd-doc | other
      change-dirs.js                #   discoverChangeDirs + isArchived（移植旧 isArchivedChangeDir）
      ledger.js                     #   load/save/empty + 类型；JSON map
      todo.js                       #   parseTodo / renderTodo（格式契约 §8.6）
      compute.js                    #   computeNeedsReview（Layer A+B，纯函数）
      ingest.js                     #   ingestCheckoffs（勾选→verdict，哈希钉选）
      locks.js                      #   acquireFileLock/releaseFileLock（移植）
      atomic.js                     #   writeTextAtomic（移植，砍非原子 fallback）
      state-dir.js                  #   stateDir/findNearestGitDir（移植，改名 state 目录）
      prompts.js                    #   system-reminder 模板（snapshot 契约）
      git.js                        #   gitChangedFiles（git status/diff 包装，best-effort）
      config.js                     #   env 开关
      diagnostics.js                #   JSONL 诊断日志（移植）
    pipeline.js                     #   单次运行编排：acquire→ingest→capture→compute→render→write→deliver
    handlers/
      on-edit.js                    #   PostToolUse / tool.execute.after：捕获 + 投递
      on-prompt.js                  #   UserPromptSubmit / chat.message：carry-over
      on-precompact.js              #   PreCompact：注入 pending 摘要
      on-stop.js                    #   Stop / idle：best-effort + 刷新 todo
      cli.js                        #   sdd-review status / init
    adapters/
      claude-code/command-hook.js   # entry：读 stdin event → 调 handlers → 写 stdout
      opencode/native-plugin.js     # entry：监听 tool.execute.after / chat.message / session.idle
```

**移植自旧实现的原语**（已读源、行为已知，直接改名复用）：
- `locks.js`：`acquireFileLock(target,{staleMs,waitMs,retryMs=25})`（O_EXCL `wx` + 有界重试 + stale-mtime 反捕）/ `releaseFileLock`。
- `state-storage.js` 的 `writeTextAtomic`（tmp+`renameSync`）→ 拆进 `atomic.js`，**删掉其 rename 失败后的非原子 `writeFileSync` 降级分支**（§5.2 决策；rename 失败 = 保留 tmp + 本轮放弃写）。
- `stateDir/findNearestGitDir`：状态目录定位（目录名由 `sdd-drift-hook-state` 改为 `sdd-review-ledger-state`）。
- `paths.js`、`diagnostics`、`change-dir/archived` 检测、`file-classifier`（扩展名→是否 code）。

---

## 三、核心概念与唯一不变量

- **element（元素）**：一个文件路径（相对 repo 根、posix 归一化）。两类：`sdd-doc`（change-dir 下的 `proposal/design/tasks.md`）与 `code`（其余源文件）。**粒度=整文件**（#2/#13#3）。
- **obligation（评审义务）**：派生概念，不持久化。= "某 element 当前哈希 ≠ 账本里它的 `reviewedHash`"。即"它变过、还没被显式评审过当前版本"。
- **verdict（裁决）**：一条显式 ack，钉死它覆盖的确切哈希。由勾选产生（§8）。
- **ledger（账本）**：`path → record` 的 JSON map（§五）。

> **唯一不变量**：`needsReview(element) ⇔ hash(element) ≠ ledger[element].reviewedHash`。这是 `(工作树, 账本)` 的纯函数。工具只回答这个**机械**问题；"变了要不要改 / 改哪 / 归属谁"全部是 LLM 在投递时的**语义**判断。

---

## 四、运行时产物与位置

| 产物 | 位置 | checked-in | 角色 |
|---|---|---|---|
| `ledger.json` | `<nearest .git>/sdd-review-ledger-state/`（兜底 `<cwd>/.sdd-review-ledger-state/` → `%TEMP%/`） | **否**（gitignore） | 机器真相源 |
| `.sdd-review-todo.md` | repo 根 | **否**（gitignore） | 人可见兜底 + ack 入口 |
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
    designFirstLine: firstNonEmptyLine(d/"design.md")   // 投递摘要用
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

  // —— Layer B：code 元素 —— 候选池 = (账本追踪的 code) ∪ (git 工作树变更且分类为 code 的文件)
  codePaths = union(
    keys(ledger.records).filter(k => ledger.records[k].kind=="code"),
    gitChangedFiles(repoRoot).filter(f => classifyPath(f)=="code")   // 捕获兜底：shell 写/未捕获子代理编辑也能被 git 看见
  )
  nonArchived = changeDirs.map(d=>d.relDir)
  for p in codePaths:
    if not exists(p): continue                     // 删除 → 不再追踪（§十三 边界）
    h = hashElement(abs(p))
    if h != ledger.records[p]?.reviewedHash:        // 无记录视为 reviewedHash=undefined ≠ h
      needs.push({path:p, kind:"code", currentHash:h,
                  candidates: nonArchived, reason: ledger.records[p] ? "changed-since-review":"never-reviewed"})
  return needs
```

**关键设计点：**
- doc 与 code 的**触发都是 per-element 哈希比对**——doc 变了产生"评审下游"义务，code 变了产生"评审 doc"义务。受影响对手件**不在此枚举**，留给投递时 LLM + git diff 圈定（§6.4 obligation 模型，防 N-fold）。
- code 候选池并入 `gitChangedFiles`：把对捕获 100% 的依赖降到最低——shell 写、未注册 hook 的子代理编辑，只要还在工作树（未 commit），下次任意 compute 即被 git 看见。残余仅剩"工具没捕获 + 已 commit + 不在账本"的窄缝（§十三）。

### 6.4 parseTodo / renderTodo（格式契约 §8.6）

```
parseTodo(text) -> TodoEntry[]
  对每行匹配 /^- \[( |x)\] (\S+)@([0-9a-f]+)(?: — (.*))?$/
  命中 → {checked: $1=="x", path:$2, inlineHash:$3, rationale:$4||""}
  不命中 → 跳过（不解析 NL、不猜测）
```
```
renderTodo(needs, ledger) -> text
  头部一行："勾选 [x] 表示已评审（编辑文档/代码后仍需勾）；勾选下次运行生效。"
  "## 待评审"：needs 每项 → `- [ ] <path>@<currentHash>  (候选: <candidates>)`
  "## 已评审（近 N，审计用）"：ledger 中 hash==reviewedHash 的项，按 reviewedAt 取近 N（默认 50）
                              → `- [x] <path>@<reviewedHash> — <rationale>`
```
渲染**幂等**：同 (needs, ledger) → 同字节（排序固定，按 path 字典序）。

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
**编辑从不在这里清除**（checkoff-only，§8.2）：本函数只处理 `[x]`；agent 编辑 doc/code 只改哈希、由后续它自己的勾选清除。

---

## 七、运行管线（单次 run 编排）

`pipeline.run(ctx)` —— 所有 handler 的公共主干。`ctx = {repoRoot, event, editedPath?, sessionId, actor, runtime}`。

```
run(ctx):
  try:
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

**init（冷启动，§9 架构）**：`sdd-review init` 扫描当前工作树所有 change-dir 的 doc + 已变更 code，把它们的当前哈希**全部写为 reviewedHash（verdict=`bootstrap`）**、不触发评审 → 避免存量 repo 满屏"待评审"。这是一次诚实标注的静默 baseline（"不回溯存量"，非"已验证"）。同时写两行 `.gitignore`。

---

## 八、捕获层

- 监听**写**工具：`Edit` / `Write` / `MultiEdit`（CC）、`edit`/`write`/`patch` 等（OpenCode `tool.execute.after`）。**不监听 Read**（§8.3）。
- 对 `editedPath` 调 `classifyPath`：
  - `sdd-doc`（change-dir 下 proposal/design/tasks.md）→ 不需特别记账（compute 时扫描发现）；它触发一次 run（→ 投递/刷新 todo）。
  - `code`（源扩展名，移植旧 file-classifier：含 html/css/js/ts/各框架/常见后端扩展，前端单文件原型如 `index.html` 也算）→ `trackCodePath`（首见 reviewedHash=null）。
  - `other`（lockfile/二进制/非源文件）→ 忽略。
- **不依赖捕获 100%**：compute 的 code 候选池并入 `gitChangedFiles`（§6.3），捕获只是"即时性优化"，丢了由 git 工作树兜底。

---

## 九、投递层

### 9.1 主通道 = 编辑时工具结果（§6.3 / §7.1）

handler `on-edit` 在 run 之后，若 `needs` 非空且未超节流，**返回**一段 `<system-reminder>` 文本，由适配器挂到**这次编辑的工具结果**上（CC: PostToolUse 输出；OpenCode: append 到 `tool.execute.after` 的 output）。编辑时即送达，不依赖后续工具调用，不押 Stop。

### 9.2 system-reminder 提示契约（`prompts.js`，snapshot 测试）

```text
<system-reminder>
[SDD-REVIEW: NEEDS-REVIEW]

CHANGED (未评审，本批):
  - src/greet.ts        (候选 change-dir: greeting, refund)
  - sdd/changes/greeting/design.md

CONTEXT:
  - greeting/design.md 首行: "Greeting 行为：根据时段返回问候语"
  - 变更详情见 git diff（自行查看相关 hunk 定位受影响段落）

REVIEW（你是唯一语义裁判）:
  逐项判断这次变更是否使对手件过期：
  - 需要改 → 直接编辑对应 design/tasks（这本身是同步动作）
  - 不需要改（纯重构/格式化/无关）→ 在 .sdd-review-todo.md 勾掉该项并写一行理由
  规则见 sdd-review-rules.md（§归属评审规则）。

ACTION: 完成上述后回到用户原始任务。无论编辑还是勾选，最终都需在 .sdd-review-todo.md 勾掉你评审过的每一项（编辑文件不自动清除）。
</system-reminder>
```
- 含**候选 change-dir + design 首行摘要**（§6.4 受影响对手件交 LLM 圈定）。
- 指向 **git diff** 让 LLM 自行定位段落（整文件粒度"损失的段定位"由 LLM+diff 免费补回，§6.4）。
- 评审规则从 `sdd-review-rules.md` 动态加载（移植旧规则文件机制），缺失则内置默认。
- 该段做**字节级 snapshot 测试**（契约稳定性）。

### 9.3 节流（#5 已定）

- **主动提醒有界**：每会话 ≤ `SDD_REVIEW_SESSION_MAX_REMINDERS`（默认 3）、每批次（连续编辑）≤ 1。超出后**不再主动刷屏**，改由被动 todo + 下一轮 carry-over + Stop 兜底。
- **被动 todo 无限留存**：每次 run 都刷新 `.sdd-review-todo.md`，从不因节流而丢项。
- 设 `0` 可把主动提醒完全关掉、纯靠 todo（与旧实现 `*_TOOL_MAX_REMINDERS` 同风格）。

### 9.4 carry-over / 兜底

- `on-prompt`（UserPromptSubmit / chat.message）：新会话/下一轮首事件 → 若 `needs` 非空，注入紧凑 carry-over 摘要（跨会话不丢，因账本持久）。
- `on-precompact`：压缩前注入 pending 摘要。
- `on-stop`（Stop / idle）：best-effort 提醒；**始终先刷新 todo + 诊断日志**，保证 continuation 失效时用户仍可见（移植旧 refreshReport 思路）。

---

## 十、双平台投递矩阵（#6 已定）

| 能力 | Claude Code command hook | OpenCode native plugin |
|---|---|---|
| 编辑捕获 | `PostToolUse`（可靠） | `tool.execute.after`（可靠，转换得来） |
| **主投递**（编辑时提醒） | PostToolUse stdout / additionalContext | **append 到 `tool.execute.after` 的 output**（OpenCode 最可靠模型可见通道） |
| 下一轮 carry-over | `UserPromptSubmit` | `chat.message` |
| 压缩兜底 | `PreCompact` | （无则跳过） |
| Stop continuation | `Stop` hook（可用） | `session.idle` / idle `session.status`（**best-effort，不可靠**） |
| shell 写 / 未捕获子代理 | compute 时 `gitChangedFiles` 兜底 | 同左 |
| todo 人可见兜底 | 始终写 | 始终写 |

**结论**：两平台**主投递都走编辑时工具结果**，绝不把正确性押在 Stop。OpenCode 的 Stop 仅作 best-effort + todo 刷新。共享 `src/core` + `src/handlers`，仅 `src/adapters/*` 不同（entry 形态 + 事件转换）。

---

## 十一、代码元素粒度（#2 已定）

- **v1 = 文件级整文件哈希**（与 §13#3 doc 决策同逻辑）。同文件多关注点 → 改无关函数也触发 → 但这是**良性误触发**（LLM 一句"无关"勾掉），非有害结论（§7.3）。
- **不预先上 AST/函数级**。仅当 §十二 误报对账实测出文件级良性误触发率痛到不可接受时，才在**投递层**（不是账本层）用 git diff hunk 把"只把变更段喂给裁判"作 token 优化；触发/记账永远文件级。

---

## 十二、测试与验收

### 12.1 纯函数单测（core，无 IO）
- `hashElement`：同字节同哈希；格式化/重排改字节 → 改哈希（确认是良性触发源，非 bug）。
- `computeNeedsReview`：Layer A（doc 变→待评审）、Layer B（code 变→待评审）、never-reviewed vs changed-since-review、git 候选并入、删除文件不报。**同输入任意次同输出**。
- `parseTodo`：合法行解析；畸形行跳过；`[x]/[ ]`、`@hash`、理由提取。
- `ingestCheckoffs`：勾选钉**内联哈希**（非当前哈希）；重复勾选幂等；非追踪路径忽略。
- `renderTodo`：幂等、字节稳定、排序固定。
- `prompts`：**字节级 snapshot**（契约稳定）。

### 12.2 协调/管线测（有 IO，临时 repo）
- **ingest-before-render**：勾完一项后下一次 run → 该项落"已评审"、不被重渲染冲回。
- **哈希钉选防 false-clean**：勾 `path@H1` 后文件改成 H2 → 仍待评审（H2 ∉ verdict）。
- **编辑不清除（checkoff-only）**：编辑 doc 同步后，code 项仍待评审，直到显式勾掉。
- **冷启动 init**：500 文件存量 repo → init 后 0 待评审；此后改一个文件 → 仅它待评审。
- **gitignore 一致性**：`todo tracked XOR ledger tracked` → 告警。

### 12.3 并发/崩溃测
- 双进程（模拟父+子代理）并发写 → FsLock 串行化；落败者 fail-open 跳过、下轮补；**断言无损坏、无 false-clean**（最坏丢一条 ack → 重审，安全侧）。
- 写中途 kill → tmp/rename 原子性：读者只见旧或新完整账本；损坏账本 → 自愈当空。

### 12.4 误报对账（一等验收，对应"不误报"）
构造真实编辑序列并断言**不产生有害错误结论**（只允许良性"请评审"提示、可一句勾掉）：① 多关注点文件改无关函数；② 全仓 gofmt；③ design 段润色/重组；④ design-first 改后 code 跟进（反向 drift 被端出）；⑤ 子代理 / shell 写（git 兜底捕获）。并与旧 mtime 方案在同序列上对账误报数。

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
| 跨段 false-clean（§6.4/§10#6） | 整文件粒度代价：勾掉整 doc 连带清同文件未评审别段。缓解=投递含完整 diff（让 agent 看见全部变更段）；硬化 v0.2，**不引入段级锚点纪律** |
| ack 延迟一轮（§5.3 残余） | 锁争用/勾选落临界区后 → 延迟一轮浮现（todo 持久不丢）。todo 头注"勾选下次运行生效"管理预期 |
| 网络/同步盘（NFS/Dropbox） | rename/O_EXCL 原子性不保证 → 靠损坏自愈兜底 |
| 工具从未看见 + 已 commit + 不在账本的 code 写 | 真正不可恢复的窄缝（§10#2）；git 候选池已把它压到极小 |

---

## 十四、配置开关（env）

| 变量 | 默认 | 作用 |
|---|---|---|
| `SDD_REVIEW_SESSION_MAX_REMINDERS` | `3` | 每会话主动提醒上限；`0`=纯靠 todo |
| `SDD_REVIEW_LEDGER_CODE_CAP` | `1000` | 账本 code 记录 LRU 上限 |
| `SDD_REVIEW_RULES_FILE` | — | 覆盖 `sdd-review-rules.md` 路径 |
| `SDD_REVIEW_LOG` / `SDD_REVIEW_LOG_PATH` | on / state 目录 | 诊断日志开关/路径 |
| `SDD_REVIEW_HASH_LEN` | `16` | element 哈希 hex 前缀长度 |

---

## 十五、实现里程碑（build order）

1. **M1 core 纯函数 + 单测**：hash / classify / change-dirs / ledger / todo(parse+render) / compute / ingest。无 IO，先把不变量与误报对账（§12.1/§12.4）跑绿——这是核心赌注的证伪点。
2. **M2 管线 + 并发/原子**：pipeline.run + locks + atomic + state-dir + init；§12.2/§12.3 跑绿。
3. **M3 Claude Code 适配器 + 投递**：on-edit / on-prompt / on-stop + prompts + 节流；单平台端到端。
4. **M4 OpenCode 适配器**：native-plugin（tool.execute.after 主投递 + chat.message carry-over + idle best-effort）。
5. **M5 双平台 e2e（J1–J16）+ build:check 字节校验 + 文档**。

每个里程碑独立可验证；M1 通过即证伪/证实核心赌注，再决定是否继续。

---

## 十六、MVP 切割（v0.1 首发范围）

> 本节定义**第一个可发布、可在真实 vibe coding 回路里跑**的最小产品，并逐条说明每个"砍掉"为何**只砍能力、不砍核心赌注的正确性**。MVP = §15 的 **M1+M2+M3**（单平台 Claude Code 端到端）；M4/M5 与 §十七 全部后置。
>
> **引用约定**：本节裸 `§x` 指**本文**；引用架构文档一律写 `架构 §x`（因两文档存在同号子节，如 §5.3/§6.3/§6.4，必须区分）。

### 16.1 MVP 要验证的核心赌注（窄化自 架构 §12）

> **「需评审 = (工作树, 账本) 的纯函数」+「判断全外包给 LLM」，在单平台（Claude Code）真实编辑回路里，能不静默漏报、不有害误报地辅助评审。**

选 Claude Code 单平台先行的理由：`src/core` 平台无关、两平台逐字节复用（§十），核心赌注与平台正交；且 CC 的 `PostToolUse` 是**两平台里更可靠**的投递通道——**在更可靠的通道上若都站不住，错的是模型本身，与平台无关**。故 CC 先行是更强的证伪，而非偷懒。OpenCode 只是再加一个薄适配器（M4），`src/core` 零改动。

### 16.2 范围 IN（MVP 必须有）

逐项是 §二 结构的子集 + §15 的 M1–M3：

| 模块 / 能力 | 落点 | 为何不可砍 |
|---|---|---|
| 内容哈希 + 哑账本（JSON map load/save/empty） | §五 / `core/{hash,ledger}.js` | 唯一不变量（§三）的状态基础 |
| `computeNeedsReview`（Layer A+B，纯函数） | §6.3 / `core/compute.js` | **核心赌注本体**；M1 证伪点 |
| `parseTodo`/`renderTodo` + `ingestCheckoffs`（哈希钉选、ingest-before-render） | §6.4/§6.5/§七 | 唯一清除信号 + 防丢勾选 + 防跨版本 false-clean |
| change-dir 发现 + archived 过滤 + 路径分类 | §6.2 / 移植 `file-classifier`+`isArchivedChangeDir` | Layer A/B 的触发输入 |
| 管线（acquire→ingest→capture→compute→write→deliver）+ FsLock + 原子写 + state-dir | §七 / 移植 `locks`+`atomic`+`state-dir` | 单次 run 主干；并发失败安全 |
| `init` 冷启动 baseline + 写 `.gitignore` 两行 | §七 / 架构 §9 | 否则存量 repo 满屏"待评审" |
| Claude Code 适配器：`PostToolUse`（捕获+编辑时投递）、`UserPromptSubmit`（carry-over） | §九/§十 / `adapters/claude-code` | **主投递通道** + 跨会话主动浮出 |
| `gitChangedFiles` 并入 code 候选池（best-effort） | §6.3 / `core/git.js` | 关掉子代理/shell 写盲区（架构 §9 关键场景）；几行、廉价 → 留在 MVP |
| system-reminder 模板（字节级 snapshot） | §9.2 / `core/prompts.js` | 模型可见契约，必须稳定 |
| 节流（每会话上限 + 每批次 ≤1）、`sdd-review-rules.md` 默认规则、最小诊断日志、env 开关 | §9.3/§十四 / 移植 | 防刷屏 + 可调 + 自诊断 |
| core 单测 + 误报对账 + 少量管线集成测 | §12.1/§12.2/§12.4 | **证伪闸门**（见 16.5） |

### 16.3 范围 OUT（v0.1 明确后置，附"为何安全"）

| 后置项 | 归宿 | 砍掉只损失什么 / 为何不伤核心 |
|---|---|---|
| **OpenCode 适配器** | M4 | 仅少一个平台；`src/core` 逐字节复用（§十），CC 已证伪即全局成立（16.1）。 |
| **PreCompact / Stop handler** | M3 后 fast-follow | 主投递本就**不押 Stop**（架构 §7.1）；跨会话/续跑由"持久 todo + `UserPromptSubmit` carry-over"覆盖（§9.4）。砍掉只少几次 best-effort 主动 nudge，**无正确性损失**。 |
| **账本 code 记录 LRU 上限** | 量化后再加 | 验证期 repo 远不到上限；不加只在超长寿大仓无界增长，属验证后问题。 |
| **熔断器（circuit breaker）** | 诊断见重复异常再加 | 顶层 `try/catch → SILENT`（§七/§十三）已保证 fail-open / 永不抛给用户（NFR）；熔断只优化"持续失败"的重试成本，MVP 用不到。 |
| **团队模式**（checked-in + JSONL + 并集归并） | v0.2（架构 §13#1） | v0.1 本就声明本地 / gitignore（架构 §10#5 诚实标注）。 |
| **跨段 false-clean 硬化** | v0.2（架构 §6.4/§10#6） | 投递含完整 diff 已缓解；残余诚实标注（16.6）。 |
| **函数级 / AST 粒度** | 量化后（架构 §13#2） | 文件级误触发是**良性**（架构 §7.3 / §十一）；只在 §12.4 实测痛时上，且仅投递层。 |
| **双平台 × 真实模型 e2e 矩阵（J1–J16）** | M5 | MVP 以 core 单测 + 管线集成 + 误报对账证伪（§15 M1 即证伪点）；真实模型矩阵是后置硬化。 |

> **MVP 相对详细设计的唯一"减法"是删模块，不是改模型。** 所有 IN 模块的行为与已锁合约（§三 不变量、架构 §7 三要害、架构 §8 唯一勾选清除）逐字不变——MVP 不放松任何安全属性，只缩小覆盖面。

### 16.4 MVP 代码库（§二 结构的 MVP 子集）

```
src/
  core/   hash · paths · classify · change-dirs · ledger · todo · compute ·
          ingest · locks · atomic · state-dir · prompts · git · config · diagnostics   ← 全进
  pipeline.js                                                                            ← 进
  handlers/  on-edit · on-prompt · cli(init/status)                                      ← 进
             on-precompact · on-stop                                                     ← 后置（M3后/M4）
  adapters/claude-code/command-hook.js                                                   ← 进（唯一 entry）
  adapters/opencode/native-plugin.js                                                     ← 后置（M4）
```

发布件：MVP 只产 **1 个**（`sdd-review-ledger-hook.js`）；`build.mjs`/`package.json` 先配单 entry，M4 再加第二 entry（§二 打包模式不变）。

### 16.5 MVP 验收闸门（窄化自 §12；过则可发，不过则停）

1. **纯函数正确性 + 决定性**：Layer A（doc 变→待评审）、Layer B（code 变→待评审、git 候选并入）、never-reviewed vs changed、删除文件不报；同输入任意次同输出。（§12.1）
2. **三条 false-clean 守卫**：checkoff-only（编辑不清除）、哈希钉选（勾 `path@H1` 后改成 H2 仍待评审）、Read 不清除。（架构 §7.2/§8 / §12.2）
3. **ingest-before-render**：勾完下一次 run → 该项落"已评审"、不被重渲染冲回。（§七 次序铁律 / §12.2）
4. **编辑时投递 + 兜底**：CC `PostToolUse` 编辑时即送达；`.sdd-review-todo.md` 每次 run 必写；跨会话经持久账本 + `UserPromptSubmit` carry-over 重新浮出。（§九 / §12.5 子集）
5. **冷启动不刷屏**：`init` 后 0 待评审；此后改一个文件 → 仅它待评审。（§12.2）
6. **不误报（一等验收）**：gofmt / 多关注点改无关函数 / doc 段润色 → 只产良性"请瞥一眼"、可一句勾掉；与旧 mtime 方案在同序列上对账，误报数下降。（§12.4）
7. **fail-open**：任何异常 → SILENT，绝不阻断用户主流程；拿不到锁 / 账本损坏走 §七 既定降级。

### 16.6 MVP 诚实残余（v0.1 知情放弃，附降级方式）

- **单平台**：OpenCode 用户在 M4 前不被服务。降级：等 M4（薄适配器）。
- **本地、不共享**：跨人 / 换机失效（架构 §10#5）；不比旧实现差。降级：v0.2 团队模式。
- **捕获 + git 兜底之外的窄缝**：工具从未看见 + 已 commit + 不在账本的 code 写仍漏（架构 §10#2）；git 候选池已把它压到极小。
- **跨段 false-clean**（架构 §10#6）、**LLM 评审质量上限**（架构 §10#1）：与全量设计同源，非 MVP 新增、亦非 MVP 能解。

### 16.7 MVP 构建顺序（= §15 M1→M2→M3）

- **MVP-1 = M1**：core 纯函数 + 单测 + 误报对账 → **证伪闸门**。绿了再继续；不绿则核心赌注被证伪，回到架构层，不进 M2。
- **MVP-2 = M2**：管线 + 锁 + 原子 + state-dir + `init` → 可跑的单次引擎（§12.2/§12.3 子集）。
- **MVP-3 = M3**：CC 适配器（`PostToolUse` 捕获+投递、`UserPromptSubmit` carry-over）+ prompts snapshot + 节流 → **真实 CC vibe 回路端到端可用 = MVP 发布点**。
- **MVP 后**：M4（OpenCode）、M5（双平台 e2e），再进 §十七。

---

## 十七、仍开放 / v0.2

- **团队模式**（checked-in 共享）：两文件一起 commit、账本升 JSONL+内容寻址并集、"同元素冲突 verdict = 重评审"归并。
- **跨段 false-clean 硬化**：verdict 只覆盖 LLM 本回合显式点名对手件——但坚决不引入段级锚点纪律。
- **代码函数级/AST 粒度**：仅在 §12.4 实测文件级误报率痛时，且只在投递层。
- **`sdd-review-rules.md` 默认规则全文**：M3 前定稿（移植旧 ATTRIBUTION/SDD-EDIT 规则并按新模型改写）。
