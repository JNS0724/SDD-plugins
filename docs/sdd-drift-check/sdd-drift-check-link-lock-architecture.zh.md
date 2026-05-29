# SDD 漂移检测：边改边链 + Lockfile 架构（clean-slate）

**版本:** 0.2（草案）
**日期:** 2026-05-29
**作者:** Claude（Opus 4.7）+ 用户协同
**状态:** Clean-slate 备选架构——抛开当前实现包袱、不考虑向后兼容，仅保留用户核心需求重新设计。与 [prd](./sdd-drift-check-hook.prd.zh.md) / [design](./sdd-drift-check-hook.design.zh.md) 并列供对比决策。
**标尺:** everything-claude-code（ECC）真实源码 + 文档。本版按 ECC 的 9 条可靠性支柱自审并收敛。

### 修订记录

- **v0.2**（本版）：以 ECC 实现为标尺自审后的三项核心收敛——
  1. **捕获 / 解析分离**（ECC P3）：捕获在 PostToolUse 确定性 append、无 LLM、100%；归属解析独立成层、可延迟、非阻塞。修正 v0.1 把 LLM 声明塞进捕获路径的反模式。
  2. **事件溯源**（ECC P2）：引入 append-only `link-events.jsonl` 为真相源；`sdd.lock` 降为**派生快照**（可审、可重算自愈）。
  3. **分层触发 + 权威下沉**（ECC P1）：归属解析分 T0–T4 层；最终裁判是确定性的 `sdd check`，不是不可靠的 Stop。
  外加：auto-align 不再静默钉死基线（低置信标记）；schema 校验第一版即上。
- **v0.1**：首版 lockfile 思路（可变 lock 单层 + 捕获即归属）。已被 v0.2 取代。

---

## 一、需求内核

剥到只剩一句：

> SDD 开发时，design/tasks 文档与代码保持对齐；分歧出现时**可靠地、不误报地**告诉我——跨会话、子代理代劳也算。

派生约束：不误报（happy path 不烦）/ 不漏报（不静默累积）/ 跨会话 / 子代理透明 / 双向（doc↔doc、doc↔code）/ 双平台（Claude Code + OpenCode）/ 永不阻断用户。

---

## 二、第一性原理：三条公理

漂移 = 两个分别维护的产物分歧。判断分歧**必须有一个"上次已知对齐"的基线**。三条正交的设计公理：

### 公理 1（两个轴）：捕获时机 × 存储位置

| 轴 | 选项 | 本架构 |
|---|---|---|
| **A. 链接何时建立** | A1 编辑当下 / A2 检查点 | **A1 边改边链** |
| **B. 基线存在哪** | B1 session/project 隐藏 / B2 repo 内 checked-in | **B2 lockfile** |

### 公理 2（ECC P3）：捕获必须确定性，解析才可以延迟/用 LLM

ECC v1→v2 的核心修正：observe.sh 在 PreToolUse/PostToolUse **确定性 append 原始事件**（100% 可靠）；模式分析交给**后台异步 agent**。**捕获从不依赖 LLM 判断。**

本架构据此把两件本质不同的事**拆开**：

| | 是什么 | 性质 |
|---|---|---|
| **原始事实** | "code X 改了，hash H1→H2，本会话协同改了 [SDD 文件]" | **确定性**，任何时刻 100% 可抓 |
| **语义链接** | "code X **实现了** design §Y" | **判断**，需意图/语义 |

—— **记录（原始事实）必须当下且确定；解读（语义链接）可以晚、可以用 LLM、可以失败重来——因为原始事实已落盘、不腐烂。**

### 公理 3（ECC P2）：事件是真相，状态是派生

ECC 的 observations.jsonl / governanceEvent 都是 append-only 不可变事件，状态从事件**派生**。本架构同构：`link-events.jsonl`（append 真相）→ `sdd.lock`（派生快照）→ `computeDrift`（纯函数验证）。lock 坏了可从事件重算自愈。

---

## 三、三层架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 0  仓库产物（全部 checked-in）                          │
│    sdd/changes/<id>/{proposal,design,tasks}.md                │
│    .sdd/link-events.jsonl   ← append-only 真相源（公理 3）      │
│    sdd.lock                 ← 从事件 + 工作树派生的快照，PR 可审 │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  Layer 1  Core 引擎（纯函数 + schema 校验）                    │
│    appendEvent()   捕获：确定性 append（公理 2 捕获层）         │
│    resolveLinks()  解析：从事件派生 links（公理 2 解析层）      │
│    deriveLock()    从 events + 工作树重算 sdd.lock（含自愈）    │
│    computeDrift()  (工作树, lock) → DriftReport ← 纯函数        │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  Layer 2  触发器（薄壳，都调 Core；分层见 §6）                  │
│    Session hook（PostToolUse 捕获 / Stop nudge）               │
│    CLI: sdd check / sdd resolve / sdd init                     │
│    git pre-commit / CI → sdd check（权威裁判）                 │
└───────────────────────────────────────────────────────────────┘
```

**核心不变量：漂移真相是 `(工作树 + 事件日志)` 的纯函数。** session hook 只是触发器之一，丢了不影响真相可计算。

---

## 四、数据模型

### 4.1 `.sdd/link-events.jsonl`（append-only，真相源）

每行一个不可变事件，**捕获层确定性写入**：

```jsonc
{ "seq": 1, "ts": "2026-05-29T10:00:00Z", "session": "sess_A", "kind": "doc-edit",
  "path": "changes/greeting/design.md#greeting-behavior", "hashAfter": "sha256:d4e5f6" }
{ "seq": 2, "ts": "2026-05-29T10:01:00Z", "session": "sess_A", "kind": "doc-edit",
  "path": "changes/greeting/tasks.md#impl-greet", "hashAfter": "sha256:11aa22" }
{ "seq": 3, "ts": "2026-05-29T10:02:00Z", "session": "sess_A", "kind": "code-edit",
  "path": "src/greet.ts", "hashBefore": "sha256:00", "hashAfter": "sha256:a1b2c3",
  "coEditedSddThisSession": ["changes/greeting/design.md#greeting-behavior",
                             "changes/greeting/tasks.md#impl-greet"],
  "activeChangeDirs": ["greeting"] }
{ "seq": 4, "ts": "...", "session": "sess_B", "kind": "no-impact",
  "path": "src/legacy/shim.ts", "reason": "DTS-1234 hotfix" }
{ "seq": 5, "ts": "...", "session": "sess_B", "kind": "archive", "changeDir": "changes/greeting" }
```

事件类型：`code-edit` / `doc-edit` / `no-impact` / `archive` / `align`。每个字段都是**事实**，无判断。每行 schema 校验。

### 4.2 `sdd.lock`（派生快照，checked-in，PR 可审）

```jsonc
{
  "version": 1,
  "derivedThrough": { "eventSeq": 5, "eventLogHash": "sha256:..." },  // 派生到事件日志哪一行
  "links": [
    {
      "id": "greeting-behavior",
      "design": "changes/greeting/design.md#greeting-behavior", "designHash": "sha256:d4e5f6",
      "tasks": { "changes/greeting/tasks.md#impl-greet": "sha256:11aa22" },
      "code":  { "src/greet.ts": "sha256:a1b2c3" },
      "status": "active",
      "confidence": "deterministic",   // deterministic | auto-coedit | agent-confirmed | llm
      "bornBy": "edit-time",
      "confirmedRef": "session:sess_A | seq:3"
    }
  ],
  "unresolved": [
    { "code": "src/payment.ts", "codeHash": "sha256:...", "candidates": ["greeting","refund"], "sinceSeq": 9 }
  ],
  "noImpact": [
    { "code": "src/legacy/shim.ts", "codeHash": "sha256:...", "reason": "DTS-1234 hotfix", "sinceSeq": 4 }
  ]
}
```

- `derivedThrough`：lock 派生到事件日志哪一行。若事件日志有更新的行 → 重新派生；若 lock 损坏/缺失 → 从 `link-events.jsonl` + 工作树**全量重算自愈**。
- `links[].confidence`：标记这条链接怎么来的（确定性 / 协同自动 / agent 确认 / LLM）——auto 来的低置信，区别于显式确认（修正 v0.1 的 auto-align 静默钉死）。
- `unresolved`：归属待定的代码编辑——**一种可见状态，不是丢失**。
- `noImpact`：显式"与 SDD 无关"，可审。

### 4.3 锚点粒度（v1）

| 元素 | 锚点 | 哈希对象 |
|---|---|---|
| design 段 | `design.md#<stable-id>` | 该 heading 到下一个同级/更高级 heading 的 body |
| tasks 项 | `tasks.md#<stable-id>` | 该 checklist 行文本 |
| code 单元 | 文件路径（v1）；v2 可上 AST 函数级 | 文件内容 |

锚点用稳定 id（heading 旁注 `<!-- sdd-id: greeting-behavior -->`）而非 slug，避免改标题导致 ORPHAN。

---

## 五、捕获层（确定性、无 LLM、100%）

### 5.1 PostToolUse：无条件 append 原始事件

```
PostToolUse(Edit/Write/MultiEdit/Read):
  1. 算目标文件/段落的内容哈希
  2. 组装原始事实事件（code-edit 或 doc-edit）：
       - 路径、hashBefore/After
       - 本会话至此协同编辑过的 SDD 元素集合
       - repo 内当前未归档 change-dirs
  3. fs.appendFileSync 到 link-events.jsonl   ← 一行，幂等（seq 去重）
```

**绝不注入 prompt、绝不等 agent、绝不读返回。** 这一步的可靠性等同"往文件追加一行"，不依赖 LLM/平台投递。这是公理 2 捕获层、也是风险 1 的根治。

### 5.2 子代理透明

子代理自己的 PostToolUse 直接 append；即便其 hook 未注册，它改的文件哈希变化也会被任意后续 `sdd check` 抓到。**不再解析子代理输出文本猜改动。**

---

## 六、解析层（分层触发，确定性优先，语义塌缩）

归属**不是单一触发点**，它按"确定性程度"分裂，分层触发：

```
T-1  捕获（§5，在所有解析之前）        无条件 append           100% 确定，前提
  ↓
T0   PostToolUse（append 之后）        协同信号唯一 → 自动建链   无 LLM，即时（happy path）
  ↓ 解析不了的留 unresolved
T1   Stop                             浮出 unresolved 给 agent  非阻塞 nudge，best-effort
  ↓
T2   UserPromptSubmit（下一轮）         carry-forward unresolved  跨轮兜底
  ↓
T3   sdd check（CLI/pre-commit/CI）★   确定性解析 + unresolved 报成 drift   无 agent 依赖，权威
  ↓
T4   agent 正常 SDD 工作 / sdd resolve  语义归属真正落地         唯一用判断处
```

### 6.1 确定性解析（无 LLM，覆盖绝大多数）

```
resolveDeterministic(unresolved code-edit 事件 e):
  if e.coEditedSddThisSession 命中唯一 change-dir → 建链（confidence: auto-coedit）
  elif 项目内唯一未归档 change-dir → 建链（confidence: auto-single）
  else → 留 unresolved，记 candidates
```

J1/J2/J4/J6/J7 全走这条，无需 LLM。

### 6.2 语义解析的优雅塌缩（不需要特殊"声明协议"）

真歧义（J11/J13）时，**agent 解决它的方式 = 做正常 SDD 工作（编辑对应 design 段）**，那个编辑本身就是协同信号，下一轮塌缩回确定性：

```
session A：改 src/payment.ts，无协同 → T0 解析不了 → unresolved（候选 greeting/refund）
           → T1 Stop nudge："src/payment.ts 归属待定，候选 greeting/refund"
session B：agent 读 nudge → 编辑 refund/design.md（正常 SDD 工作）
           → T-1 append doc-edit 事件
           → 解析层见：link-events 里有 unresolved code-edit（候选含 refund）+ 现 refund/design 被编辑
           → 确定性关联 → 建链 refund ↔ src/payment.ts
```

**没有专门的"声明链接"通道**（避开"观察 agent 后续动作反推"的脆弱）。事件日志把跨会话的"未解归属"和"现在的 doc 编辑"对上。

### 6.3 权威下沉到 `sdd check`（T3），不在 Stop（ECC P1）

最关键定位：**最终裁判是确定性的 `sdd check`，不是 agent 在场的 Stop。**

- T0/T1/T2 是**体验优化**（会话内即时解析、早点 nudge）——可丢
- T3 是**正确性兜底**——纯确定性、无 agent、pre-commit/CI 可跑、谁都能复现；它解析所有确定性归属，剩下 `unresolved` **报成 drift 状态**，CI 里无 LLM 也正确（确定的全解析，真歧义报出来）

### 6.4 为什么不学 ECC 上后台 daemon

ECC 分析层是定时后台进程（要累积 + LLM 找模式）。SDD 归属**不需要累积，只需正确信号（协同编辑），而信号确定性到达**。所以 `sdd check`（由 pre-commit/CI/按需触发）就承担"批量解析"角色，**确定性、无状态、无 daemon**——这是 SDD 该偏离 ECC 的地方。

---

## 七、校验层（drift 纯函数）

```
computeDrift(工作树, sdd.lock) → DriftReport:    # 纯函数，无副作用
  for link in lock.links where status == active:
    if hash(当前 design 段)≠link.designHash and hash(当前 code)≠link.codeHash → BOTH_CHANGED
    elif hash(当前 code) ≠ link.codeHash    → CODE_AHEAD
    elif hash(当前 design 段) ≠ link.designHash → DOC_AHEAD
    elif hash(当前 tasks 项) ≠ link.tasksHash   → DOC_DOC_DRIFT
  + lock.unresolved 非空 → UNRESOLVED_ATTRIBUTION（保守计为潜在 drift）
  + 工作树改动过、不属于任何 link/unresolved/noImpact 的 code → UNLINKED
  + 指向已删除文件/段落的 link → ORPHAN
```

只有 `当前内容哈希 vs lock 哈希`。**无 transcript、无 mtime、无 NLP、无 session 状态、无 TTL、无 alignedAtMs。** git checkout / 格式化改 mtime → 不误报（看内容哈希）。会话崩溃 / Stop 被丢 → 不丢真相（事件在 repo）。

---

## 八、lock 派生与自愈

```
deriveLock(events, 工作树) → sdd.lock:
  按 seq 回放 events：
    doc-edit / code-edit → 更新对应元素哈希、跑确定性解析建链
    no-impact → 加 noImpact 条目
    archive → 标 change-dir 链接为 archived
    align → 刷新指定 link 哈希（confidence 升级为 agent-confirmed）
  未解析的 code-edit → unresolved
  写 derivedThrough = { 末 seq, 事件日志哈希 }
```

- **自愈**：lock 损坏/缺失/手改污染 → 删掉重 `deriveLock` 即可（事件是真相）。这是 v0.1 可变单层 lock 不具备的。
- **auto-align 不静默钉死**：协同编辑产生的链接标 `confidence: auto-coedit`，与显式 `align`（`agent-confirmed`）区分。drift 报告可对低置信链接给不同措辞。语义正确性靠 code review，不是本工具职责——文档明确此边界。

---

## 九、关键旅程走查（覆盖 + 延迟 + 老问题命运）

| 旅程 | 本架构行为 | 解析层 | 延迟 | 老子系统 |
|---|---|---|---|---|
| J1 完整流不报 | 协同唯一 → T0 自动建链；hash 一致 → 无漂移 | T0 | 即时隐形 | alignedAtMs → **删** |
| J2 子代理实现 | 子代理 PostToolUse append；哈希变化被抓 | T0/T3 | 即时 | 输出文本 NLP → **删** |
| J3 事后改代码报 | codeHash ≠ lock → CODE_AHEAD | T3 | commit/check 时 | seq 重建 → **删** |
| J4 跨会话 vibe | 单 change-dir → 确定性建链；code 变 → 报 | T0/T3 | 近即时 | session 清零 → **溶解** |
| J5 改 tasks 报 design 落后 | tasksHash 变 → DOC_DOC_DRIFT | T3 | check 时 | 跨会话失效 → **溶解** |
| J6/7/8 子代理/plan/提问态 Stop | 哈希变 check 就抓；Stop 非权威 | T0/T3 | 即时 | 提问态识别 → 不需要 |
| J9 仅 proposal | 无 code link，无漂移 | — | — | stage 保留 |
| J10 规划完未实现 | design/tasks 互对齐、无 code link → 无漂移 | — | — | — |
| J11 无关代码 | unresolved → T1 nudge → agent 编辑塌缩 | T1→T0/T4 | 一轮内 | 归属歧义 → 显式 unresolved 状态 |
| J12 只读评审 | 无编辑 = 无哈希变 = 无漂移 | — | — | — |
| J13 多 change-dir | 同 J11，agent 编辑哪个 dir 就塌缩到哪个 | T1→T0 | 一轮内 | activeChangeDir 单值猜 → **溶解** |
| J14 TTL 过期 | **无 TTL 概念** | — | — | 整个 TTL 子系统 → **溶解** |
| J15 归档 | archive 事件 → link 标 archived | T0 | 即时 | 即时反映 → 事件回放 |
| J16 DTS | no-impact 事件 | T0 | 即时 | DTS 反推 → 显式声明 |

—— 体验：**常见即时无感，罕见歧义温和提示，任何情况不静默丢失**；4+ 个老子系统被**溶解**而非处理。

---

## 十、与 ECC 9 支柱对照（自审通过性）

| ECC 支柱 | v0.1 | v0.2 |
|---|---|---|
| P1 捕获用 PreToolUse/PostToolUse，弃 Stop | ✓ | ✓ + 权威下沉 sdd check |
| P2 append-only 事件日志，状态派生 | ❌ 可变单层 lock | ✅ link-events.jsonl + 派生 lock |
| P3 捕获（确定）/ 分析（延迟/LLM）分离 | ❌ 捕获即归属、prompt 阻塞 | ✅ 捕获确定性、解析分层非阻塞 |
| P4 schema 校验每次写入 | ⚠️ 延后 | ✅ 第一版即上 |
| P5 内容哈希追踪变更 | ✓ | ✓ |
| P6 迁移版本化 | ⚠️ | ⚠️（version 字段 + 事件可重放，迁移友好） |
| P7 幂等持久化 | ✓ | ✓（事件 seq 去重 + lock 派生幂等） |
| P8 可移植项目作用域 | ✓✓（in-repo，优于 ECC） | ✓✓ |
| P9 原子落盘 | ✓ | ✓ |

—— v0.2 把 v0.1 的两个 ❌（P2/P3）和一个 ⚠️（P4）补齐，达到 ECC v2 的可靠性纪律。

---

## 十一、与现有实现的根本区别

| 维度 | 当前实现 | 本架构 v0.2 |
|---|---|---|
| 漂移真相在哪 | session/project 隐藏 state | repo 内 `link-events.jsonl` + 派生 `sdd.lock` |
| 谁算漂移 | hook 在 Stop 重建 | 纯函数，任何触发器都能算 |
| 变更追踪 | **file mtime** | **内容哈希** |
| 基线 | alignedAtMs（墙钟 + mtime 混用） | 事件日志 + lock 哈希 |
| 捕获时机 | Stop 回溯 | 编辑当下 append（确定性） |
| 归属 | inline 猜测 | 分层解析，确定性优先，语义塌缩 |
| 权威 | Stop（丢了就漏） | sdd check（确定、可复现） |
| 单点 | Stop hook | 无（hook/CI/precommit/CLI 四重） |
| 可审计 | 否（隐藏目录） | 是（events + lock diff 进 PR） |
| 子代理 | 专门处理 + NLP | 透明（只看文件哈希） |

---

## 十二、诚实的代价（方法论转变）

1. **`link-events.jsonl` + `sdd.lock` 是要 checked-in 的产物**（像 package-lock）。
2. **忘了维护 = 报 unresolved/drift**——但这正是对的（老架构里"忘了"=静默漏报）。
3. **存量 repo 要一次 `sdd init`** bootstrap 初始事件/链接。
4. **design 意图仍不可从代码机械派生**——但对齐变成 checked-in、可审、可确定性验证、可重算自愈的事实。
5. **`sdd.lock` 当一等公民维护** + auto 链接只是低置信兜底，语义正确性靠 code review。

代价换来：漂移检测 = lockfile 校验（依赖管理领域最稳范式）+ ECC v2 的事件溯源可靠性纪律。

---

## 十三、薄弱点与开放问题（待压测）

1. **link 粒度**：design 段 ↔ 代码**文件**够不够？大文件多段设计共用一文件时，文件级哈希让无关改动也触发 stale。→ v2 上 AST 函数级，或 `code` 指向文件内命名区间。
2. **事件日志增长**：`link-events.jsonl` 无限追加。→ 周期性 compaction（保留派生 lock + 归档旧事件），类似 ECC 的 `observations.archive/`。
3. **`sdd.lock` / 事件日志合并冲突**：多人多分支。→ lock 按 id 排序、一 link 一块；事件日志按 seq append（冲突表现为两段 append，`deriveLock` 重放即合并）。
4. **稳定锚点维护**：design heading 加 `<!-- sdd-id -->` 旁注需要纪律。→ `sdd init` / lint 辅助补齐。
5. **no-impact 滥用**：agent 图省事全标 no-impact → 检测形同虚设。→ 需理由 + 进 PR 审 + 统计比例告警。
6. **解析层在哪进程跑**：T3 是 CLI/CI，但 T0 在 hook 内同步跑确定性解析的成本？→ 确定性解析是纯内存比对，成本极低；只有 `deriveLock` 全量重放在大事件日志上需注意（用 derivedThrough 增量）。

---

## 十四、下一步

倾向 **最小可验证原型**——这套架构的核心赌注是"drift = (工作树 + 事件日志) 的纯函数"，约 250 行就能证伪/证实，比继续写文档更快逼近真相：

1. `appendEvent()` + `deriveLock()` + `computeDrift()` 三个 Core 函数 + schema 校验
2. `link-events.jsonl` / `sdd.lock` 读写
3. 跑通 J1（happy 不报）/ J3（事后改报）/ J5（doc-doc）/ J11（unresolved → 塌缩）四条，验证理论

或先就薄弱点（**link 粒度** 或 **事件日志 compaction**）定方案再写代码。

---

## 十五、2026-05-29 Codex 评审意见

本节只追加当次评审意见，不修改前文 clean-slate 方案原文。

### 15.1 总体判断

v0.2 的大方向值得继续：把漂移真相从隐藏 session/project state 下沉到
`link-events.jsonl` + `sdd.lock`，并让 `sdd check` 成为确定性权威，比继续依赖
Stop / idle hook 更稳。这能明显改善跨会话、子代理、Stop 丢失、上下文压缩后遗忘等问题。

但当前草案还有几个会影响正确性的设计缝隙。最核心的风险是：方案把“捕获到了关联”
和“已经完成语义对齐”放得太近，可能把错误基线稳定地写进 lockfile。

### 15.2 主要问题

#### P0：`auto-coedit` 不能直接视为已对齐

文档中 T0 规则写的是：如果 code-edit 事件里的 `coEditedSddThisSession` 命中唯一
change-dir，就自动建链，`confidence: auto-coedit`。这只能证明“代码改动和某个 SDD
change 有关系”，不能证明“代码已经符合 design/tasks”。

典型反例：

1. agent 同一轮修改了 `design.md`、`tasks.md` 和代码。
2. 代码实际超出了文档范围，或者只实现了一部分。
3. T0 因为协同编辑唯一命中，直接把当前 codeHash 写入 `sdd.lock`。
4. 后续 `computeDrift()` 只比较当前 hash 与 lock hash，结果不再报警。

这会把“低置信归属”误升级成“干净基线”。

建议：

- `auto-coedit` 只能建立候选 link，状态应是 `needs-confirmation` 或
  `confidence: auto-coedit, aligned: false`。
- 只有显式 `align`、人工/agent review confirmation，或 `sdd resolve` 后，才能把该
  link 作为不报警基线。
- `sdd check` 对低置信、未确认 link 应至少给出 advisory，不能完全静默。

#### P0：事件 `seq` 的并发分配方案不完整

文档说 PostToolUse 直接 `appendFileSync` 到 `link-events.jsonl`，并提到 `seq 去重`。
但多 hook 进程、子代理、并行工具调用时，谁来分配全局递增 `seq` 没有说明。

如果两个进程同时读取末尾 seq，再各自 append，就可能产生重复 seq 或乱序事件。
这会直接影响 `derivedThrough.eventSeq`、事件回放顺序和 lock 派生结果。

建议二选一：

- 方案 A：追加事件前必须持有 `.sdd/link-events.jsonl.lock`，在锁内分配递增 seq，
  并原子 append。
- 方案 B：事件主键改为 UUID / hash event id，`seq` 只作为 `deriveLock()` 时的派生逻辑序号；
  排序规则使用 `{ts, session, eventId}` 或文件偏移。

如果希望 Git 合并更稳，建议优先考虑方案 B，避免跨分支全局 seq 冲突。

#### P1：`Read` 是否进入事件日志需要重新定义

§5.1 写的是 `PostToolUse(Edit/Write/MultiEdit/Read)` 无条件 append 原始事件，但事件类型
只定义了 `code-edit`、`doc-edit`、`no-impact`、`archive`、`align`。

这里存在语义空缺：

- 如果 Read 也 append，会导致只读 review 产生大量 checked-in 事件噪音。
- 如果 Read 不 append，§5.1 不应把 Read 放进捕获列表。
- 但“read/review 后确认无需修改”又是当前 SDD drift 里非常关键的闭环信号。

建议：

- 捕获层默认只记录写事件：`Edit` / `Write` / `MultiEdit`。
- 如需表达只读 review，单独定义 `doc-review` 事件。
- `doc-review` 只能作为 confirmation 输入，不能刷新内容 hash baseline。

#### P1：`sdd.lock` / `link-events.jsonl` 的 Git 合并策略过于乐观

文档认为事件日志 append 冲突会表现为两段 append，`deriveLock` 重放即可合并。但实际 Git
对同一 JSONL 文件尾部并发追加很容易产生文本冲突，尤其是同时维护递增 seq 时。

建议补充：

- 是否需要 `.gitattributes` merge driver。
- 是否提供 `sdd repair-events` 对事件日志去重、排序、规范化。
- `sdd.lock` 是否完全允许由 `deriveLock()` 重写，冲突时以事件日志重算为准。
- 多分支合并时，低置信 link / unresolved / noImpact 的冲突优先级。

#### P1：`no-impact` 是判断，不是原始事实

文档强调事件字段都是事实、无判断，但 `no-impact` 本身就是语义判断。它不能由捕获层自动生成，
只能来自显式用户声明、agent 明确声明或 CLI 操作。

建议：

- 把 `no-impact` 拆成确认类事件，例如 `impact-decision`。
- 字段里必须包含 `declaredBy`、`reason`、`source`、`relatedCodeHash`。
- `sdd check` 对 no-impact 的比例、重复模式或缺少理由的记录给出 warning，避免 agent 滥用。

### 15.3 建议调整后的最小原型范围

保留文档 §14 的最小原型方向，但建议把原型验收标准改得更严格：

1. `appendEvent()`：只捕获确定性写事件，事件必须有并发安全 id。
2. `deriveLock()`：能从事件日志重建 lock；`auto-coedit` 只能生成低置信未确认 link。
3. `computeDrift()`：对未确认 link、unresolved、hash drift 分别报告，不把低置信 link 当 clean baseline。
4. 增加 `align` / `doc-review` / `impact-decision` 的最小 confirmation 事件。
5. 跑通 J1 / J3 / J5 / J11 时，额外验证“同轮 co-edit 但未确认”不会被误判为完全对齐。

### 15.4 可以保留的强点

- append-only 事件日志作为真相源，这个方向是对的。
- `sdd.lock` 作为派生快照、PR 可审，这比隐藏 project state 更透明。
- Stop 降级为体验优化，`sdd check` 作为权威裁判，这能绕开 OpenCode / Claude hook 差异。
- 子代理不再靠输出文本 NLP，而是靠最终文件 hash 和事件日志，这个取舍更稳。
- 用内容 hash 替代 mtime / alignedAtMs，能解决大量跨会话和文件系统时间问题。

### 15.5 结论

该 clean-slate 方向可以继续推进，但不要直接进入完整重构。建议先修正上面的 P0/P1
设计点，再做一个极小原型验证：

- 事件捕获是否并发安全。
- lock 是否可从事件日志稳定重算。
- `auto-coedit` 是否只建立关联、不误清 drift。
- `sdd check` 是否能在没有 agent/Stop 的情况下可靠报出 unresolved 和 drift。

如果这些成立，再考虑替换当前 session/project state 架构。
