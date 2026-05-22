# `sdd-drift-check-hook.js` 设计符合性审查

**版本:** 1.0
**日期:** 2026-05-22
**审查对象:** `plugins/sdd-drift-check/sdd-drift-check-hook.js` @ commit `5279563`
**基准文档:** [sdd-drift-check-hook.design.zh.md](./sdd-drift-check-hook.design.zh.md) v1.1 / [sdd-drift-check-hook.prd.zh.md](./sdd-drift-check-hook.prd.zh.md) v1.2
**审查者:** Claude（Opus 4.7）

本报告对照设计文档 v1.1 的每一项契约，给出实施现状的 ALIGNED / PARTIAL / MISSING 判定，并按行为正确性优先级排出修复顺序。

---

## 一、总体结论

**功能层（FR1–FR13）大体落地，但结构层（设计 §5/§6/§10.1/§22）几乎未实施。**

代码按"先把 ProjectState/StateMachine/carry-over 跑起来"的优先级实现，对应 PRD 分阶段计划的 **P4 完成 + P5 部分**，**P1–P3（Dispatcher/CircuitBreaker/性能 R 项）与 P6（Attribution LLM 评审）未做**。

### 与 PRD §12 分阶段计划的对齐度

| 阶段 | 设计意图 | 当前进度 |
|------|----------|----------|
| P0 | 16 旅程 snapshot fixture | ✗ 未见 fixture 目录 |
| P1 | 结构重排 + R7/R9/R10 | ⚠️ R7/R10 完成，R9 缺，24 段命名空间未拆 |
| P2 | Dispatcher + 熔断 + R11 | ✗ 跳过 |
| P3 | R1/R2/R3/R8 性能 | ⚠️ 仅 R3 |
| P4 | ProjectState + StateMachine + FR2/3/12/13 | ✓ 基本完成（除 B1 时序瑕疵） |
| P5 | UPS + PreCompact + PreToolUse question checkpoint | ⚠️ UPS/PreCompact 完成，PreToolUse question checkpoint 挪位 |
| P6 | Attribution + LLM 评审 + carry-over 完整 | ✗ 未做 |

---

## 二、不符合项

### 2.1 行为缺陷（影响判定正确性）

| 编号 | 设计要求 | 实际实现 | 行号 | 影响 |
|------|----------|----------|------|------|
| **B1** | §7.3 `refreshAlignedBaseline` 须满足 4 个条件：① 本会话编辑过该 dir 的 doc；② 本会话编辑过 code；③ SDD edit seq < code edit seq；④ 无反复回头改 | 当前 `refreshAlignedBaseline` 只看时间戳：所有已存在 doc 均被 review 且 review 时间 ≥ code 时间 | 1954-1974 | **J1 ↔ J3 分水岭判错**：跨会话仅 Read 旧 doc 也可能误刷新 `alignedAtMs`；J1 实现流"时序自然"未严格验证 |
| **B2** | §8.1 `Attribution.decide` 五分支决策树（no-attribution / single / session-touched / active-ttl / needs-review）+ `pathSimilar` 前缀深度 ≥ 2 | 仅 `collectProjectAttributionTargets` 返回候选数组；**无完整决策树、无 active-TTL 短路、无 LLM 评审 fork** | 1760-1774 | **FR11 完全未实现**；多 change-dir 场景的模糊归属无法外包给 LLM |
| **B3** | §9.1 carry-over 双路径：UPS 主路径 + PostToolUse 兜底路径（带 `[Carry-over]` 前缀） | 仅 UPS 主路径 | 2852-2869（主路径）；PostToolUse 无兜底 | **未注册 UPS hook 的用户拿不到 carry-over 提醒**，FR6 不完整 |
| **B4** | §3.2 `ChangeDir` schema 不应包含 `peerSyncs`（该字段属 SessionState §3.1） | `emptyProjectChangeDir` 写入了 `peerSyncs: {}` | 1439-1465 | schema 越界；ProjectState 不变量等价类污染 |

### 2.2 健壮性缺失（R 编号）

| 编号 | 设计要求 | 实际 | 备注 |
|------|----------|------|------|
| **R1** | `session.files` LRU 上限 1000 | `recordFile` 无上限、无 GC | 行 912；长会话内存增长无界 |
| **R2** | transcript 增量 hydration via `transcriptCursor` byteOffset | `hydrateStateFromTranscript` 每次全量；`transcriptCursor` 字段连 `emptyState` 都未加 | 行 1190；大 transcript 性能崩溃 |
| **R9** | stdin 5s 超时 | `readStdin` 无超时，可被无限阻塞 | 行 206 |
| **R11** | Dispatcher 取代 `main()` if-else | `main()` 仍是顺序 if 链 | 行 2789 |

### 2.3 结构契约缺失（§5 / §6 / §22）

| 项 | 设计 | 实际 |
|----|------|------|
| **HookHandlers 注册表**（§5.1）| 5 个键各带 `requiresSession / requiresProject / lockPolicy / handle` | **不存在**，dispatch 内联在 `main()` |
| **5 个具名 handler**（§6） | `handlePreToolUse` … `handlePreCompact` 返回 `Action[]` | **不存在**，逻辑全在 `main()` 行 2852-3165 |
| **Actions 类型 + 排序不变量**（§5.3）| `LOG → SAVE_PROJECT → SAVE_SESSION → REFRESH_REPORT → EMIT_MESSAGE` 强制顺序 | **无抽象**；现状大致顺序对，但无机制保证，崩溃半成品风险 |
| **CircuitBreaker**（§10.1）| 单 hook 连续 5 次异常 → 60s 静默 | **零引用**；`circuitBreaker` 字段在 `emptyState` 有写入但**无读、无更新** |
| **PreToolUse question checkpoint**（§6.1）| 独立 handler，emit `permissionDecision="deny"` | 逻辑挪至 PostToolUse（行 3018、3037），PreToolUse 分支（行 3054）早返回未做检查 |

### 2.4 SessionState v3 字段（§3.1）

| 字段 | 状态 |
|------|------|
| `firstEventAt`, `projectStateSeenAt`, `attributionReviews`, `noEditSession`, `circuitBreaker` | ✓ 已加入 `emptyState`（行 484-507）|
| `transcriptCursor` | ✗ 缺（与 R2 关联）|
| `subagentContext` | ⚠️ 不在 `emptyState`，仅在 `main` 行 2856 临时设置 |

---

## 三、符合项

| 契约 | 行号 | 备注 |
|------|------|------|
| `computeProjectConditions` 三条精细规则（peer-exists / per-doc review / alignedAtMs baseline）| 1510-1548 | §7.1 完美对齐 |
| R3 DTS 单次检测 + 缓存 | 671-809 | 含 `DTS_CONTEXT_SKIP` 与 negation pattern |
| R7 破损归档 `quarantineCorruptStateFile` | 1622 | `.corrupt-<ts>` 命名 |
| R10 v2→v3 自动迁移 `normalizeState` | 513 | 旧字段保留 |
| §13 契约保留：`module.exports` 扩展，env 名未改，stateDir 扁平布局正确 | 3190+ | 新增 `loadProjectState` / `saveProjectState` / `refreshAlignedBaseline` / `buildPreCompactSummary` / `ATTRIBUTION_REVIEW_RULES` |
| `.sdd-drift-report.md` 格式保留 | 2697-2708 | ISO 时间戳前缀 |
| UPS carry-over 主路径 | 2852-2869 | `firstEventAt` 一次性闸 |
| `ATTRIBUTION_REVIEW_RULES` 常量 + `formatAttributionReviewRules` | 139-150 | 常量已就位，等 §14 决策树调用 |
| PreCompact summary | 2873-2883 | 走 `hookSpecificOutput.additionalContext` |

---

## 四、修复优先级建议

按"行为风险 → 用户可见缺失 → 结构债"排序：

| 优先级 | 项 | 理由 |
|--------|-----|------|
| **P0** | B1（alignedAtMs 时序判定）| J1/J3 旅程的核心分水岭；当前规则会让跨会话误判 |
| **P0** | B3（PostToolUse carry-over 兜底）| 未注册 UPS hook 的用户群体覆盖不到 FR6 |
| **P1** | B4（`ChangeDir.peerSyncs` 越界）| 1 行删除，schema 干净 |
| **P1** | R1（files LRU）/ R2（transcript cursor）/ R9（stdin timeout）| 长会话稳定性 |
| **P2** | B2（Attribution 决策树 + LLM 评审）| FR11 整块功能；属设计核心创新，但用户当前已通过单 dir 路径侥幸可用 |
| **P3** | Dispatcher / Handlers / Actions / CircuitBreaker | 不影响行为，但每加一个 hook，`main()` 复杂度指数上升 |

建议先做 P0 + P1，再回头做 P2（FR11）与 P3 结构重构。P0 修复后必须补 P0 阶段的 16 旅程 snapshot fixture，否则后续重构无安全网。

---

## 五、附录：关键定位

```
emptyState              line  484
normalizeState          line  513
quarantineCorruptStateFile  line 1622
loadProjectState        line 1629
saveProjectState        line 1639
emptyProjectChangeDir   line 1439
computeProjectConditions   line 1510
recomputeProjectState   line 1565
refreshAlignedBaseline  line 1954        ← B1
collectProjectAttributionTargets   line 1760  ← B2
collectCarryOverDrift   line 1928
formatCarryOverReminder line 1933
buildPreCompactSummary  line 1945
hydrateStateFromTranscript   line 1190   ← R2
readStdin               line  206        ← R9
recordFile              line  912        ← R1
main                    line 2789        ← R11 / 注册表缺失
module.exports          line 3190
```

---

## 六、处理记录（2026-05-22）

### 6.1 已采纳并修复

| 编号 | 处理结论 | 修改内容 |
|------|----------|----------|
| B1 | 采纳 | `refreshAlignedBaseline` 改为只处理“本会话先编辑 SDD 文档、后编辑代码”的实现流基线刷新；跨会话仅 Read 旧文档不再刷新 `alignedAtMs`。同时 `recordFile` 的事件时间改为基于 state 内最大事件时间单调递增，避免快速工具调用或系统时间抖动导致 design/tasks 顺序误判。 |
| B3 | 采纳 | 增加 PostToolUse carry-over 兜底：未配置 `UserPromptSubmit` / `ChatMessage` 时，首次可见工具结果仍可通过 `[Carry-over] SDD carry-over drift from prior sessions:` 提醒模型处理跨会话遗留 drift，并通过 `carryOverNotice` 签名避免重复提示。 |
| R1 | 采纳 | 增加 `session.files` LRU 上限，默认 `1000`，可通过 `SDD_DRIFT_SESSION_FILES_MAX` 调整；同步裁剪 `touched` / `edited`，避免长会话 state 无界增长。 |
| R2 | 采纳 | 增加 `transcriptCursor`，`hydrateStateFromTranscript` 改为按 byte offset 增量读取 transcript，并保存 `lineIndex`，避免 Stop 阶段反复全量扫描大 transcript。 |
| R9 | 采纳 | `readStdin` 增加默认 5s 超时，可通过 `SDD_DRIFT_STDIN_TIMEOUT_MS` 调整；超时后使用已读入内容继续解析，避免 hook 因 stdin 未关闭而无限阻塞。 |
| B2 | 部分采纳 | `collectProjectAttributionTargets` 增加 single active change-dir 短路，减少单 change-dir 场景下不必要的候选扩散。完整 FR11 LLM attribution fork 暂未实现，仍列为后续 P2。 |

### 6.2 暂缓或反驳

| 编号 | 处理结论 | 理由 |
|------|----------|------|
| B4 | 反驳，保留现状 | review 认为 `ChangeDir.peerSyncs` 越界，但当前项目级 `peerSyncs` 是跨会话识别 design/tasks 同步关系的持久化证据，用来避免 “design 改 tasks，tasks 又反向触发 design” 的 ping-pong。该字段虽然偏离原设计 schema，但删除会回退近期已修复的真实使用问题。后续如要严格 schema，可改名为 `docSyncs` 并同步更新设计文档，而不是直接删除。 |
| R11 / Dispatcher | 暂缓 | `main()` 结构复杂的问题成立，但本轮优先处理行为正确性和长会话稳定性。Dispatcher/Action 抽象属于 P3 结构债，建议在 snapshot fixture 更完整后单独重构。 |
| CircuitBreaker | 暂缓 | `circuitBreaker` 字段仍未完全使用；当前新增了 stdin timeout 和原子状态写入等更直接的稳定性修复。异常熔断适合与 Dispatcher 重构一起落地。 |
| P0 16 旅程 snapshot fixture | 暂缓 | 本轮补充了针对 B1/R1/R2/B3 的单元回归，但完整 16 旅程 snapshot fixture 体量较大，应作为后续单独测试基建任务实施。 |

### 6.3 本轮新增验证

- `npm test` 覆盖：project per-doc review、implementation-flow baseline、peer sync 防反向误判、session files LRU、transcript cursor 增量 hydration、carry-over notice 签名去重。
- `node -c plugins/sdd-drift-check/sdd-drift-check-hook.js` 语法检查通过。
