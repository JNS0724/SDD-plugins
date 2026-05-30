# SDD Review-Ledger 修订 R2：GateGuard 可借鉴边界

**版本:** R2（决策修订，落在架构/详细设计 v0.2 + R1 之上 → 两文档随之升 v0.3）
**日期:** 2026-05-30
**作者:** Claude（Opus 4.8）+ 用户协同（8 代理多镜头对抗反思：5 镜头 + 2 对抗审查 + 1 综合，全部核对过 GateGuard 真实源码行号与本项目设计文档）
**触发:** 用户在提示词里观察到 ECC 的 **GateGuard fact-forcing gate**（强制先取证再下结论，fact-forcing）效果好，问「这套是否只适用文档、不适用大量代码修改？能否学到我们项目？」
**定位:** 本文把那次反思的**决定版结论**沉淀成一份决策记录。它回答用户的二分法、厘清 GateGuard 与本项目的核心矛盾，并给出**采纳/拒绝矩阵**。结论按 §五回填进
[`架构`](./sdd-review-ledger-architecture.zh.md) 与 [`详细设计`](./sdd-review-ledger-detailed-design.zh.md)；本文与它们冲突处，**以本文为准**（两文档已按本文打补丁 + 升 v0.3）。
**设计由来:** GateGuard hook 源码（行号基准）：`~/.claude/plugins/cache/everything-claude-code/everything-claude-code/2.0.0-rc.1/scripts/hooks/gateguard-fact-force.js`；SKILL（A/B 证据）：同版本 `skills/gateguard/SKILL.md`。

---

## 一、先回答用户的二分法：「只适用文档、不适用大量代码」——证伪，方向恰好反了

三条硬证据（逐条核过源码）：

1. **GateGuard 的全部 A/B 证据都来自代码，没有一个文档样本。** SKILL §Evidence：analytics module（+1.5）、webhook validator（+3.0），均值 **+2.25/10**——都是代码。SKILL 首句就是 "any codebase where file edits affect multiple modules"。
2. **三条核心 fact 是专为代码设计的结构探针**（源码 `editGateMsg` 311-325）：① 列出所有 import 此文件的地方（Grep）；② 受影响的 public 函数/类；③ 数据文件 schema 是否含日期格式。这三条对一篇孤立的 `design.md` **全部返回空**（markdown 没有 importer、没有 public API、没有 schema）。只有第 4 条「逐字引用用户指令」对文档有效。
3. **用户「被拦下 4 个文档操作」的摩擦是真的，但归因反了。** 触发粒度按 `file_path` **无差别**计（源码 426-440，唯一豁免 `.claude/settings.json`，`docs/*.md` 不豁免）。并行编辑 4 个文档 = 4 个 `file_path` = 4 次「首次」= 4 次拦截（DENY）。

> **真正的摩擦轴不是「代码 vs 文档」，而是「停顿密度 = O(文件数)」。** 在「文件数 ≫ 设计决策数」的批量同质改动下（全仓 rename/lint/gofmt/30 文件实现 1 个决策），它会过度收费——解药是逃生阀（关掉），而不是判它「不适合代码」。用户把一个**粒度问题**误读成了**适用域问题**。对文档它是「高摩擦 × 近零信号」= **误伤区**；代码才是**主场**。

这里收敛掉一个过度声称（对抗审查抓到的）：`writeGateMsg`（源码 327-341）的「用 Glob 确认无重复文件」对**新建**文档并非全空（"是不是又开了一份重复 design"是有意义的）。所以准确的说法是「文档是低信号的误伤区，而非绝对盲区」——方向（代码是主场）不变。

---

## 二、核心矛盾（诚实，不粉饰）：GateGuard 真正起作用的部分 = DENY × FORCE，与 §1 永不阻断互斥

1. **控制流层**：DENY（源码 388 `permissionDecision:'deny'`）在 PreToolUse **物理上阻止写盘**——模型要完成它**自己已经决定**的编辑，就**必须先产出事实**才放行，调查成了写盘的前置条件。本项目的主推送通道（详细 §9.1）是 PostToolUse，把 `<system-reminder>` 追加到**已经写完**的编辑结果上——这段文本只是一条新指令，要和「回到用户任务」争夺模型的注意力，模型**可以零成本忽略它**。
2. **证据层**：SKILL §Core Concept 的原话是 "the investigation **itself** creates context"，关键词是 **forces** + **itself**——那 +2.25 来自「调查**真的发生了**」，而它之所以真的发生，**是因为 DENY 把它变成了放行的前提**。ungated 对照组（6.75）正是「看得到信息但不被强制调查」的情形。**本项目的非阻断主通道，机制上就等同于 GateGuard 对照组那一侧。**

**诚实结论：作为「让评审此刻就发生」的执行器，PostToolUse 追加文本在结构上是弱的。** 详细 §8 反复纠结「节流 vs 被动 todo」，根子就在这里——它是在为一个**本质上没有强制力**的通道设计礼貌程度。这一点必须写进架构 §10 残余，不能潜伏在 §8 的措辞里。

**一个关键细分（对抗审查校准）**：「永不阻断**用户主流程**」≠「绝不 DENY **agent 工具调用**」——GateGuard 阻断的是 agent 的 Edit 调用，用户并没有被要求做任何事。**但这个细分不足以支撑「所以可以加 FactGate」**：在 vibe coding（用户盯着 agent 实时干活）的语境下，§1 的「阻断」指的是**回路停顿 = 心流停顿**，而不是狭义的「弹出人工审批框」。用户亲口说那 4 次是「摩擦」——agent 卡住就是心流卡住。「DENY 的对象是 agent 而不是 user」是个有价值的观察（它说明 GateGuard 不弹人工审批框），但由它推出「FactGate 不违 §1」，是把**目的**（永不阻断 = vibe coding 的第一性原理）降格成**手段**，再去论证有更省的手段——这是稻草人。更硬的否决见 §三。

---

## 三、5 镜头共同漏看的最硬否决：FactGate 中间路违的是 §2，不只是 §1

反思中最聪明的提议是「FactGate-once 中间路」：仅在 `code × 有活着的 design 对应文件 × 会话首次 × 不在 verdict 覆盖下` 这单点真正 DENY agent 工具调用。**判它拒绝，理由比「违 §1」更深：**

**它的触发条件第二项「这块 code 有活着的 design 对应文件在盯着它」本身就是一个语义归属判断。** 哪块 code 归到哪个 change-dir，正是架构 §4/§6.4 **明确外包给 LLM、工具坚决不碰**的事（"归属交 agent，候选都列给它"）。FactGate 要在 **PreToolUse 的阻断决策点**回答「这块 code 有没有对应文件」，就必须让工具**预先做归属判断**——结果要么退化成「任意 code 编辑都 gate」（= GateGuard 原版的广谱摩擦，用户痛点复活），要么逼着工具去做它宪法级拒绝做的语义归属。

**这违的是 §2 元原则「不让确定性工具回答语义问题」**——正是前两代（mtime、link-lock）共同死掉的那个元错误。FactGate 只是把它从「算偏差」搬到「决定该不该 gate」，换汤不换药。

唯一可以采纳的，是从 FactGate 里拆出的那个真洞见：§1 在文档里被写成了两个不等价的命题（架构 §一/§7.4 写「不阻断用户主流程」，但 §7.2/§8 又滑向「绝不 DENY 任何编辑」）。澄清后的**结论**是「硬核 = fail-open-on-error + 不阻断用户输入 + 不变审批流」，**而不是**「所以可以加 DENY」（见矩阵 #7 / 架构新 §7.5）。

---

## 四、采纳/拒绝矩阵（决定版，已吸收对抗审查的全部收敛）

裁决三态：**[设计变更]** 改 sdd-review-ledger 产品设计；**[开发工作流]** 用于构建本项目、不进产品；**[拒绝]** 诚实否决并标注。行号以核实后的 hook 源码为准。

| # | 借鉴项 | 裁决 | 落点 / 理由 |
|---|---|---|---|
| 1 | **逃生阀总开关** `SDD_REVIEW=off` / `SDD_REVIEW_DISABLED=1` | **[设计变更] 采纳** | `core/config.js` 加 `isDisabled()`，逐字照搬 hook 49-59 的 `normalizeEnvValue`+`ECC_DISABLE_VALUES`；`pipeline.run` **第一行、`isSddProject` 之前**短路返回 SILENT。**真缺口**：详细 §14 有 10 个调参，却没有一个「整程静默」的总闸。「永不阻断」治不了「持续推送 + 持续重写 todo + 持续扫全树」的噪音——嫌吵、或者在做无关重构的用户，需要一个「这一程完全静默」的闸。零成本。 |
| 2 | **session-key 多级回退** `resolveSessionKey`（hook 79-96） | **[设计变更] 采纳** | 新建 `core/session-key.js`：CC/OpenCode `session_id` + `CLAUDE_SESSION_ID` + transcript hash + repoRoot hash 作保底（移植 `sanitizeSessionKey` 的长度/字符净化）。**最扎实的真缺口**：详细 §9.3 的节流「每会话 ≤N」**已经依赖**一个稳定的会话键，但 §七只写了 `ctx.sessionId`，没定义它的来源、也没定义缺失时的保底；空键会串台导致节流失效，每次都换不同键则节流形同虚设。注明「节流维度是会话键，与评审记录的 per-project 正交」。 |
| 3 | **merge-on-save 抗并发**（hook 152-164 写前重读取并集） | **[拒绝]** | 本项目全程持 `ledger.json.lock`（架构 §5.2），持锁的读-改-写不丢写，merge 没必要；而且评审记录（即 ledger）是 `path→record` map，取并集会引入「同 key 不同 verdict 选谁」的歧义 = 把删掉的状态机变相塞回来（违 §13#1）。GateGuard 无锁所以靠 merge、本项目有锁所以靠读-改-写，**两条路各自自洽**。建议架构 §5.2 把 GateGuard「无锁 + merge」钉为对照点，并指出两者**状态语义不同源**（GateGuard 的 checked 是去抖集合，丢了无所谓；本项目的评审记录是跨会话的评审结论真相）。 |
| 3b | **rename 的 EEXIST/EPERM unlink-retry**（hook 174-187） | **[设计变更] 采纳** | **对抗审查发现的真 bug 风险，5 镜头全漏。** 它与「砍掉非原子 fallback」是**正交**的两件事：Windows 的 `renameSync` 覆盖已存在文件会抛 EEXIST/EPERM；详细 §二/架构 §5.2 的 `atomic.js` 只保留了「rename 失败 = 放弃写」，在 Windows 上会让**每次覆盖写都失败 → fail-open 跳过写 → 评审记录永远停在初始态 = 系统性的误判成「已评审」（false-clean）**（而不是无害地丢一次）。本项目宣称支持双平台（可能含 Windows），就必须把 unlink + 重试一次移植进 `atomic.js`。 |
| 4 | **fact-forcing 投递模板改写**（FORCE 的「枚举具体 fact、先取证后裁决」重写详细 §9.2） | **[设计变更] 采纳（限定 + 诚实标注增益上限）** | `core/prompts.js`：§9.2 现在是**变相的自评**（"逐项判断这次变更是否使对应文件过期"，直接去要 verdict 而不是要事实），正好踩中 SKILL §Anti-Patterns 第一条点名的坑。改为「先并排引用 design 声称 X / code 实现 Y 的事实、再下 verdict」。**限定**：① Layer B（code↔doc）全力执行，Layer A 纯文档退化为「引用两篇 doc 互相矛盾的那两句」，不强加 importer 式的取证（那正是 GateGuard 误伤文档的复刻）；② 重模板**只用于实际推送的那 ≤1 项/批次**，被节流压成被动 todo 的项不带重取证（取证 × 节流是一对张力）。**收敛掉的过度声称**：删掉「回收 +2.25 的一部分」——措辞不是真正起作用的部分、**强制才是**；这只是降低走过场盖章的「最省力出口」，**绝不量化**增益，而且这部分增益在结构上远低于 +2.25。 |
| 4b | **勾选「无效清除」轻牙齿**（裸理由 → 展示侧标记） | **[设计变更] 采纳（降级为纯展示侧标记，仍清除）** | **对抗审查抓得对**：如果「勾选是否生效」取决于工具检查理由文本，那清除就不再是 §8.2 承诺的纯机械、可观测的信号，而且踩 §7.3「不解析 NL」。**降级版本**：`renderTodo` 对裸理由（纯"无关"/"ok"）加一个**可见标记**「理由过简，建议补充」，但**仍然清除**，判断权留给人/agent。这样可以避免「拒绝清除 → todo 单调膨胀 → 用户彻底无视 = 功能死亡」的二阶效应（它会和 §8.1「被动留存不反复打扰」打架）。 |
| 5 | **一次性高信号 gate（FactGate-once 中间路）** | **[拒绝]（最硬否决）** | 见 §三：触发条件「有活着的 design 对应文件」是 §4/§6.4 外包给 LLM 的**语义归属判断**，让 PreToolUse 预先回答它 = 违 §2 元原则（比违 §1 更深）；结果要么退化成广谱 DENY（痛点复活），要么去做工具拒绝做的归属；此外，OpenCode 侧的 `tool.execute.before` 能否可靠 deny + 让模型「重试同一编辑」完全未经验证（§7.1 实测 OpenCode 续跑不可靠，DENY 是 CC 专有契约）。它拆出的「§1 双命题」洞见，采纳为文档澄清（#7）。 |
| 6 | **开发期开 GateGuard 来构建本项目** | **[开发工作流] 采纳（定制开，非全开）** | 现在处于文档迭代阶段 = 高摩擦 × 近零收益 → **现在就**设 `ECC_DISABLED_HOOKS=pre:edit-write:gateguard-fact-force`（消掉文档 Write/Edit 的摩擦）。等进入 M1 core 编码（尤其是契约文件 `todo.js`/`prompts.js`/`ledger.js`——改 `renderTodo` 格式就会破坏 `parseTodo` 正则 + snapshot 契约，这正是 fact #1 列 importers 的甜区）再开回来。**保留** destructive bash gate（`git reset --hard`/`rm -rf`，TDD/code-review 都不拦，纯互补）。牺牲掉的 pre-edit code 收益与本项目的 TDD 纪律（test-first 提前占领了 pre-edit 窗口）**冗余**。**追加一条 5 镜头漏看的理由**：dogfooding 时如果装了 sdd-review-ledger 自己的 hook，GateGuard 的 DENY 会拦掉编辑，使本项目的 PostToolUse 捕获**根本不触发** = 幽灵漏报（不是本项目的 bug），关掉 edit gate 同时也消除了这层测试污染。 |
| 7 | **§1 双命题澄清 + §10 诚实残余** | **[设计变更] 采纳（纯文档）** | 架构新 §7.5：§1 硬核 = fail-open-on-error + 不阻断**用户输入/主流程** + 不变审批流（**不**蕴含「可以加 DENY」）；§10 增残余：「主推送不仅是 best-effort 的推送，更是 **best-effort 地让模型自愿调查**；GateGuard 实证表明，温和 nudge 的调查深度低于强制 DENY，本工具因 §1 永不阻断而**主动接受**这个上限，换取的是零纪律 + 跨会话 + 双平台 + 永不卡用户。」 |
| 8 | **路径注入消毒** `sanitizePath`（hook 245-255，剥控制字符/bidi/换行 + 截断 500） | **[设计变更] 采纳** | 移植到 `core/paths.js`，在 `renderTodo`（把 path 写进人可见文件）和 `prompts.js`（把 path 拼进喂给模型的 system-reminder）**拼接之前**调用。同一个注入面，本项目的**渲染侧**还没覆盖（解析侧已经被 §7.2「只认结构化」覆盖了，渲染侧没有）。 |
| 9 | **bounded LRU 保留待处理项**（hook 128-141） | **已对齐，无需新增** | 详细 §5.1 已经有 `SDD_REVIEW_LEDGER_CODE_CAP` + 「从不淘汰待评审项」，与 GateGuard "preserve ROUTINE_BASH key" 同思路。只需在文档里把 GateGuard 列为同源对照。 |
| 10 | **per-session 30min TTL**（hook 34/112-119） | **[拒绝]** | GateGuard 的 TTL 服务于「per-session 去抖」（过期清掉无害）；本项目的评审记录是 per-project 持久 + 跨会话，靠内容哈希绑定到那一版内容的哈希来**自动失效**（架构 §8.4）。加 TTL 会让「冷的、还没 ack 的项」在 30min 后被误清 = 误判成「已评审」（false-clean）。两者的状态生命周期不同源，各自最优。 |
| 11 | **批次边界定义**（从那次 4 连击样本反推） | **[设计变更] 采纳** | **对抗审查最佳的自我修正，5 镜头全漏**：那 4 连击恰好暴露了详细 §9.3「每批次 ≤1 提醒」是个**未定义的空头承诺**——GateGuard 按 file_path 计、根本没有批次概念，才会 4 连击。并行编辑/MultiEdit/subagent fan-out 会让多个 `tool.execute.after` 几乎同时到达，批次边界没定义就会重蹈 4 连击（只是变成 4 条 reminder）。必须在 §9.3 定义批次边界（建议：把同一 session、两个 user turn 之间的连续编辑序列合并为一批，跨 turn 重置）。 |

---

## 五、回填清单（已按此打补丁的位置）

**架构 v0.2 → v0.3：**
- **新增 §7.5**「永不阻断的精确边界（R2）」：§1 双命题澄清（矩阵 #7/#5）。
- **§5.2 并发段**：增补 GateGuard「无锁 + merge」对照点 + 状态语义不同源（矩阵 #3）；钉一句「rename 的 EEXIST/EPERM unlink-retry 须保留，与砍掉非原子 fallback 正交，Windows 必需」（矩阵 #3b）。
- **§8.2 / §8.6**：补上明确否决「工具基于理由文本是否达标来决定清除」（守住机械可观测）+ 引入纯展示侧的「理由过简」标记（矩阵 #4b）。
- **§10 残余**：新增一条「主推送是 best-effort 地让模型自愿调查，深度在结构上低于强制 DENY，因 §1 而主动接受这个上限」（矩阵 #7）。
- **§13 开放问题**：新增已定项 #8「GateGuard 可借鉴边界（R2）」。

**详细 v0.2 → v0.3：**
- **§一 决策表**：增加 R2 行。
- **§二 模块表**：`config.js` 加 `isDisabled()`；新增 `core/session-key.js`；`atomic.js` 注明「保留 rename 的 EEXIST/EPERM unlink-retry，只砍掉非原子的 writeFileSync fallback」；`paths.js` 加 `sanitizePath`（矩阵 #1/#2/#3b/#8）。
- **§七 管线**：`run` 第一行加 `isDisabled()` 短路（在 `isSddProject` 之前）；`ctx.sessionId` 经 `core/session-key.js` 解析，注明「节流维度是会话键，与评审记录的 per-project 正交」（矩阵 #1/#2）。
- **§9.2 模板**：按 fact-forcing 重写（先取证后裁决；Layer B 全力/Layer A 退化/仅 ≤1 项；删除任何「回收 +2.25」的措辞）（矩阵 #4）。
- **§9.3 节流**：定义「批次」边界（矩阵 #11）+ 注明重取证模板与节流之间的张力。
- **§6.5 / §8.6**：`renderTodo` 对裸理由加纯展示侧的「理由过简」标记（仍清除，不做语义校验）（矩阵 #4b）。
- **§12 测试**：加上 `sanitizePath` 渲染侧消毒、`session-key` 回退链、Windows rename unlink-retry、批次边界合并这几项测试。
- **§14 env**：新增 `SDD_REVIEW_DISABLED` / `SDD_REVIEW=off` 总开关行（矩阵 #1）。
- **§16.5 / §16.6 MVP**：增「主通道忽略率」量化验收（模型收到提醒后实际去评审/勾选的比例，低于阈值即证实非阻断的弱点）+ 诚实残余「主推送没有强制力，模型可以忽略；MVP 刻意先裸测纯非阻断下的真实评审完成率，作为是否引入更强机制的证伪输入」。

> 一句话收尾：**GateGuard 不是「只适用文档」——证据全来自代码，那 4 次文档拦截是它按 file_path 无差别 DENY 的误伤；真正的摩擦轴是 O(文件数) 的停顿密度。** 它的 DENY 与 §1 永不阻断是真正互斥的（真正起作用的部分来自强制，补不回来，诚实写进 §10）；那条 FactGate 中间路被高估了，最硬的问题是**违 §2**（让 PreToolUse 工具预先做归属判断）。能真正学的只在**提示工程层**（§9.2 自评 → 取证、裸理由展示侧标记）+ **机械原语层**（逃生阀、session-key、Windows rename、批次边界、路径消毒），外加对抗审查白捡的两个真 bug（Windows 上的 false-clean、§9.3 的空头承诺）。
