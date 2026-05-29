# SDD 漂移检测：边改边链 + Lockfile 架构（clean-slate）

**版本:** 0.4（草案）
**日期:** 2026-05-29
**作者:** Claude（Opus 4.7）+ 用户协同
**状态:** Clean-slate 备选架构——抛开当前实现包袱、不考虑向后兼容，仅保留用户核心需求重新设计。与 [prd](./sdd-drift-check-hook.prd.zh.md) / [design](./sdd-drift-check-hook.design.zh.md) 并列供对比决策。
**标尺:** everything-claude-code（ECC）真实源码 + 文档。本版按 ECC 的 9 条可靠性支柱自审并收敛。

### 修订记录

- **v0.4**（本版）：吸收 2026-05-29 Codex 第二轮增量评审（§17）的 6 点，并据 §18 最终结论收口——
  1. **§6.5 开放决策已定**：UNCONFIRMED 改**分层治理**（本地 advisory / CI 按 age+count 升级失败 / 受保护分支 `--require-aligned`）；严重度 `DRIFT > UNRESOLVED > UNCONFIRMED > ALIGNED`。
  2. **align 不再橡皮图章**：align 事件须记 `reviewed` 完整集合（code/design/tasks 的 path:hash）；computeDrift 判"当前哈希是否仍在确认集合内"。
  3. **event id 确定性 hash schema**：弃 UUID 歧义，明确参与字段 + 幂等键降级。
  4. **deriveLock 因果排序**：per-path `hashBefore→hashAfter` 链 + 决策事件跨路径关联；timestamp 仅排序/审计。
  5. **隐私/噪声边界**（§8.2）：事件只记 path/hash/类型/有限 rationale/来源/时间，不记 prompt/源码/输出/密钥。
  贯穿元原则见 §18.1：任何"判断"被静默当成"已验证事实"即 bug。
- **v0.3**：响应 2026-05-29 Codex 评审（§15）——5 点 P0/P1 收敛为 2 个根因修复 + 1 个待拍板决策。逐点响应见 §16。
  1. **事实事件 / 决策事件分离**（解 P0-1 / P1-1 / P1-3）：捕获层只产事实事件（`code-edit`/`doc-edit`，纯哈希）；对齐/无影响/审阅确认改为带 provenance 的决策事件（`align`/`impact-decision`/`doc-review`）。`auto-coedit` 只建**候选归属**且 `aligned:false`，绝不静默当干净基线。
  2. **内容寻址事件 id，弃全局 seq 权威**（解 P0-2 / P1-2）：event id = 内容哈希/UUID；顺序由 `deriveLock` 重放时计算；事件日志并集+去重合并；`sdd.lock` 永远重算、不手动合并。
  3. **待拍板决策**（§6.5）：happy-path 的 `UNCONFIRMED` 是否为可接受终态。`computeDrift` 改多态输出（ALIGNED/UNCONFIRMED/DRIFT/UNRESOLVED/ORPHAN）以承载此决策。
- **v0.2**：以 ECC 实现为标尺自审后的三项核心收敛——
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

每行一个不可变事件，**内容寻址 id**（非全局 seq）。v0.3 把事件分成**两类**：

**事实事件**（捕获层确定性产出，无判断，只有哈希）：

```jsonc
{ "id": "ev_<hash>", "ts": "2026-05-29T10:00:00Z", "session": "sess_A", "kind": "doc-edit",
  "path": "changes/greeting/design.md#greeting-behavior", "hashAfter": "sha256:d4e5f6" }
{ "id": "ev_<hash>", "ts": "2026-05-29T10:02:00Z", "session": "sess_A", "kind": "code-edit",
  "path": "src/greet.ts", "hashBefore": "sha256:00", "hashAfter": "sha256:a1b2c3",
  "coEditedSddThisSession": ["changes/greeting/design.md#greeting-behavior"],
  "activeChangeDirs": ["greeting"] }
```

**决策事件**（显式产生，带 provenance，**唯一能确立对齐/无影响**）：

```jsonc
{ "id": "ev_<hash>", "ts": "...", "session": "sess_A", "kind": "align",
  "link": "greeting-behavior", "scope": "changes/greeting",
  "reviewed": {                                                 // ★ v0.4：align 必须记完整确认集合（解 §17.5）
    "code":   { "src/greet.ts": "sha256:a1b2c3" },
    "design": { "changes/greeting/design.md#greeting-behavior": "sha256:d4e5f6" },
    "tasks":  { "changes/greeting/tasks.md#impl-greet": "sha256:11aa22" } },
  "declaredBy": "agent", "source": "stop-confirm", "reason": "design/tasks 反映当前代码行为" }
{ "id": "ev_<hash>", "ts": "...", "session": "sess_B", "kind": "impact-decision",
  "path": "src/legacy/shim.ts", "codeHash": "sha256:...", "decision": "no-impact",
  "declaredBy": "user", "source": "cli", "reason": "DTS-1234 hotfix，与任何 change 无关" }
{ "id": "ev_<hash>", "ts": "...", "session": "sess_B", "kind": "doc-review",
  "path": "changes/greeting/design.md#greeting-behavior", "reviewedHash": "sha256:d4e5f6",
  "declaredBy": "agent", "source": "read-confirm", "result": "no-change-needed" }
{ "id": "ev_<hash>", "ts": "...", "session": "sess_B", "kind": "archive",
  "changeDir": "changes/greeting", "declaredBy": "user", "source": "cli" }
```

- **事件 id = 确定性内容哈希**（弃 UUID 歧义，解 §17.3）。参与字段：
  - 事实事件：`hash(kind + path + hashBefore + hashAfter + idempotencyKey)`
  - 决策事件：`hash(kind + target + decision + relatedHashes + source)`
  - `idempotencyKey` 优先 `toolUseId`（重试幂等）；运行时无 toolUseId 时降级 `sessionId + sessionClock`（去重能力较弱，需显式标注）。**id 不含 timestamp**（否则重试生成重复事件）。
- **因果字段**（解 §17.4）：事件可带 `parentEventId` / `toolUseId` / `sessionClock` / `sourceRuntime`。同一 path 的因果连续性靠 `hashBefore → hashAfter` 链；跨 path 关联只由决策事件建立。`ts` 仅用于稳定排序与审计展示，**不是唯一因果权威**。
- 事实事件 `kind`：`code-edit` / `doc-edit`。决策事件 `kind`：`align` / `impact-decision` / `doc-review`。两类各一套 schema，每行校验。
- **隐私边界**（§8.2）：事件只记 path/hash/类型/有限 rationale/来源/时间——不记 prompt、源码正文、模型输出、密钥。

### 4.2 `sdd.lock`（派生快照，checked-in，PR 可审）

```jsonc
{
  "version": 1,
  "derivedThrough": { "eventId": "ev_<hash>", "eventLogHash": "sha256:..." },
  "links": [
    {
      "id": "greeting-behavior",
      "design": "changes/greeting/design.md#greeting-behavior", "designHash": "sha256:d4e5f6",
      "tasks": { "changes/greeting/tasks.md#impl-greet": "sha256:11aa22" },
      "code":  { "src/greet.ts": "sha256:a1b2c3" },

      // —— 归属轴（谁和谁相关；auto-coedit 可确定性建立）——
      "attribution": "auto-coedit",   // auto-coedit | auto-single | agent | llm

      // —— 对齐轴（是否确认为"干净基线"；★ 与归属正交，只能由 align 决策事件设）——
      "aligned": false,               // ★ v0.3 新增
      "alignedBy": null,              // { declaredBy, source, eventId } | null
      "alignedReviewed": null         // ★ v0.4：align 确认覆盖的完整 {code/design/tasks: path→hash} 集合；
                                      //         computeDrift 判"当前哈希是否仍在此集合内"（解 §17.5 align 橡皮图章）
    }
  ],
  "unresolved": [
    { "code": "src/payment.ts", "codeHash": "sha256:...", "candidates": ["greeting","refund"], "sinceEvent": "ev_<hash>" }
  ],
  "impactDecisions": [
    { "code": "src/legacy/shim.ts", "codeHash": "sha256:...", "decision": "no-impact",
      "declaredBy": "user", "reason": "DTS-1234 hotfix", "sinceEvent": "ev_<hash>" }
  ]
}
```

- **`attribution` 与 `aligned` 正交（v0.3 核心修正，解 Codex P0-1）**：归属 = "代码和哪个 SDD 元素相关"（`auto-coedit` 可确定性建立）；`aligned` = "是否已确认为干净基线"——**只能由 `align` 决策事件置 true**，捕获层/协同编辑永远设不了。
- `derivedThrough`：lock 派生到哪个 event id。日志更新 → 重派生；lock 损坏/缺失 → 从 `link-events.jsonl` + 工作树**全量重算自愈**。
- `unresolved`：归属待定的代码编辑——可见状态，不是丢失。
- `impactDecisions`：显式"与 SDD 无关"的**决策**（非事实），带 `declaredBy`/`reason`（解 Codex P1-3）。

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
PostToolUse(Edit / Write / MultiEdit):     ← 只捕获写事件（v0.3 修正：移除 Read，解 Codex P1-1）
  1. 算目标文件/段落的内容哈希
  2. 组装事实事件（code-edit 或 doc-edit）：
       - 内容寻址 id、路径、hashBefore/After
       - 本会话至此协同编辑过的 SDD 元素集合
       - repo 内当前未归档 change-dirs
  3. 持锁 append 到 link-events.jsonl       ← 一行，内容寻址 id 幂等去重
```

**绝不注入 prompt、绝不等 agent、绝不读返回。** 可靠性等同"往文件追加一行"，不依赖 LLM/平台投递。这是公理 2 捕获层、也是风险 1 的根治。

**Read 不进事实事件**（解 Codex P1-1）：只读 review 不产生 checked-in 噪音。"读完确认无需修改"这个闭环信号走**显式 `doc-review` 决策事件**（§4.1），它只作为 confirmation 输入，**不刷新内容哈希基线**。

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
  if e.coEditedSddThisSession 命中唯一 change-dir
       → 建**候选归属** link（attribution: auto-coedit, aligned: false）
  elif 项目内唯一未归档 change-dir
       → 建**候选归属** link（attribution: auto-single, aligned: false）
  else → 留 unresolved，记 candidates
```

J1/J2/J4/J6/J7 的**归属**全走这条、无需 LLM。但**只建归属、不设对齐**——`aligned` 始终 false，除非有 `align` 决策事件（解 Codex P0-1）。"归属确定" ≠ "代码已符合 design"。

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

### 6.5 happy-path 对齐策略：分层治理（v0.4 已定，吸收 §17.2）

上轮留的 A/B 开放决策，被 Codex §17.2 用**分层治理**回答：不是二选一，而是**按运行环境分层**。computeDrift 多态输出（§7）让 `aligned:false` 落在 `UNCONFIRMED`（不是 `DRIFT`），再按环境施加不同治理压力：

| 环境 | UNCONFIRMED | UNRESOLVED | 退出码 |
|---|---|---|---|
| 本地交互（默认 `sdd check`） | advisory，提示不阻断 | warning | 0 |
| CI（`sdd check --ci`） | 超 `--max-unconfirmed-age` / `--max-unconfirmed-count` → 失败 | 默认失败 | 非零 |
| 受保护分支 / 发布门（`--require-aligned`） | 全部须显式 `align` | 失败 | 非零 |

设计取舍：
- 本地不打扰 agent（满足"happy path 不烦"），但 `UNCONFIRMED` 是**诚实状态**——不会被误标 `ALIGNED`（§17.2：advisory 永远比误判 clean 安全）。
- CI / 发布门提供**治理压力**，防止"未确认但不阻断"的关系无限积累、弱化 SDD 约束。
- 工具**本就无法验证语义对齐**，只追踪"有没有人显式声明 + 声明后内容有没有变"；强制 align 也只是"agent 声称"，故强制只在受保护分支开启。

---

## 七、校验层（drift 纯函数）

**多态输出（解 Codex P0-1 / §17.5 / §17.7）**：按 link 的 `aligned`、是否落在已确认集合、内容哈希分态：

```
computeDrift(工作树, sdd.lock) → DriftReport:    # 纯函数，无副作用
  for link in lock.links:
    if link.aligned == false:
        → UNCONFIRMED        # 已归属、从未确认对齐（含 auto-coedit）。advisory
    else:  # aligned == true：曾被 align 确认，alignedReviewed 记录了确认集合
        if 当前 {code/design/tasks 哈希} 全部 ∈ link.alignedReviewed
            → ALIGNED         # 当前版本仍在被确认过的集合内 → 静默
        elif 当前 code 哈希 ∉ alignedReviewed.code   → CODE_DRIFT    # 确认后代码又变
        elif 当前 design 哈希 ∉ alignedReviewed.design → DOC_DRIFT
        else → DOC_DOC_DRIFT
  + lock.unresolved 非空 → UNRESOLVED        # 无归属（风险高于 UNCONFIRMED）
  + 改动过、不属于任何 link/unresolved/impactDecision 的 code → UNLINKED
  + 指向已删除文件/段落的 link → ORPHAN

严重度优先级（§17.7）：DRIFT > UNRESOLVED > UNCONFIRMED > ALIGNED

退出码（分层治理，§6.5）：
  本地 sdd check：    DRIFT 非零；UNRESOLVED/UNCONFIRMED → 0（advisory/warning）
  sdd check --ci：    DRIFT 非零；UNRESOLVED 非零；UNCONFIRMED 超 --max-unconfirmed-age/count 非零
  --require-aligned： 任何非 ALIGNED（含 UNCONFIRMED）非零
```

**两条关键区分：**
- `UNCONFIRMED`（从未确认）≠ `DRIFT`（确认后又变）——auto-coedit 落 UNCONFIRMED，不算误报漂移。
- `align` 凭 `alignedReviewed` **集合成员判定**，而非单快照比较——确认只对"当时审过的那组哈希"有效，换内容即脱离集合（防 align 橡皮图章，§17.5）。

只有 `当前内容哈希 vs 已确认集合`。**无 transcript、无 mtime、无 NLP、无 session 状态、无 TTL、无 alignedAtMs。** git checkout / 格式化改 mtime → 不误报。会话崩溃 / Stop 被丢 → 不丢真相（事件在 repo）。

---

## 八、lock 派生与自愈

```
deriveLock(events, 工作树) → sdd.lock:
  1. 去重：按 event id（确定性哈希）去重（幂等）
  2. 排序：per-path 用 hashBefore→hashAfter 链确定因果序；跨 path 由决策事件关联；
           {ts, session, sessionClock} 仅做稳定排序 / 审计 tiebreak（非因果权威，§17.4）
  3. 回放：
     code-edit / doc-edit（事实）→ 更新元素哈希、跑确定性解析建**候选归属**（aligned: false）
     align（决策）            → 置 link aligned: true + alignedBy + alignedReviewed（完整确认集合）
     impact-decision（决策）   → 加 impactDecisions（带 declaredBy/reason）
     doc-review（决策）        → 记 review confirmation（不改哈希基线）
     archive（决策）          → 标 change-dir 链接为 archived
  4. 未解析的 code-edit → unresolved
  5. 写 derivedThrough = { 末 event id, 事件日志哈希 }
```

- **自愈**：lock 损坏/缺失/手改污染 → 删掉重 `deriveLock` 即可（事件是真相）。
- **只有 align 决策事件能设对齐基线**，且记 `alignedReviewed` 完整集合——事实事件永远只建归属、`aligned:false`（解 Codex P0-1 / §17.5）。

### 8.1 Git 合并与并发（解 Codex P0-2 / P1-2）

- **事件 id 内容寻址** → `link-events.jsonl` 实质是**无序集合**；多分支合并 = 两段 append 的**并集**，按 id 去重，与行序无关。
- **`sdd.lock` 永不手动合并**：纯派生物，冲突时丢弃手动结果、`deriveLock` 重算为准。建议 `.gitattributes` 对 `sdd.lock` 配 `merge=ours` + pre-commit 重新生成。
- **`sdd repair-events`**：对事件日志去重、规范化排序、修复格式，处理极端文本冲突。
- **并发 append**：同机多进程/子代理同时写，持 `.sdd/link-events.jsonl.lock` 短锁 append（内容寻址 id 让"漏锁重复写"也能在 deriveLock 去重时自愈）。

### 8.2 隐私与噪声边界（解 Codex §17.6）

`link-events.jsonl` 是 checked-in 工件，**必须无敏感内容**：

- **只记**：path、内容 hash、事件类型、来源（source/declaredBy）、时间、有限 `rationale`。
- **绝不记**：prompt 原文、源码正文、模型完整输出、密钥/环境变量/请求体。
- `rationale` 限长（如 ≤ 200 字符），防 agent 写入大段上下文或意外带入敏感信息。
- 哈希不可逆——事件日志即便泄露也不暴露内容。

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

| ECC 支柱 | v0.1 | v0.2 | v0.3 |
|---|---|---|---|
| P1 捕获用 PreToolUse/PostToolUse，弃 Stop | ✓ | ✓ + 权威下沉 sdd check | ✓ |
| P2 append-only 事件日志，状态派生 | ❌ | ✅ | ✅ + 内容寻址 id（弃全局 seq） |
| P3 捕获（确定）/ 分析（延迟/LLM）分离 | ❌ | ✅ | ✅ + **事实/决策事件分离**（对应 ECC governanceEvent 的 payload/resolution 分离） |
| P4 schema 校验每次写入 | ⚠️ | ✅ | ✅ 事实 / 决策两套 schema |
| P5 内容哈希追踪变更 | ✓ | ✓ | ✓ + **归属/对齐双轴**，哈希只在 align 时定基线 |
| P6 迁移版本化 | ⚠️ | ⚠️ | ⚠️（version + 事件可重放） |
| P7 幂等持久化 | ✓ | ✓ | ✓ 内容寻址 id 天然幂等 |
| P8 可移植项目作用域 | ✓✓ | ✓✓ | ✓✓ |
| P9 原子落盘 | ✓ | ✓ | ✓ + 持锁 append |

—— v0.3 在 v0.2 基础上补齐 Codex 指出的两个根因（事实/决策混淆、全局 seq 权威），并把 P0-1 的"协同≠对齐"落到数据模型（归属/对齐双轴）。

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
3. **`sdd.lock` / 事件日志合并冲突**：→ v0.3 已纳入设计（§8.1）：内容寻址 id + 并集合并 + lock 重算优先 + `sdd repair-events`。
4. **稳定锚点维护**：design heading 加 `<!-- sdd-id -->` 旁注需要纪律。→ `sdd init` / lint 辅助补齐。
5. **impact-decision 滥用**：agent 图省事全标 no-impact → 检测形同虚设。→ v0.3 已要求带 `declaredBy/reason`；`sdd check` 对 no-impact 比例 / 缺理由告警。
6. **解析层在哪进程跑**：T0 hook 内同步跑确定性解析的成本？→ 纯内存比对，成本极低；`deriveLock` 全量重放用 `derivedThrough` 增量。
7. **`aligned` 的语义边界（v0.3 明确）**：工具**只追踪"有没有人显式声明对齐 + 声明后内容有没有变"**，不验证"代码语义是否真符合 design"（后者只能靠 code review）。`aligned:true` = "有人声明过"，不是"已验证正确"。
8. **happy-path 终态策略**：→ v0.4 已定（§6.5 分层治理：本地 advisory / CI 升级 / `--require-aligned`）。
9. **align 橡皮图章 / event id / 因果排序 / 隐私**：→ v0.4 已纳入（align 记 `alignedReviewed` 集合 §17.5；确定性 id schema §17.3；hashBefore→hashAfter 因果链 §17.4；事件日志隐私边界 §8.2）。
10. **link 粒度 / 事件日志 compaction**：仍是 v1→v2 待压测项（§17.8 列为原型后续）。

---

## 十四、下一步

倾向 **最小可验证原型**——核心赌注是"drift = (工作树 + 事件日志) 的纯函数"，约 250 行就能证伪/证实。**采纳 Codex §15.3 的更严验收**：

1. `appendEvent()`：只捕获确定性**写**事件，事件用**内容寻址 id**（并发安全）。
2. `deriveLock()`：能从事件日志稳定重建 lock；`auto-coedit` 只生成 `aligned:false` 候选 link。
3. `computeDrift()`：对 `UNCONFIRMED` / `UNRESOLVED` / `DRIFT` 分别报告，**不把 auto-coedit link 当 clean baseline**。
4. 实现 `align` / `doc-review` / `impact-decision` 最小决策事件。
5. 跑通 J1 / J3 / J5 / J11，**额外验证**："同轮 co-edit 但未 align" → 输出 `UNCONFIRMED`（不是 ALIGNED、也不是 DRIFT）；事件捕获并发安全；lock 可从日志稳定重算；`sdd check` 在无 agent/Stop 时可靠报出 unresolved/drift。

推进顺序见 §18.4：**先锁定语义决策**（§6.5 分层治理、§4.1 align reviewed 字段、§8.2 隐私边界——v0.4 已写入），**机械决策由原型实证**（event id schema、deriveLock 排序），再做完整重构——不盲目实现，也不分析瘫痪。

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

---

## 十六、v0.3 对 Codex 评审的响应（2026-05-29）

本节是 v0.3 对 §15 评审的逐点响应。结论：**5 点全部采纳**，收敛为 2 个根因修复 + 1 个待拍板决策。本节只追加，不修改 §15 原文。

### 16.1 逐点响应

| Codex 点 | 采纳 | 根因 | v0.3 处置 | 改动章节 |
|---|---|---|---|---|
| P0-1 auto-coedit ≠ 已对齐 | ✅ | 混淆"归属"与"对齐" | link 拆 `attribution` / `aligned` 双轴；`aligned` 只能由 `align` 决策事件设；computeDrift 多态，auto-coedit 落 `UNCONFIRMED`（advisory）不当 clean baseline | §4.2 / §6.1 / §7 / §8 |
| P0-2 seq 并发分配未定义 | ✅ | 全局 seq 当权威 | 事件 id 内容寻址（弃全局 seq）；顺序 deriveLock 重放时算；持锁 append + 去重 | §4.1 / §8.1 |
| P1-1 Read 是否进日志 | ✅ | 捕获层职责不清 | 捕获只记写事件；Read 不进事实事件；review 闭环走显式 `doc-review` 决策事件 | §5.1 / §4.1 |
| P1-2 git 合并过于乐观 | ✅ | 同 P0-2（行序依赖） | 内容寻址 → 并集合并；lock 永不手合、重算优先；`.gitattributes` + `sdd repair-events` | §8.1 |
| P1-3 no-impact 是判断非事实 | ✅ | 事实/决策混淆 | `no-impact` → `impact-decision` 决策事件，带 `declaredBy/reason/source`；比例告警 | §4.1 / §4.2 |

### 16.2 两个根因（5 点收敛）

- **根因 A：事实事件 vs 决策事件混淆**（吞掉 P0-1 / P1-1 / P1-3）。捕获层只产确定性事实事件；对齐/无影响/审阅确认是带 provenance 的决策事件。对应 ECC `governanceEvent` 的 payload（事实）/ resolution（决策）分离——v0.2 没学到位。
- **根因 B：全局递增 seq 当排序与合并权威**（吞掉 P0-2 / P1-2）。改内容寻址 id + deriveLock 重放算序 + 并集合并。

### 16.3 在 Codex 之上补的一刀：happy-path 张力

P0-1 修复（auto-coedit 不设对齐）会反噬"happy path 不烦"——Codex 未点透、但须产品拍板。v0.3 用 **computeDrift 多态输出** 化解：auto-coedit 落 `UNCONFIRMED`（advisory，不算误报漂移），真 block 级 `DRIFT` 只发生在**确认过**的 link 又变。终态策略（A UNCONFIRMED 可作终态 / B 强制 align-once）见 **§6.5，待拍板**。

### 16.4 共识保留（Codex §15.4）

append-only 事件日志为真相、`sdd.lock` 派生可审、Stop 降级 + `sdd check` 权威、子代理靠哈希不靠 NLP、内容哈希替代 mtime/alignedAtMs——方向不变。

### 16.5 一致结论

与 Codex 一致：**先修完 P0/P1（v0.3 已落文档）+ 拍板 §6.5，再做极小原型验证，不直接进完整重构。**

---

## 十七、Codex 增量评审意见（2026-05-29）

本节是在 v0.3 响应基础上的二次增量评价。只追加评审意见，不修改前文设计正文。

### 17.1 总体判断

v0.3 已经吸收上一轮评审的关键问题，特别是：

- 事实事件与决策事件分离。
- `auto-coedit` 不再直接等同于已对齐。
- 去掉全局 `seq` 权威，改为事件集合去重与 `deriveLock()` 派生。
- Read 不再作为 review 证据。
- 将 `UNCONFIRMED` 是否可作为 happy path 终态暴露为产品决策。

因此，v0.3 可以作为下一阶段设计基础。但在进入完整实现前，仍建议先补齐下面几个协议级决策，否则实现后容易在并发、跨会话、CI 策略和审计语义上反复返工。

### 17.2 P0：`UNCONFIRMED` 不能永远只是 exit 0 提醒

`UNCONFIRMED` 比误判为 `ALIGNED` 更安全，但如果它长期保持 advisory 且没有任何治理压力，团队可能会积累大量“未确认但不阻断”的关系。这样虽然避免了误阻断，却会弱化 SDD 同步检查的约束力。

建议将运行策略拆成两类：

- 本地交互模式：`UNCONFIRMED` 默认 exit 0，只做提示，避免干扰 agent 正常开发。
- CI / main 分支 / 发布前模式：允许将过期或过量的 `UNCONFIRMED` 升级为失败。

建议补充配置项：

- `--max-unconfirmed-age`：未确认关系超过指定时长后失败。
- `--max-unconfirmed-count`：未确认关系超过指定数量后失败。
- `--require-aligned`：要求所有相关 link 都显式 `align` 后才通过。
- `--ci`：启用更严格的默认策略。

推荐默认策略：

- `sdd check`：本地 advisory，`UNCONFIRMED` exit 0。
- `sdd check --ci`：对 stale / excessive `UNCONFIRMED` 失败。
- protected branch 或 release gate：可配置为 `--require-aligned`。

### 17.3 P0：事件 ID 规则必须精确定义

文档目前提到 content hash / UUID，但二者语义不同，不能作为同一层抽象混用：

- content-addressed id 适合确定性去重、重试幂等、Git 合并。
- UUID 适合唯一记录一次发生，但无法天然判断重复事件。

建议优先选择确定性 hash 作为主 id，并明确参与 hash 的字段。

建议事实事件 id：

```text
hash(kind + path + hashBefore + hashAfter + toolUseId/sessionId)
```

建议决策事件 id：

```text
hash(kind + target + decision + relatedHashes + source)
```

需要注意：

- 如果 id 包含 timestamp，重试写入可能生成重复事件。
- 如果 id 排除过多上下文字段，不同事件可能被错误合并。
- 如果某些运行时没有 `toolUseId`，需要定义降级字段，例如 `sessionId + localClock` 或显式 nonce；同时说明该降级模式的去重能力较弱。

### 17.4 P1：`deriveLock()` 的排序不能只依赖时间

`{ts, session, id}` 可以提供稳定排序，但不能保证真实因果顺序。跨会话、子任务、系统时间漂移、Git 合并都会削弱 timestamp 的语义。

建议事件结构尽量记录可用的因果字段：

- `parentEventId`
- `toolUseId`
- `observedAfter`
- `sessionClock`
- `sourceRuntime`

建议文档明确：

- timestamp 只用于稳定排序和审计展示，不作为唯一因果权威。
- 同一路径链路内优先使用 `hashBefore/hashAfter` 判断连续性。
- 跨路径关系由显式决策事件，例如 `align` / `impact-decision` / `doc-review`，建立语义关联。

### 17.5 P1：`align` 事件不能成为新的橡皮图章

`align` 是强决策事件，如果只记录“已确认”，它会变成新的误清 drift 入口。建议 `align` 必须记录本次确认覆盖的输入集合。

建议最小字段：

```json
{
  "kind": "align",
  "scope": "sdd/changes/feature-a",
  "reviewed": {
    "code": ["path:hash"],
    "design": ["path:hash"],
    "tasks": ["path:hash"]
  },
  "decision": "aligned",
  "rationale": "design and tasks reflect current code behavior",
  "declaredBy": "agent",
  "source": "sdd check",
  "createdAt": "..."
}
```

这样 `computeDrift()` 才能判断：当前文件 hash 是否仍处于被确认过的集合内。否则 `align` 只能说明“某一刻有人说过对齐”，不能说明“当前版本仍然对齐”。

### 17.6 P1：事件日志需要隐私和噪声边界

事件日志如果作为可提交工件，需要明确不会记录敏感内容。建议文档增加边界说明：

- 不记录 prompt 原文。
- 不记录源码正文。
- 不记录模型完整输出。
- 不记录密钥、环境变量、请求体。
- 默认只记录 path、hash、事件类型、有限 rationale、来源和时间。

`rationale` 也建议限制长度，避免 agent 写入大段上下文或意外包含敏感信息。

### 17.7 P1：`UNRESOLVED` 不应与普通 advisory 混为一类

`UNCONFIRMED` 表示“有候选关联，但缺少显式确认”。`UNRESOLVED` 表示“代码或文档变化无法归属到任何 SDD 关系”。后者风险更高。

建议策略：

- 本地交互：`UNRESOLVED` 可以先 warning，不强制阻断 agent。
- CI / 发布前：`UNRESOLVED` 默认应比 `UNCONFIRMED` 更严格。
- 文档应明确二者优先级：`DRIFT` > `UNRESOLVED` > `UNCONFIRMED` > `ALIGNED`。

### 17.8 建议的实现前置决策

在进入完整重构前，建议先拍板以下事项：

1. `UNCONFIRMED` 的默认策略：本地 advisory，CI 可升级失败。
2. event id 的确定性 hash schema。
3. `align` / `doc-review` / `impact-decision` 的最小字段。
4. `deriveLock()` 的排序与因果规则。
5. 事件日志的隐私边界与 rationale 长度限制。

这些决策确认后，再做极小原型更稳。原型目标不是完整替换当前实现，而是验证三件事：

- 事件日志能否稳定去重和合并。
- `sdd.lock` 能否完全由事件日志重建。
- `computeDrift()` 能否区分 `ALIGNED` / `UNCONFIRMED` / `UNRESOLVED` / `DRIFT`，且不会把候选关联误判为 clean baseline。

---

## 十八、最终评审结论（v0.4 基线）

经两轮 Codex 评审（§15 / §17）+ 两次响应（§16 / 本节），本设计收口。本节是**最终结论**，并据此把正文升到 v0.4。

### 18.1 一条贯穿两轮的元原则

两轮评审每个问题，根上都是同一句话：

> **任何"判断"被静默当成"已验证的事实"，就是 bug。**

- 第一轮 P0-1：`auto-coedit`（判断"相关"）被当成 `aligned`（事实"已对齐"）。
- 第二轮（§17.5）：`align`（某刻的判断）被当成"当前仍对齐"（持续事实）——橡皮图章。
- 第二轮（§17.3）：UUID（仅"发生过一次"）被当成"可判重"（确定性事实）。
- 第二轮（§17.2）：`UNCONFIRMED` 永久 advisory（弱约束）被当成"治理已覆盖"（已管控事实）。

**收口准则（v0.4 数据模型公理）**：系统必须始终区分"声称"与"当前已验证"，且每个声称必须携带 (a) **provenance**（谁/何源声明）、(b) 它覆盖的**确切输入集合**（`alignedReviewed`）、(c) **新鲜度/治理策略**（§6.5 分层）。

### 18.2 §6.5 开放决策 → 已定：分层治理（采纳 §17.2）

Codex §17.2 实际**回答了** §6.5 留的 A/B 开放问题——不是二选一，而是**按运行环境分层**（详见 §6.5 表）。严重度优先级（§17.7）：**`DRIFT` > `UNRESOLVED` > `UNCONFIRMED` > `ALIGNED`**。§6.5 不再开放。

### 18.3 全盘采纳 §17 的 6 点，落点

| §17 点 | 落到正文 |
|---|---|
| 17.2 UNCONFIRMED 治理 | §6.5 分层策略 + §7 退出码 |
| 17.3 event id 确定性 hash | §4.1（fact/decision 各自 hash 字段 + 幂等键降级） |
| 17.4 deriveLock 因果排序 | §8（hashBefore→hashAfter 链 + 决策事件跨路径；ts 仅排序/审计） |
| 17.5 align 须记 reviewed 集合 | §4.1 align 事件 reviewed + §4.2 lock alignedReviewed + §7 成员判定 |
| 17.6 隐私/噪声边界 | §8.2 |
| 17.7 UNRESOLVED 单列 | §7 严重度优先级 + 差异化 CI 策略 |

### 18.4 我的平衡建议：决策门别变成停滞

§17.8 列了 5 个实现前置决策。我的判断：**语义类决策现在锁定**（UNCONFIRMED 分层策略、align reviewed 字段、隐私边界——v0.4 已写入正文）；但**机械类决策（event id hash schema、deriveLock 排序）应由原型实证、而非纸面敲死**——它们的对错只有"跑一遍去重/重建"才知道。

故 v0.4 推进顺序：
1. **锁定**语义决策（已写入 §6.5 / §4.1 align / §8.2）。
2. **草拟**机械决策（§4.1 id schema / §8 排序），标注"原型验证项"。
3. **极小原型**验证三件事（§14）：去重合并稳定、lock 可从事件全重建、computeDrift 四态不混（候选不当 clean baseline）。
4. 通过后再考虑替换当前 session/project state 架构。

—— 不"盲目实现"，也不"分析瘫痪"。

### 18.5 结论

v0.4 已把两轮评审全部吸收。**方向确定、协议级语义锁定、机械细节交原型实证。** 下一步是 §14 的 ~250 行原型，而非完整重构。

---

## 十九、第三轮复审意见（2026-05-29，多代理对抗评审）

本节只追加，不修改前文（与 §15 / §17 同体例）。评审方法：5 个独立视角（产品策略 / 数据模型正确性 / 需求覆盖回归 / "不误报"核心承诺 / 评审回音壁元批判）各自产出 finding，逐条经对抗性验证者核对原文（含 §13 / §15–§18）后定级——已被前两轮处理的点不再重列。共产出 36 条，33 条通过验证，3 条被证伪剔除。

### 19.1 总体判断

方向有真实价值，但**核心赌注尚未成立**。整个架构压在 §3 / §14 的一句话上——"漂移真相 = (工作树 + 事件日志) 的纯函数"。经核对，这个纯函数性在三处被方案自己的规则破坏（§19.3）；在补上之前，"自愈""稳定重算""权威下沉"都还是未兑现的承诺，§14 的 250 行原型也会因只跑单进程 happy-path 而给出"纯函数当然是纯函数"的虚假信心。

### 19.2 元发现：两轮评审的三个盲区（回音壁效应）

§15 / §17 两轮把**数据模型的语义自洽**打磨得很好，但系统性地漏掉了三个维度，且每轮都在"判断 vs 事实"这条线上加机制、未回头质疑前提：

1. **运行时现实**：没人问"这套捕获在 OpenCode 上能不能 100% 成立"。
2. **产品定位**：没人问"权威下沉到 `sdd check` 后，它还是不是用户当初要的那个'实时纠偏 agent'的工具"。
3. **误报率**：需求内核第一句是"不误报"，但全文无任何误报率目标、无净误报对账，§14 验收也不含误报维度。

### 19.3 P0：核心赌注（纯函数性）实际不成立 —— 三处独立破裂（全部 confirmed）

#### 19.3.1 `deriveLock` 跨会话塌缩无确定性规则（§6.2 ↔ §8 / §17.4 自相矛盾）

§6.2 的 J11/J13 塌缩靠"较早的 unresolved code-edit"与"较晚的 doc-edit"关联建链；但 §4.1/§8/§17.4 三处都声明"跨 path 关联**只由决策事件**建立""ts 非因果权威"，而一条普通 doc-edit 是**事实事件**。

> 逼问：当日志里只有两条事实事件（unresolved code-edit + doc-edit），`deriveLock` 凭哪个字段确定性地认定这条 doc-edit "解决了"那条 code-edit？

唯一可用线索是时间先后，而 §17.4 恰恰否定它。更尖锐：session B 同轮整理了两个候选 dir（`{greeting, refund}` 都被编辑），无任何确定性 tiebreak。而且 §6.2 的塌缩在**可执行规范里根本不存在**——§6.1 `resolveDeterministic` 只按 code-edit 自身字段建链，不含"后来的 doc-edit 命中候选→建跨 path 链"这条规则，§6.2 只是叙述性文字。**修法**：把 J11/J13 塌缩升级为显式 `resolve-attribution` 决策事件（携带 code path、target dir、relatedHashes）。

#### 19.3.2 两分支各 align 同一 link → 合并后结果歧义（§8.1 只处理去重，未处理冲突决策）

标准 git 协作：分支 X 与 Y 各对同一 link append align，因两边代码已分叉，`alignedReviewed.code` 不同 → 两个 align 事件 id 不同 → **去重不合并**。union 后日志里并存两个同 target 的 align，§8 回放规则是"**置** aligned:true + alignedReviewed"（覆盖语义），谁赢取决于回放顺序，而顺序由非权威 ts 决定。后果：(a) `deriveLock` 不再是纯函数，打穿 §3 核心不变量；(b) 可产生静默 false-clean（一侧 reviewer 的声称被套用到另一侧未验证代码），违反 §1"不漏报"与 §18.1 元原则。**修法**：定义 per-`(kind,target)` 的冲突决策归并规则（并集/交集/`supersedes` 显式偏序），绝不落到 ts 兜底；补一条 J17 走查。

#### 19.3.3 "捕获 100% 确定性"对 OpenCode 不成立，且漏一次永久丢归属

§五标题"100%"与 §5.1"不依赖平台投递"是地基，但对方案承诺支持的 OpenCode：OpenCode **无原生 PostToolUse**（用 `tool.execute.after` 转换、依赖平台投递）；实现文档 L582"shell 重定向写文件对 hook 不一定可见"；子代理 hook 未注册其编辑不产生事件——§5.2 自己已承认捕获非 100%。致命点：`sdd check` 事后重算工作树哈希能恢复"内容有没有变"，**但永远无法恢复 `coEditedSddThisSession`**（只能在捕获当下记录）。于是 OpenCode 上一旦漏捕获，§6.1 第一条建链失效 → 永久落 `unresolved` → **J1/J2/J4 这些"应无提醒"的 happy path 退化成 UNRESOLVED 噪音**。**修法**：把 §五标题"100%"改为诚实的"尽力捕获 + sdd check 兜底（兜内容、兜不了协同归属）"，并补一节捕获漏失下的归属降级分析。

> 三条共同证明纯函数性目前不成立。**这三处是决定核心赌注成败的语义协议，不能像 §18.4 说的"交原型实证"——必须先在纸面解决**；其余（event id schema、UNCONFIRMED 阈值）才适合原型实证。

### 19.4 P1：产品定位被悄悄迁移（实时纠偏 agent → commit-time linter）

| # | finding | 级别 | 要点 |
|---|---|---|---|
| 1 | OpenCode 下 `sdd check` 谁触发无人回答 | **HIGH（confirmed）** | 无 CI / 不 commit 的 vibe 用户，T3 权威层永不触发；会话内只剩被标"可丢"的 Stop nudge，相对当前 `tool.execute.after` 投递通道是退化。缺一节"`sdd check` 触发矩阵"。 |
| 2 | J5 方向性 doc-doc 信号丢失 | **HIGH（confirmed）** | `DOC_DOC_DRIFT` 只在 `aligned==true` 分支可达，J5 历史 dir 几乎从未 align → 被短路成 `UNCONFIRMED`，永远走不到；即便走到也无方向。回归当前 `TASKS_PENDING_DESIGN`。§7 ↔ §9 矛盾。 |
| 3 | J1"无提醒"回归 | MEDIUM | 无人 align → `aligned:false` → `UNCONFIRMED`（本地 advisory，有文本），违反 PRD J1"无任何 drift 文本"。§9"即时隐形" ↔ §7 自相矛盾，§14 又把"未 align→UNCONFIRMED"列为正确行为坐实之。 |
| 4 | 会话内实时提醒被标"可丢" | LOW | 方案把"审计正确性升级"误当成"对核心用途的全面改进"，混淆两个维度；未论证无 CI 用户的提醒触达。 |
| 5 | J8 PreToolUse 提问/交接 checkpoint 丢失 | MEDIUM（confirmed） | 三层架构无对应触发器，被"提问态识别→不需要"一句默默丢弃。 |
| 6 | J12 `doc-review` 是死输入 | MEDIUM | §8 记了它，§7 computeDrift 从不消费；"读完确认无需改文档"无法消解 UNCONFIRMED，必须额外 align。 |
| 7 | J16（DTS）退化 | LOW | 从"prompt 标记即整轮零工件跳过"变成"逐文件写 checked-in impact-decision"。 |

### 19.5 P1："不误报"这一第一验收标准未被证明兑现

- **§7"格式化不误报"是错误的正确性声明**（MEDIUM）：把"mtime-免疫"偷换成"格式-免疫"。`git checkout` 安全，但 gofmt/prettier/CRLF 归一化改字节 → 改哈希 → 对已 aligned link 报 CODE_DRIFT。必须删改这句。
- **文件级代码哈希**（MEDIUM，§13.1 自承但定级偏轻）：真实文件多关注点，align 后改同文件无关函数 → 误报。
- **markdown 段落哈希脆弱**（MEDIUM）：错别字/润色/reflow 改哈希；§4.3"到下一个同级/更高级 heading 的 body"对**嵌套子标题归属未定义**（新增低级子标题会卷进父段哈希）。
- **净误报从未对账**（MEDIUM）：消除一类 mtime 误报，同时引入文件级 / 重格式化 / 锚点 ORPHAN / UNCONFIRMED 噪音四类。§14 应加"同一编辑序列两套方案误报对账"。
- **ORPHAN 是治理盲区**（MEDIUM）：`ORPHAN`/`UNLINKED` 既不在 §7 严重度链、也不在退出码规则里。"agent 把一节移到另一文件、忘搬 `sdd-id`，`--ci` 是 fail 还是 pass？"无法回答。lint 能查"缺 id"，无法语义重关联"内容搬到了哪"。

### 19.6 P2：采纳成本与迁移悬崖（被低估）

- **存量 repo 冷启动**（MEDIUM）：PRD J4 前置"changes mode"表明存量是一等主路径，但 §12.3 只一句"`sdd init`"，**未定义 bootstrap 后初始状态**。数据模型强制二难：要么全 `UNCONFIRMED`（满屏噪音），要么批量 align 橡皮图章（违反 §18.1）。无任何旅程/验收覆盖"500 文件存量 repo"。
- **方法论负担 vs"不烦"内核**（MEDIUM）：checked-in 两工件 + `<!-- sdd-id -->` 锚点纪律 + merge driver + CI 接线，把"装上 hook 就能用"变成团队级流程改造，未与 PRD"低摩擦/不强制改 settings"明确对账。

### 19.7 较轻项与文档矛盾清单（partially-valid，仍建议修）

- **align 橡皮图章并未消除，只是改名**：`alignedReviewed` 成员判定只挡"确认后篡改"，挡不住"当初那次 align 就把超出 design 范围的代码盖章"（Codex P0-1 反例在 align 路径原样复活）。§7 边注"防 align 橡皮图章"会误导；建议状态名 `ALIGNED` → `CLAIMED-ALIGNED` 自解释。
- **computeDrift 成员判定的删除漏报**：align 集 `{a.ts,b.ts}` 删掉 b.ts 后，剩余仍"全部 ∈ 集合"→ 判 ALIGNED，行为收窄被静默漏报。缺"集合成员增（→UNCONFIRMED）/删（→应报）"三态语义。
- **降级幂等键 `sessionClock` 未定义**：谁递增、是否跨进程单调全空白；OpenCode（无 toolUseId）是高发区。（内容寻址回放对重复行幂等，故后果不灾难，但规格属空白。）
- **NFR1"永不阻断"被悄悄放宽**：`--require-aligned` 让"正常开发但没盖章（UNCONFIRMED）"在受保护分支被挡；§12"诚实的代价"未列为对 NFR1 的实质让步。
- **CI 治理三档无需求支撑**：`--max-unconfirmed-age/count`、`--require-aligned`、`--ci` 在 PRD 里无任何旅程/需求支撑，是评审者引入的治理层（YAGNI 候选）。

### 19.8 推进前必答的逼问清单

1. 只有两条事实事件时，`deriveLock` 用**哪个字段**确定性建立跨 path 关联？（不能是 ts）
2. 两分支各 align 同一 link 后合并，`alignedReviewed` 的确定性归并规则是什么？
3. OpenCode + 无 CI + 不 commit 的用户，会话内可靠提醒由谁投递？
4. 单 change-dir、改过 50 文件、从没 align 的真实项目，`sdd check` 输出多少条 UNCONFIRMED？怎么呈现？
5. 全仓跑一次 gofmt 后，亮多少个 CODE_DRIFT？
6. `sdd init` 500 文件存量 repo 后，既有关系处于什么状态？怎么避开"全 UNCONFIRMED"和"全橡皮图章"两个坏极？
7. 用户要的是"会话中被提醒去 sync"还是"PR/CI 时被挡下"？

### 19.9 结论

与前两轮一致：**先修完 P0（§19.3 的三处协议级语义裂缝）+ 直面 P1 的产品定位与误报对账，再做 §14 原型**。§19.3 的三条不属于"机械决策可交原型实证"——它们决定核心赌注是否成立，必须先在纸面落定。此外应承认两轮评审的三个盲区（运行时 / 定位 / 误报率），把"不误报"从口号变成 §14 的一等验收指标。

> 公允保留（避免倒掉孩子）：把权威从 Stop 移到 `sdd check` 绕开 OpenCode Stop 难题、内容哈希替代 mtime、事件日志 PR 可审——这三点是真实且被低估的强点，应保留。
