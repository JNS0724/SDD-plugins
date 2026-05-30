# SDD Review-Ledger 修订 R1：去 git 状态依赖

**版本:** R1（决策修订，落在架构/详细设计 v0.1 之上 → 两文档随之升 v0.2）
**日期:** 2026-05-30
**作者:** Claude（Opus 4.8）+ 用户协同
**触发:** 用户洞察——「尽量不要依赖 git 状态，因为 vibe coding 可能多轮修改」。
**定位:** 本文是对 v0.1 三处 git 依赖的**定向修订**。它发现并修复了一个**真 bug**：git 项静默破坏了架构 §三/§6.2/§12 反复声称的不变量——「`computeNeedsReview` 是 `(工作树, 账本)` 纯函数」——所以这不只是把一个偏好替换掉。结论会回填进
[`架构`](./sdd-review-ledger-architecture.zh.md) 与 [`详细设计`](./sdd-review-ledger-detailed-design.zh.md)；本文与它们冲突处，**以本文为准**（两文档已按本文打补丁 + 升 v0.2）。

---

## 一、用户洞察 → 一句话问题

> vibe coding = **多轮编辑 + 频繁 commit**。任何把「git 工作树相对 HEAD/index 的状态」当作正确性信号的设计，都会在 commit 边界上抖动。

把它锐化成一个可证伪的命题：**「需评审」的判定结果，不应随一次 `git commit`（不改一个字节的工作树）而改变。**

---

## 二、v0.1 的 git 依赖盘点（三处 + 一处无害）

| # | 位置 | 用途 | 是否承载正确性 |
|---|---|---|---|
| 1 | 详细 §6.3 `gitChangedFiles` 并入 code 候选池 | 发现「捕获漏掉」的 code 文件 | **是**（决定哪些 code 进 compute） |
| 2 | 架构 §6.3/§6.4、详细 §9.2 投递含 `git diff` | 给 LLM 精确「变了哪几行」 | 否（仅评审质量/token） |
| 3 | 详细 §七 `init`：扫「已变更 code」 | 冷启动 baseline | 是（决定 baseline 覆盖面） |
| — | 详细 §五 `findNearestGitDir` | 定位 state 目录 | 否（用 `.git` 当**位置**标记，不读 git **状态**） |

\#4 是无害的：它只把 `.git` 当目录定位锚，不查 `git status`/`git diff`/refs。保留它，但补上「非 git 仓库也能跑」的保底（§六）。#1–#3 必须改。

---

## 三、第一性原理：为什么 git 状态是错误信号（#1 是 bug）

### 3.1 它静默破坏了核心不变量

架构 §三「唯一不变量」、§6.2、§12 都断言：

> `needsReview(element) ⇔ hash(element) ≠ ledger[element].reviewedHash`，是 **`(工作树, 账本)` 的纯函数**；hook / CLI / pre-commit 任意触发点跑出**相同结果**。

但详细 §6.3 把 code 候选池实现成了 `union(账本 code keys, gitChangedFiles())`。
`gitChangedFiles()` 是 `(工作树, **git index/HEAD**)` 的函数——**不是** `(工作树)` 的函数。这一项把第三个隐藏变量（git refs）偷偷塞进了号称是纯的函数里：

```
固定工作树 W、账本 L：
  T1（commit 前）：gitChangedFiles = {X}        → compute 含 X → X 浮出
  ── git commit（W 一个字节没变，L 没变）──
  T2（commit 后）：gitChangedFiles = {}（X 已等于 HEAD）→ compute 不含 X → X 消失
∴ compute(W, L) 在 T1≠T2 给出不同结果 ⇒ 不是 (W,L) 纯函数，而是 (W,L,refs) 函数。
```

**不变量被证伪。** 这不是性能问题，是正确性问题。

### 3.2 这个洞恰好在 vibe coding 最常踩的点上

git 候选池的设计意图，是兜住那些「捕获漏掉」的写（未注册 hook 的子代理、shell 重定向写）。但它兜底的**有效期只到下一次 commit**：

```
子代理写 X（hook 没抓到）→ X∈gitChangedFiles → 浮出（看起来兜住了）
agent/用户 commit（vibe coding 极频繁）→ X 等于 HEAD，掉出 gitChangedFiles
                                      且 X 不在账本（捕获本就漏了）
→ X 从此不可见，直到它再次被「带可用 hook 的编辑」改动
```

也就是说，「**漏捕获 + 已 commit**」= 永久的误判成「已评审」（false-clean）盲区。v0.1 详细 §10#2/§十三/§502 把这个残余描述成「窄缝」——但在「多轮编辑 + 频繁 commit」下它**一点都不窄**，正是用户直觉点中的地方。

### 3.3 git diff（#2）也在回答错误的问题

投递里塞 `git diff`，是想告诉 LLM「自上次评审以来变了什么」。但 `git diff` 答的是「自上次 **commit** 以来变了什么」——**错误的基线**：
- 多轮编辑后 commit → `git diff` 为空，LLM 看不到任何变化，却仍被要求评审。
- 多轮编辑未 commit → `git diff` 把 N 轮累积的变更全堆给 LLM，含早已评审过的部分，全是噪音。

我们真正想要的基线，是 **`reviewedHash` 对应的那一版内容**，与 commit 边界无关。git 连这个问题都答不对。

---

## 四、替换 #1：用工作树扫描发现候选池（恢复真·纯函数）

**核心动作**：把 `gitChangedFiles()` 换成 `scanWorkTree()`——直接走文件系统列出 code 文件，与 git refs 无关。

```
scanWorkTree(repoRoot, ledger) -> { codePaths: string[], truncated: bool, skipped: int }
  walk repoRoot，遵守 ignore globs（见 §4.2），对每个文件：
    if classifyPath(f) != "code": continue
    codePaths.push(rel(f))
  // 不在这里算哈希：compute 拿到 codePaths 后逐个 hashElement 比对账本
```

于是详细 §6.3 的候选池从
`union(账本 code keys, gitChangedFiles())`
变为
`union(账本 code keys, scanWorkTree().codePaths)`。

> 实际上账本 code keys ⊆ 已存在文件 ⊆ scanWorkTree（init/auto-baseline 后），所以 union 可以化简成「scanWorkTree 的 code 文件」∪「账本里仍存在的 code key」（后者覆盖「文件被 ignore-glob 排除、但曾被显式捕获」这种边角情况）。实现里取 union 即可，无需证明包含关系。

### 4.1 为什么这反而**更**贴合 thesis，而不是妥协

- **恢复纯函数**：`scanWorkTree` 只读文件系统当前的字节，与 HEAD/index 无关。§3.1 的 T1/T2 现在给出**相同**结果（X 在盘上、hash≠baseline → 两个时点都浮出）。架构反复声称的「任意触发点同一答案」第一次**真正成立**。
- **堵上 commit 洞**：「漏捕获 + 已 commit」不再是盲区——文件在盘上，扫描就看得见。残余缩到只剩「**根本不在被扫描的位置**」（被 ignore-glob 排除、或被 §4.4 的预算截断到尾部），而且这些都**有日志、不静默**（§4.4）。
- **捕获降级为纯性能优化**：捕获 hook 仍然是「编辑当下即时哈希」的快路径，但它**不再承载正确性**——它漏掉的，由每次 compute 的扫描兜回，而且兜底的有效期是「永久」而非「到下次 commit」。

### 4.2 ignore globs（复用既有约定）

复用 sibling `sdd-drift-check` 已有的 `readdirSync` walk 模式（`project-state.js`/`hydration.js` 已经这么扫 change-dir）。默认排除：
`.git/`、`node_modules/`、`dist/`、`build/`、`out/`、`coverage/`、`.next/`、`.nuxt/`、`vendor/`、`.venv/`、`venv/`、`__pycache__/`、`target/`、`.gradle/`、`.idea/`、`.cache/`、state 目录自身、以及 `> SDD_REVIEW_MAX_FILE_BYTES`（默认 2 MiB）的大文件。
- 可以经 `SDD_REVIEW_IGNORE`（逗号分隔，追加）/`SDD_REVIEW_SCAN_ROOTS`（限定只扫某些子树）来调整。
- **不读 `.gitignore`**（那又把 git 拉回来了）。改用自带的默认表 + env，与 git 解耦。

### 4.3 扫描成本与 mtime——**仅作跳过提示，绝不当真相**

担心：每次 compute 在大仓上做全树扫描会很贵。化解办法分两段：

1. **stat-walk 很便宜**：列目录 + `statSync` 数千文件 = 毫秒级；真正贵的是 `readFile+sha256`。
2. **mtime 门控只用来跳过 re-hash**：账本每条 code record 旁边存 `size` + `mtimeMs`（纯优化字段）。扫描时若 `(size, mtimeMs)` 与账本一致 → **跳过读文件**，直接复用上次的哈希；不一致 → 读 + 哈希。

> **与上一代的根本区别（必须写死在实现注释里）**：旧的 `sdd-drift-check` 把 mtime 当**真相**（mtime 新 = 文档与代码对不上），结果被坑。这里 mtime **只是「要不要重算哈希」的跳过提示**——
> - mtime 变但内容没变（`touch`/`git checkout` 重置了 mtime）→ 重算 → 同哈希 → no-op，**安全**。
> - 内容变但 mtime 没变（极罕见，需人为保留 mtime）→ 被跳过提示漏掉。这是**唯一**的 mtime 残余，且：① 会话内的编辑由捕获 hook 直接哈希、绕过跳过提示，不受影响；② 提供 `SDD_REVIEW_SCAN_ALWAYS_HASH=1` 关掉优化、永远全哈希。
>
> 结论：mtime 在这里**只能让我们少读文件，永远不能让我们少报一个真变更**（最坏情况是 always-hash 慢一点）。这就把旧实现里「mtime 撒谎 → 误判成已评审（false-clean）」的有害失败，降级为「mtime 撒谎 → 多读一次文件」的良性开销。

### 4.4 大仓预算（无声截断 = 禁止）

`SDD_REVIEW_SCAN_BUDGET_MS`（默认 1500）：单次扫描超预算 → 停止、`truncated=true`、记下 `skipped` 数。
- **绝不静默**：投递 + todo 头 + 诊断日志都打一行「本轮扫描超预算，跳过约 N 个文件，可能尚未浮出其变更；下轮继续」。这符合「无声 cap 就是谎报覆盖」的纪律。
- 这不是 false-clean：我们从不**声称**那些文件已评审，只是**还没端出来**；下轮 compute 继续推进，最终一致。
- 会话内的编辑仍由捕获即时覆盖，不受扫描预算影响。

---

## 五、替换 #2：投递「自上次评审以来变了什么」时去掉 git diff

放弃 `git diff`（它答错了基线，§3.3）。分两级：

### 5.1 MVP（v0.2 首发）：给当前内容 + 路径，让 LLM 自己读

投递只给 LLM：**变更文件路径 + 候选 change-dir + design 首行**，并指示「请读取这些文件的当前内容来评审」。LLM 本来就有读文件工具，在整文件粒度下，「读当前版本 + 读对应文件 doc」足以判断。
- 代价：比给现成 diff 多几次 read，token 略增。
- 收益：零 git 依赖、基线正确（评审的是「当前真版本」，而不是「相对某个 commit 的 delta」）。
- 投递文案把 §9.2 的「变更详情见 git diff」改成「读取列出文件的当前内容；如需对照上次评审的版本，见 §5.2 快照（v0.2+）」。

### 5.2 目标态（v0.2 增强，git-free 的精确 diff）：已评审内容的快照

要给出「**自上次评审以来**」的精确 diff（而不是 git 的「自上次 commit」），就得留住「上次评审的那一版内容」。git 给不了（它只认 commit）；自己存 blob 则可以：

```
state/blobs/<reviewedHash>        # 内容寻址，按 hash 去重；勾选记 verdict 时落一份
投递时：diff(blobs/<record.reviewedHash>, 当前文件) → 精确「评审后又变了什么」
```

- **基线正确**：diff 的左边永远是「LLM 上次盖章看过的那一版」，与 commit 无关 → 完美回答 §3.3 的真问题。
- **有界**：blob 按 hash 去重 + LRU（随账本 code cap 一起淘汰）；只对「已评审」元素存（待评审项还没有可比的 baseline 版本）。
- **失败安全**：blob 缺失 → 退回 §5.1（给当前内容、不给 diff），不报错。
- 列为 v0.2，因为它纯属**质量/token 优化**，不承载正确性；MVP 用 §5.1 就能发。

> 这条同时把架构 §6.4 / §13#3 里「段级精度由 LLM+git diff 免费补回」改写为「由 LLM 读当前内容（v0.2 起：+ 内容快照 diff）补回」——结论不变（段级仍不进核心账本），只是换掉了 git 这个错误的免费来源。

---

## 六、替换 #3 + 加固 #4：init / repo-root 不要求 git

### 6.1 init / 冷启动 baseline 改用扫描（且 auto-baseline 成为关键依赖）

详细 §七 `init` 原本扫「change-dir doc + **已变更 code**」。「已变更」来自 git → 去掉。改为：

```
init(repoRoot):
  for f in (discoverChangeDirs().docs ∪ scanWorkTree().codePaths):
    ledger[f] = { reviewedHash: hashElement(f), verdict:"bootstrap", mtimeMs, size, ... }
  写两行 .gitignore（账本 + todo）
  // 不触发评审：存量全部视为「不回溯追责」的 baseline（诚实标注，非「已验证」）
```

**新的关键点：去掉 git 后，扫描会看见全仓所有 code 文件 → 冷启动时若不 baseline，就会满屏 never-reviewed。** git 版本「天然只看 changed」掩盖了这个量级，扫描把它暴露了出来。因此：

- **auto-baseline-on-empty-ledger 升为正式机制**（不只是显式 `init`）：首次 compute 时遇到「账本空 且 扫到 ≥ `SDD_REVIEW_BOOTSTRAP_THRESHOLD`（默认 1）个既有 code/doc」→ 自动按 §6.1 把当前工作树记为 baseline、本轮**不刷屏**，并在 todo 头 + 日志注明「已对现有 N 个文件建立 baseline（未回溯评审）」。
- 此后只有文件 hash≠baseline 才浮出 → 精确捕获「baseline 之后的真变更」，与 commit 无关。
- 诚实残余不变（架构 §10#4）：auto-baseline 是一次「不回溯存量」的静默 ack，措辞绝不说「已验证/已对齐」。

### 6.2 repo-root 定位不再**要求** git（#4 加固）

`findNearestGitDir` 保留为**首选**的位置锚，但补上 fallback 链（vibe coding 可能根本没 `git init`）：

```
findRepoRoot(cwd):
  上溯找首个含以下任一标记的目录：
    .git/  →  sdd/ 或 .sdd/  →  package.json/pyproject.toml/go.mod/Cargo.toml/...  →  .sdd-review-ledger-state/
  都没有 → 用 cwd
```

state 目录优先放 `<repoRoot>/.sdd-review-ledger-state/`（无 `.git` 时）或 `<.git>/sdd-review-ledger-state/`（有 `.git` 时），再保底放 `%TEMP%/`。**git 不存在不影响任何功能。**

---

## 七、更新后的纯函数 / 管线（替换详细 §6.3 / §七 对应段）

```
computeNeedsReview(repoRoot, ledger) -> NeedsReviewItem[]      # 真·纯函数 of (工作树, 账本)
  needs = []
  changeDirs = discoverChangeDirs(repoRoot)

  // Layer A + 反向 doc（不变）
  for dir in changeDirs:
    for docName in ["design.md","tasks.md","proposal.md"]:
      p = dir/docName; if !exists(p): continue
      if hashElement(p) != ledger.records[p]?.reviewedHash:
        needs.push({path:p, kind:"sdd-doc", currentHash, candidates:[dir.relDir], reason})

  // Layer B：候选池改为扫描（去 git）
  scan = scanWorkTree(repoRoot, ledger)          # ← 替换 gitChangedFiles；mtime 仅跳过 re-hash
  codePaths = union(
    keys(ledger.records).filter(k => kind=="code" && exists(k)),
    scan.codePaths                               # ← 文件系统真相，与 commit 无关
  )
  for p in codePaths:
    if !exists(p): continue
    h = hashElement(p)                           # mtime 命中则复用缓存哈希
    if h != ledger.records[p]?.reviewedHash:
      needs.push({path:p, kind:"code", currentHash:h, candidates: nonArchivedDirs, reason})

  if scan.truncated: needs.meta = { scanTruncated:true, skipped:scan.skipped }   # 非静默
  return needs
```

管线次序的铁律不变（INGEST→CAPTURE→COMPUTE→WRITE→DELIVER）。compute 内部多了一次 scan（mtime 门控之后很廉价）。

模块影响：
- **删** `core/git.js`（`gitChangedFiles`）。
- **加** `core/scan.js`（`scanWorkTree` + ignore 表 + mtime/size 门控 + 预算）。
- `core/ledger.js` 的 record 增加 `mtimeMs`/`size`（纯优化字段，缺失即视为「需重哈希」，向后兼容）。
- `core/state-dir.js`：`findNearestGitDir` → `findRepoRoot`（多标记 + 无 git fallback）。
- v0.2 加 `core/blobs.js`（§5.2 内容快照）。

---

## 八、对抗压测：扫描方案自身的失败模式

| # | 攻击 | 后果 | 缓解 | 残余性质 |
|---|---|---|---|---|
| P1 | 无 init 冷启动 | 满屏 never-reviewed | §6.1 auto-baseline-on-empty-ledger（关键依赖） | 一次静默 baseline（已是架构 §10#4 接受的残余） |
| P2 | 巨型 monorepo 扫描慢 | 卡顿 | ignore globs + mtime 门控 + `SCAN_BUDGET_MS` | 超预算的尾部「**有日志**」延后浮出（§4.4），非 false-clean |
| P3 | 内容变但 mtime 没变 | scan 跳过该文件 | 会话内编辑走捕获直接哈希；`SCAN_ALWAYS_HASH=1` 关优化 | 极罕见 + 可关，最坏是「下次 mtime 一动就抓到」 |
| P4 | code 真的躺在 ignore 目录里（如 `vendor/` 内自写代码） | 不浮出 | `SDD_REVIEW_IGNORE` 可改、`SCAN_ROOTS` 可指定 | 配置项，文档标注；默认表保守 |
| P5 | 跨机/跨人结果不同 | — | scan 只依赖工作树字节 → 同工作树同结果 | **比 git 版更好**（git 版依赖 refs，换机就不同） |

**关键**：P1–P4 的残余全是「**良性延后 / 可配置 / 有日志**」，**没有一个是有害的 false-clean**（从不把未评审项错标成已评审）。这与架构 §8「良性 ≪ 有害」的安全姿态一致；而被替换掉的 git 版 #1 残余，是**有害的 false-clean**（§3.2 commit 洞）。综合来看：去 git 既消除了一个有害残余，又把新引入的残余全锁在良性这一侧。

---

## 九、对 MVP / 测试的影响

### 9.1 MVP 范围（改详细 §16.2 一行 + §16.4/§十五）

- `gitChangedFiles 并入候选池`（原 §16.2 一行）→ **`scanWorkTree 发现候选池`**：仍在 MVP（承重，而且把子代理/shell 盲区**彻底**关掉，而非只是「压到极小」）。
- `core/git.js` 退出 MVP；`core/scan.js` 进 MVP。
- `init` 改扫描 + auto-baseline 进 MVP（去 git 后 auto-baseline 是防刷屏的关键依赖，不能后置）。
- 投递 diff：MVP 用 §5.1（给当前内容自读）；§5.2 blob 快照后置到 v0.2。
- 构建顺序 M1→M2→M3 不变；M1 的「纯函数 + 决定性」单测现在**真能跑过决定性**（之前有 git 项时其实跑不出严格的决定性）。

### 9.2 测试增删（改详细 §12）

- **删/改**：所有「git 候选并入」的断言 → 「scan 候选并入」。「子代理/shell 写（git 兜底捕获）」→ 「子代理/shell 写（**scan 兜底捕获，且 commit 后仍捕获**）」。
- **新增（核心回归，钉住本次修复）**：
  1. **commit 不变性**：写 X（不经捕获）→ compute 浮出 X → `git commit` → **再 compute 仍浮出 X**（v0.1 git 版会消失，这正是回归靶子）。无 git 仓库下同样浮出。
  2. **mtime 跳过的安全性**：`touch` 文件（变 mtime 不变内容）→ scan 重哈希 → 同哈希 → 不浮出；改内容 → 浮出。
  3. **预算非静默**：注入超预算 → `truncated=true` + todo 头出现告警行 + 日志有记录。
  4. **auto-baseline**：空账本 + 既有 N 文件 → 首次 compute 0 待评审 + 注明 baseline N；之后改 1 个 → 仅它浮出。
  5. **无 git 仓库**：删/不建 `.git` → findRepoRoot 走 sdd/ 或 package.json/ cwd → 全流程照常。
- **误报对账（详细 §12.4）**：原⑤「子代理/shell 写（git 兜底）」改为「子代理/shell 写后 **commit**（scan 兜底）」——直接覆盖 §3.2 的洞。

---

## 十、诚实残余（去 git 后的新账）

1. **扫描成本**（不可能完全消除）：超大仓首扫会贵；mtime 门控之后稳态廉价；预算截断**有日志**。降级手段：`SCAN_ROOTS` 限定子树。
2. **mtime 跳过的极罕见漏报**（§4.3 P3）：内容变 + mtime 不变 + 未经捕获，三者同时发生。可用 `SCAN_ALWAYS_HASH=1` 关掉。
3. **ignore 目录里的真代码**（P4）：默认表保守、可配置。
4. **auto-baseline 是静默 ack**（P1，沿用架构 §10#4）：措辞绝不说「已验证」。
5. **§5.1 MVP 没有精确 diff**：LLM 多读几次文件，token 略增；v0.2 的 blob 快照（§5.2）补回**正确基线**的 diff（git 本来就给不了正确基线）。
6. 被**消除**的旧残余：架构 §10#2 / 详细 §502 那个「漏捕获 + 已 commit 的 code 写」窄缝——scan 之后只剩「不在被扫描的位置」，且有日志。**这是一次净改善，不是平移。**

---

## 十一、回填清单（已按此打补丁的位置）

**架构 v0.1 → v0.2：**
- §6.3「投递 payload 含完整 git diff」→ 当前内容自读 +（v0.2）内容快照 diff（本文 §5）。
- §6.4「受影响对应文件由 LLM 用 git diff 现场圈定」/「投递必含完整 diff」→ 去 git 措辞。
- §13#3「段级精度由 LLM+git diff 免费补回」→ 「由 LLM 读当前内容（v0.2 +快照 diff）补回」。
- §10#2 残余「漏捕获+已 commit」窄缝 → 缩为「不在被扫描的位置（有日志）」。
- 新增 §7.4 关键陷阱「不把 git 状态当正确性信号」+ §13 收尾项「去 git 依赖（本文 R1）」。

**详细 v0.1 → v0.2：**
- §6.3 候选池 `gitChangedFiles` → `scanWorkTree`；伪代码、注释、§204/§284 同步更新。
- §二/§六 模块表：删 `core/git.js`，加 `core/scan.js`（+ `core/blobs.js` 标 v0.2）；`findNearestGitDir`→`findRepoRoot`。
- §七 `init` 扫描化 + auto-baseline 升为正式机制。
- §9.2 投递文案去 git diff。
- §十一/§十三 残余行、§十四 env（加 `SCAN_*`/`IGNORE`/`BOOTSTRAP_THRESHOLD`/`MAX_FILE_BYTES`）。
- §12 测试：加 §9.2 五条回归；§12.4 ⑤ 改「commit 后 scan 兜底」。
- §16.2/§16.4/§16.5/§16.7 MVP：git→scan、auto-baseline 进 MVP、决定性闸门现在真能过。

> 一句话收尾：**用户要求「别依赖 git 状态」，落地之后不只是去耦——它把架构号称却没兑现的「`(工作树,账本)` 纯函数」第一次做实，并填掉一个 vibe-coding 高频触发的、有害的 false-clean 盲区。git 的退出是正确性升级，不是功能让步。**
