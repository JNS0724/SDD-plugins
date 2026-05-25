# sdd-drift-check 核心重构方案

## 文档更新记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v1.1 | 2026-05-26 | 根据评审记录补充 PRD/design 对齐关系、FR11 当前状态、核心模块依赖图、3A 安全网拆分、阶段回滚约定和 OMO 边界。 |
| v1.0 | 2026-05-22 | 初始核心重构方案。 |

## 目标

将 `sdd-drift-check` 从“Claude command hook 承载大部分核心逻辑”的结构，重构为“Claude Code / OpenCode 两个 adapter 共享 core”的结构。

本阶段不改变用户安装路径和发布件名称：

```text
plugins/sdd-drift-check/sdd-drift-check-hook.js
plugins/sdd-drift-check/sdd-drift-check-opencode.js
```

重构目标结构：

```text
plugins/sdd-drift-check/src/
├─ adapters/
│  ├─ claude-code/
│  │  └─ command-hook.js
│  └─ opencode/
│     └─ native-plugin.js
├─ core/
│  ├─ attribution.js
│  ├─ diagnostics.js
│  ├─ drift-engine.js
│  ├─ file-classifier.js
│  ├─ hydration.js
│  ├─ locks.js
│  ├─ output.js
│  ├─ paths.js
│  ├─ project-state.js
│  ├─ prompts.js
│  ├─ report.js
│  ├─ runtime-config.js
│  ├─ sdd-rules.js
│  ├─ session-state.js
│  ├─ state-storage.js
│  └─ tool-events.js
└─ index.js
```

## 与 PRD / Design 的关系

本方案是对 PRD / design 的工程拆分细化，不替代原需求和设计文档：

- PRD：[sdd-drift-check-hook.prd.zh.md](./sdd-drift-check-hook.prd.zh.md)
- Design：[sdd-drift-check-hook.design.zh.md](./sdd-drift-check-hook.design.zh.md)

阶段对应关系：

| 本方案阶段 | 对应 design 阶段 | 说明 |
| --- | --- | --- |
| 3A-1 core 安全网 | P0 snapshot baseline | 先固定 core 行为，不移动代码。 |
| 3A-2 adapter 安全网 | P0 + adapter baseline | 固定 Claude Code / OpenCode 输出和事件适配行为。 |
| 3B 路径与文件分类 | P1 结构重排 | 抽离跨平台路径、文件类型和 SDD 目录识别。 |
| 3C 诊断、锁和存储 | P1 / P2 基础设施 | 抽离日志、状态目录、原子写和锁。 |
| 3D Session State | P1 / P5 部分 | 保留同会话内的工具事件、peer sync、question checkpoint 和 review 状态。 |
| 3E Project State | P5 | 抽离跨会话 project drift、active change-dir、doc sync 和 carry-over。 |
| 3F Drift Engine / Attribution | P5 / P6 | 合并 session + project 视角，处理 drift gap、code review 和 FR11 attribution。 |
| 3G Prompts / Report / Hydration | P4 / P5 / P6 | 抽离模型可见提示词、报告生成、transcript/checkpoint hydration。 |
| 最终验收 | P6 | 两个用户面真实模型回归。 |

FR11 LLM 评审归属在本方案范围内，但采用“迁移现有能力 + 补测试”的方式推进。当前仓库已有 `src/attribution.js`，包含 `no-attribution` / `single` / `session-touched` / `active-ttl` / `needs-review` 决策雏形；重构时应迁入 `src/core/attribution.js`，并在 3F / 3G 中补齐 attribution review prompt、后续动作观察和 Stop 兜底的 characterization tests。若测试暴露需要新增行为，必须在对应阶段补测试后再实现。

## 核心模块依赖图

目标是单向依赖，避免 adapter 和 core 之间重新长出循环引用：

```text
L0  runtime-config | paths
L1  file-classifier | sdd-rules | diagnostics | locks | state-storage
L2  tool-events | session-state | attribution
L3  project-state | hydration
L4  drift-engine
L5  prompts | report
L6  output
L7  adapters/claude-code | adapters/opencode | handlers | index
```

约束：

- `core/*` 不依赖 adapter。
- `output` 只负责按运行时协议输出，不反向读取状态。
- `prompts` 只接收 drift-engine 产生的结构化 gap，不直接扫描文件系统。
- `project-state` 可以读取文件系统事实，但不直接生成模型提示词。
- `adapters/*` 负责输入归一化和运行时协议，不承载 drift 业务判断。

## 当前基础

已完成的结构基础：

```text
src/core/
├─ output.js
├─ runtime-config.js
├─ sdd-rules.js
└─ tool-events.js
```

待迁移的现有能力：

```text
src/attribution.js
src/dispatcher.js
src/handlers/*
src/adapters/claude-code/command-hook.js 中仍承载的大部分状态、drift、prompt、report、hydration 逻辑
```

已完成的 adapter 分层：

```text
src/adapters/claude-code/command-hook.js
src/adapters/opencode/native-plugin.js
```

## 执行原则

每个阶段都按同一节奏推进：

1. 先补测试或 characterization fixture。
2. 只移动一类逻辑。
3. 运行 `npm run build`。
4. 运行 `npm test`。
5. 阶段通过后再进入下一阶段。

禁止一次性大搬迁状态机。状态、project state、drift engine、prompt/report/hydration 必须分阶段拆。

每阶段提交约定：

- 每阶段完成后单独 commit，提交信息使用 `refactor(core/3X): ...` 或 `test(core/3X): ...`。
- 阶段失败时先在当前分支修复；若需要回退，未推送提交可在明确确认后回到上一阶段提交，已推送提交优先使用 `git revert` 或新分支重做。
- 发布件 `sdd-drift-check-hook.js` 和 `sdd-drift-check-opencode.js` 必须随源码同步构建。
- `src/index.js` 是模块导出聚合入口，测试可通过它访问稳定导出的 core / adapter 能力。

测试位置约定：

- 短期继续复用 `test/opencode-sdd-drift-e2e/scripts/test-core-*.cjs`，但测试内容必须保持 runtime-agnostic，不得依赖 OpenCode 专属行为。
- adapter 专属测试继续放在对应 e2e 工程中。
- 若 core 测试继续增多，后续单独迁到 `test/core/`；本轮重构不把测试目录迁移作为阻塞项。

## 阶段 3A-1：Core 行为安全网

先补测试，不移动核心代码。

覆盖场景：

- `design.md -> tasks.md` peer drift。
- `tasks.md -> design.md` peer drift。
- peer 文件不存在时不触发强制同步。
- `archive` / `archived` / `已归档` change-dir 跳过。
- code-ahead-of-doc 批处理。
- no-edit review confirmation。
- DTS / 问题单上下文跳过。
- project.json carry-over drift。
- `.sdd-drift-report.md` 内容不变时不刷新 timestamp。

新增或扩展测试：

```text
test-core-drift-characterization.cjs
test-core-project-carryover.cjs
test-core-report-idempotent.cjs
test-core-attribution.cjs
```

验收：

```powershell
cd test\opencode-sdd-drift-e2e
npm test
```

```bash
cd test/opencode-sdd-drift-e2e
npm test
```

## 阶段 3A-2：Adapter 行为安全网

只补 Claude Code / OpenCode adapter characterization，不移动核心代码。

覆盖场景：

- checkpoint output hydration。
- transcript hydration。
- OpenCode native adapter before-cache / Stop inject / tool result append。
- Claude Code Stop / PreCompact / PreToolUse 输出协议。
- OpenCode session.idle / session.status idle best-effort continuation。

新增或扩展测试：

```text
test-core-hydration.cjs
test-adapter-claude-output.cjs
test-adapter-opencode-native.cjs
```

验收：

```powershell
cd test\opencode-sdd-drift-e2e
npm test
```

```bash
cd test/opencode-sdd-drift-e2e
npm test
```

## 阶段 3B：抽路径与文件分类

新增模块：

```text
src/core/paths.js
src/core/file-classifier.js
```

迁移内容：

`src/core/paths.js` 只承载跨平台路径工具：

- `toPosix`
- `normalizeKey`
- `samePath`
- `rel`
- `resolveFile`

`src/core/file-classifier.js` 只承载纯路径分类：

- `isSddPath`
- `isSddChangePath`
- `isCodePath`

`src/core/sdd-rules.js` 承载 SDD 业务规则：

- `findSdd`
- `getChangeDoc`
- `CHANGE_DOC_REQUIREMENTS`
- archive marker / status 判断。
- DTS / 问题单上下文模式。

新增测试：

```text
test-core-paths.cjs
test-core-file-classifier.cjs
```

重点覆盖：

- Windows 路径分隔符。
- 大小写不敏感文件系统 key。
- `sdd/changes/*` 与 `.sdd/changes/*`。
- `archive` / `archives` / `archived` / `已归档`。
- marker 文件归档。
- `status.md` / `state.md` 中的 archived 状态。

验收：

```powershell
npm run build
npm test
```

```bash
npm run build
npm test
```

## 阶段 3C：抽诊断日志、锁和状态存储

新增模块：

```text
src/core/diagnostics.js
src/core/locks.js
src/core/state-storage.js
```

迁移内容：

- diagnostic log path。
- log rotation。
- 3 天 retention。
- diagnostic summary。
- atomic write。
- file lock acquire/release。
- state dir 选择：`.git/sdd-drift-hook-state` / `.sdd-drift-hook-state` / `%TEMP%` fallback。
- state path / project state path。

新增测试：

```text
test-core-diagnostics.cjs
test-core-storage.cjs
```

重点覆盖：

- 日志默认写入 `.git/sdd-drift-hook-state`。
- 无 `.git` 时 fallback。
- retention 删除过期 JSONL 记录。
- atomic write 不留下半文件。
- lock stale 后可恢复。

验收：

```powershell
npm run build
npm test
```

## 阶段 3D：抽 Session State

新增模块：

```text
src/core/session-state.js
```

迁移内容：

- `emptyState`
- `normalizeState`
- `recordFile`
- `markToolEvent`
- `updateRequirementsForEdit`
- peer sync 状态。
- code review confirmation。
- notice emission state。
- question checkpoint 状态。
- PreCompact 需要的 interrupted-review 状态。

边界：

- session peer sync 只表示同一会话内已经观察到的 design/tasks/proposal 同步关系。
- session state 不直接判断跨会话 carry-over drift；跨会话事实由 3E project-state 负责。
- PreCompact 读取 session 中未完成的 checkpoint 状态，但 handler 注册仍留在 adapter/dispatcher 层。

新增测试：

```text
test-core-session-state.cjs
```

重点覆盖：

- Read/Edit seq 递增。
- 重复 tool event 去重。
- SDD edit 产生 peer requirement。
- peer sync 后清理 gap。
- code review notice cap。
- question checkpoint 状态可被 PreCompact 读取。

验收：

```powershell
npm run build
npm test
```

```bash
npm run build
npm test
```

## 阶段 3E：抽 Project State

新增模块：

```text
src/core/project-state.js
```

迁移内容：

- `normalizeProjectState`
- `normalizeProjectChangeDir`
- `normalizeProjectDoc`
- `applySessionToProject`
- `refreshAlignedBaseline`
- `linkedCode`
- active change-dir TTL。
- carry-over drift 基线。
- project-level peer drift。
- `docSyncs` 跨会话文档同步证据。
- 旧 `peerSyncs` 字段到 `docSyncs` 的兼容迁移。

边界：

- project state 是 session state 的补充，不替代 session 内的 peer requirement。
- `docSyncs` 用来避免 design/tasks ping-pong，不应再命名为 session 语义的 `peerSyncs`。
- ProjectState schema 必须与 design §3.2 保持一致；若 schema 因真实问题修正，需要同步更新 design 文档。

新增测试：

```text
test-core-project-state.cjs
```

重点覆盖：

- 跨 session 保留 active drift。
- `alignedAtMs` 刷新。
- `linkedCode` cap。
- active change-dir TTL。
- archive 后 project drift 清零。
- 旧 `peerSyncs` project 文件读取后保存为 `docSyncs`。

验收：

```powershell
npm run build
npm test
```

```bash
npm run build
npm test
```

## 阶段 3F：抽 Drift Engine

新增模块：

```text
src/core/drift-engine.js
src/core/attribution.js
```

迁移内容：

- `drift`
- `collectPeerGaps`
- `collectCodeGaps`
- `collectCombinedPeerGaps`
- `collectCombinedCodeGaps`
- `src/attribution.js` 中已有的 attribution review decision。
- no-edit confirmation 判定。
- carry-over reminder 判定。

说明：

- `collectCombinedPeerGaps` / `collectCombinedCodeGaps` 不是全新概念，当前已在 adapter 中存在；本阶段目标是迁入 core 并稳定其输入输出契约。
- `buildQuestionCheckpointEnforcement` 当前也已存在，但属于 prompt 层，迁移到 3G；3F 只产出它需要的 pending gap。
- FR11 attribution 在本阶段只负责决策和状态，不直接生成模型提示词。

新增测试：

```text
test-core-drift-engine.cjs
test-core-attribution.cjs
```

重点覆盖：

- `ALIGNED`
- `DESIGN_PENDING_TASKS`
- `TASKS_PENDING_DESIGN`
- `CODE_PENDING_REVIEW`
- `MULTI_DRIFT`
- 多 active change-dir。
- 已归档 change-dir 跳过。
- no-edit review 二次确认。
- attribution `no-attribution` / `single` / `session-touched` / `active-ttl` / `needs-review`。

验收：

```powershell
npm run build
npm test
```

```bash
npm run build
npm test
```

## 阶段 3G：抽 Prompt、Report 和 Hydration

新增模块：

```text
src/core/prompts.js
src/core/report.js
src/core/hydration.js
```

迁移内容：

- `buildToolEnforcement`
- `buildCodeEnforcement`
- `buildStopEnforcement`
- `buildQuestionCheckpointEnforcement`
- `buildSubagentCheckpointEnforcement`
- attribution review prompt。
- `buildPreCompactSummary`
- `.sdd-drift-report.md` 生成和清理。
- transcript hydration。
- checkpoint output hydration。

边界：

- PreCompact handler 注册仍在 adapter/dispatcher 层；`buildPreCompactSummary` 迁入 core。
- Prompt 模块只根据 drift-engine 输出的结构化 gap 生成文本，不直接扫描文件或修改状态。
- OpenCode tool-result 提示、Claude Stop block、question checkpoint 使用同一组核心语义，但输出协议由 output/adapter 决定。

新增测试：

```text
test-core-prompts.cjs
test-core-report.cjs
test-core-hydration.cjs
```

重点覆盖：

- prompt 必须包含模板保护规则。
- prompt 必须包含“SDD 是当前任务 checkpoint，不是最终任务”。
- OpenCode tool-result prompt 和 Claude Stop prompt 差异。
- report 内容不变时不刷新。
- failed tool result 不产生 false drift。
- checkpoint output 只信任 changed files 摘要。

prompt 测试锚点至少包含：

```text
Do not add new sections.
Do not rewrite the document template.
Find the existing section that should change and edit that section only.
SDD review is a checkpoint inside the current task, not the final task.
After the SDD review or synchronization is complete, return to the original user task.
```

验收：

```powershell
npm run build
npm test
```

```bash
npm run build
npm test
```

## 最终验收

全部阶段完成后运行：

```powershell
cd test\opencode-sdd-drift-e2e
npm test
npm run e2e:real:native -- -Provider deepseek
npm run e2e:real:native -- -Provider minimax
```

```bash
cd test/opencode-sdd-drift-e2e
npm test
npm run e2e:real:native -- -Provider deepseek
npm run e2e:real:native -- -Provider minimax
```

Claude Code 也必须验证：

```powershell
cd test\claude-code-sdd-drift-e2e
npm run e2e:real -- -Provider deepseek -Scenario multi-code-cascade
npm run e2e:real -- -Provider minimax -Scenario multi-code-cascade
```

```bash
cd test/claude-code-sdd-drift-e2e
npm run e2e:real -- -Provider deepseek -Scenario multi-code-cascade
npm run e2e:real -- -Provider minimax -Scenario multi-code-cascade
```

## 风险和控制

| 风险 | 控制 |
| --- | --- |
| 状态机拆分后行为漂移 | 先补 characterization tests，再移动代码 |
| `project.json` 跨 session 语义被破坏 | 阶段 3E 单独拆，单独测试 |
| OpenCode adapter 与 Claude command hook 输出差异被误改 | `core/output.js` golden tests |
| prompt 规则丢失导致模型覆盖模板 | `test-core-prompts.cjs` 检查关键句 |
| report timestamp 反复刷新 | report idempotent test |
| Windows 路径大小写和斜杠问题 | `test-core-paths.cjs` 覆盖 |
| core 模块互相引用形成环 | 依赖图按 L0-L7 单向检查 |
| FR11 attribution 迁移后行为变弱 | 先补 attribution characterization，再迁移实现 |
| OMO 旧桥接行为被误当目标用户面 | 文档明确 OMO 非目标用户面，验收只覆盖 Claude Code / OpenCode |

## 分阶段完成标准

每阶段完成必须满足：

- 新增/调整的 core 测试通过。
- `npm run build` 成功。
- `npm test` 成功。
- 发布件 `sdd-drift-check-hook.js` 和 `sdd-drift-check-opencode.js` 已同步。
- 不改变用户安装路径。
- 不重新引入 OMO 作为目标用户面。旧 OMO 桥接若仍输出 Claude-style hook input，可能 best-effort 可用，但不进入本方案验收矩阵；推荐用户面是 Claude Code command hook 或 OpenCode native plugin。

---

## 评审记录 v1.0

**评审日期:** 2026-05-22
**评审者:** Claude（Opus 4.7）
**评审对照:** 本 plan ↔ [sdd-drift-check-hook.prd.zh.md](./sdd-drift-check-hook.prd.zh.md) v1.1 + [sdd-drift-check-hook.design.zh.md](./sdd-drift-check-hook.design.zh.md) v1.0 + 主仓库 `plugins/sdd-drift-check/src/` 已落地的部分

按严重度组织。每条含定位、问题、建议。

### 高严重度（影响落地）

#### Issue 1：与 PRD / design 的关系未声明

本 plan 没有引用 PRD 或 design：

- [sdd-drift-check-hook.prd.zh.md](./sdd-drift-check-hook.prd.zh.md)（v1.1，13 个 FR / 16 个用户旅程）
- [sdd-drift-check-hook.design.zh.md](./sdd-drift-check-hook.design.zh.md)（v1.0，P0–P6 阶段）

design 用 P0–P6 编号，本 plan 用 3A–3G——读者无法对应：

| 本 plan 阶段 | 推测对应 design 阶段 |
| --- | --- |
| 3A 安全网 | P0（snapshot baseline）的延伸 |
| 3B 路径 + 文件分类 | P1（结构重排） |
| 3C 诊断 / 锁 / state 存储 | P1 / P2 |
| 3D Session State | P1 / P5 部分 |
| 3E Project State | P5 |
| 3F Drift Engine | P5 / P6 |
| 3G Prompts / Report / Hydration | P4 / P5 / P6 |

**建议**：开头加"与 PRD / design 的对应表"，明确本 plan 是 design P1–P5 的工程拆分细化。FR11 LLM 评审是否在范围需明确（见 Issue 2）。

#### Issue 2：FR11 LLM 评审驱动归属去向不明

design 的 FR11 / J11 / J13 / J14 依赖 attribution review prompt 注入 + 后续动作观察。主仓库 `plugins/sdd-drift-check/src/` 已有 `attribution.js`，说明部分工作已开始，但本 plan：

- 仅在 3F drift-engine 一笔带过"attribution review decision"
- attribution prompt 模板未列在 3G prompts 的迁移列表
- `attributionReviews` session state 字段的归属阶段未指定
- LLM 后续动作观察机制（design §8.3 `identifyResolutionTarget`）未提及

**建议**：补一节"FR11 当前状态"，描述 `attribution.js` 已实现到哪一步、还需要在哪些阶段补全。若 FR11 完整实现不在本 plan 范围，明示推迟到后续 plan。

#### Issue 3：阶段 3A 安全网范围过大

阶段 3A 列了 12 个场景 + 4 个新测试文件，覆盖范围接近"全旅程 fixture 网"。这一阶段实际相当于 design 的 P0，工作量大、风险高，与其他单一职责阶段不对称。

**建议**：拆为：

- **3A-1**：core 行为 characterization（peer drift / archive 跳过 / no-edit 确认 / DTS context / hydration）
- **3A-2**：adapter characterization（OpenCode native before-cache / Stop inject / tool result append）

后续每个 3x 阶段移动代码时，先确认本阶段 characterization 已绿。

#### Issue 4：核心模块依赖图缺失

15 个 core 模块（diagnostics / drift-engine / file-classifier / hydration / locks / output / paths / project-state / prompts / report / runtime-config / sdd-rules / session-state / state-storage / tool-events）之间的依赖关系完全没明示。

显而易见的依赖：

- `drift-engine` 依赖 `session-state` + `project-state` + `sdd-rules` + `file-classifier`
- `hydration` 依赖 `tool-events` + `state-storage` + `paths`
- `output` 依赖 `prompts` + `runtime-config`

**建议**：附录加一张依赖箭头图或拓扑层次表，明确层次：

```text
L0  runtime-config | paths
L1  file-classifier | sdd-rules | locks | state-storage | diagnostics
L2  tool-events | session-state | hydration
L3  project-state
L4  drift-engine
L5  prompts | report
L6  output
```

避免日后出现循环依赖。

### 中严重度（应解决）

#### Issue 5：file-classifier vs sdd-rules 分工模糊

3B 把 `findSdd` / `getChangeDoc` / archive 判断都放在 file-classifier。但 `sdd-rules.js` 已存在（在「当前基础」里），其内容未说明。

`getChangeDoc` 是路径模式识别还是 SDD 业务规则？archive 判断涉及 `fs.statSync`，不是纯路径分类。

**建议**：明示分工：

- **file-classifier**：纯路径匹配（`isCodePath` / `isSddPath` / `isSddChangePath` / `toPosix` / `normalizeKey`）
- **sdd-rules**：业务常量（`CHANGE_DOC_REQUIREMENTS` / archive marker 列表 / DTS 模式）+ 高级 SDD 函数（`findSdd` / `getChangeDoc` / `isArchivedChangeDir`）

#### Issue 6：3D / 3E 跨阶段耦合

`updateRequirementsForEdit` 列在 3D（session state），但 peer sync 逻辑可能跨 session 持续（J5 跨会话 tasks→design drift 检测要看 project doc 时间戳）。

3D 完成时 session-state 仍持有 peerSyncs；3E 时需要再处理 project 视角的 peer drift。

**建议**：3D 抽 session state 时显式保留 peer-sync 在 session（同会话内有效）。3E 新增 project-level 跨会话 peer drift 检测（作为补充，不替换）。文档化这层关系。

#### Issue 7：阶段 3F 列的函数与现状不一一对应

文档列：

- `collectCombinedPeerGaps`
- `collectCombinedCodeGaps`

但当前 `plugins/sdd-drift-check/sdd-drift-check-hook.js` 只有 `collectPeerGaps` / `collectCodeGaps`，没 Combined 版本。

3G 列的 `buildQuestionCheckpointEnforcement` 也同——现状叫 `buildSubagentCheckpointEnforcement`。

**建议**：明示这些 Combined / Question 是新创函数还是已存在于 `src/core` 某处。如已存在，说明在哪个模块；如新创，明示设计意图（合并 session + project 视角 / question stop vs subagent checkpoint 的差异）。

#### Issue 8：PreCompact 处理散落多处

PreCompact 相关：

- 3D 列 "PreCompact 需要的 interrupted-review 状态"
- 3G 列 `buildPreCompactSummary`

但 PreCompact handler 本身（Claude Code 注册的入口）在哪个阶段拆，未明示。

**建议**：把 PreCompact handler 收口到 3G 或单独阶段（在 adapter 层注册）。

#### Issue 9：缺少回滚策略

文档说"每阶段必须 npm test 通过"，但没说阶段后期发现 regression 时如何回滚。例如 3F 完成后跑 e2e 发现 regression，回到 3E 之前？

**建议**：明示约定：

- 每阶段一个独立 commit（或一个 PR）
- 阶段失败时 `git reset` 到上阶段 commit
- 每阶段 commit 信息固定格式（如 `refactor(core/3D): extract session state`）

#### Issue 10：OMO 用户迁移路径未交代

文档明示「不重新引入 OMO 作为目标用户面」。但当前 `test/opencode-sdd-drift-e2e/.claude/settings.json` 走 OMO 桥接。重构后：

- OMO 用户继续用 command-hook（OMO 桥接 → command-hook → core）？
- 还是建议迁移到 native-plugin？

**建议**：补一节"现有 OMO 用户迁移"——若 command-hook 仍兼容 OMO 桥接输入，他们无需迁移；若行为有差异，列出迁移步骤。

### 低严重度（可解决）

#### Issue 11：验收命令全为 PowerShell

`cd test\opencode-sdd-drift-e2e` 反斜杠路径在 macOS/Linux 下失败。

**建议**：每个 PowerShell 块旁加 bash 对应：

```bash
cd test/opencode-sdd-drift-e2e
npm test
```

#### Issue 12：`src/index.js` 角色未说明

目录结构里有 `src/index.js`，但全文未说其作用。

**建议**：明示是 module exports aggregator——便于测试访问内部函数。

#### Issue 13：prompt 关键句应给具体原文

3G 说「prompt 必须包含模板保护规则」+「prompt 必须包含'SDD 是当前任务 checkpoint，不是最终任务'」。前者太模糊。

**建议**：附录列出 prompt 必须包含的"原文测试锚点"（grep 字符串列表），便于 `test-core-prompts.cjs` 字节级断言。

#### Issue 14：测试文件物理位置未定义

`test-core-*.cjs` 放在 `test/opencode-sdd-drift-e2e/scripts/` 还是新建 `test/core/`？

如果放 opencode-e2e 下，意味着 Claude Code 不跑这些 core test？建议放在独立的 `test/core/` 或顶层 `tests/`，避免 adapter 强耦合。

#### Issue 15：3E normalize 函数与 PRD / design schema 一致性

`normalizeProjectChangeDir` / `normalizeProjectDoc` 隐含 ProjectState schema。

**建议**：附录或交叉链接：ProjectState schema 见 [design.zh.md §3.2](./sdd-drift-check-hook.design.zh.md)；3E 实现需字段一致。

### 优点

| 优点 | 位置 |
| --- | --- |
| 阶段化推进，每阶段先测试后迁移 | "执行原则" |
| 单一职责：3B–3G 每阶段移动一类逻辑 | 3B–3G |
| 发布件名称与路径不变（用户透明）| "目标" |
| 风险表覆盖关键风险（state 漂移 / 输出差异 / prompt 丢失 / report 刷新 / Windows 路径）| "风险和控制" |
| 最终验收含真实模型 E2E（deepseek / minimax）| "最终验收" |
| Build + test 作为每阶段闸门 | "分阶段完成标准" |
| OMO pivot 明示 | "分阶段完成标准" |
| 适度禁止 big-bang 大搬迁 | "执行原则" |

### 推荐处理顺序

1. **优先解决 Issue 1–4**（与 design 关系 + FR11 范围 + 3A 拆分 + 依赖图）——影响整体执行可行性
2. **Issue 5–10 在每阶段动工前精细化**
3. **Issue 11–15 在文档定稿时一并修**

### 评审处理记录 v1.1

| Issue | 处理结论 | 落点 |
| --- | --- | --- |
| Issue 1 | 接收 | 新增“与 PRD / Design 的关系”和阶段对应表。 |
| Issue 2 | 接收并修正口径 | 明确 FR11 已有 `src/attribution.js` 决策雏形，后续迁入 `src/core/attribution.js` 并补测试。 |
| Issue 3 | 接收 | 将 3A 拆成 3A-1 core 行为安全网和 3A-2 adapter 行为安全网。 |
| Issue 4 | 接收 | 新增 L0-L7 核心模块依赖图和单向依赖约束。 |
| Issue 5 | 接收 | 3B 明确 `paths` / `file-classifier` / `sdd-rules` 分工。 |
| Issue 6 | 接收 | 3D / 3E 明确 session peer sync 与 project carry-over drift 是两层状态。 |
| Issue 7 | 接收并修正口径 | 说明 `collectCombined*` / `buildQuestionCheckpointEnforcement` 当前已存在，本轮是迁移到 core。 |
| Issue 8 | 接收 | 3D / 3G 明确 PreCompact 状态和 handler 注册边界。 |
| Issue 9 | 部分接收 | 增加每阶段 commit 和失败处理约定，但不默认推荐 destructive reset；已推送提交优先 revert 或新分支重做。 |
| Issue 10 | 反驳迁移路径要求，接收边界说明 | OMO 不再作为目标用户面；旧桥接只视为 best-effort，不进入验收矩阵。 |
| Issue 11 | 接收 | 最终验收和阶段验收补 bash 命令。 |
| Issue 12 | 接收 | 执行原则说明 `src/index.js` 是导出聚合入口。 |
| Issue 13 | 接收 | 3G 增加 prompt 原文测试锚点。 |
| Issue 14 | 部分接收 | 短期保留现有测试目录，但要求 core tests 保持 runtime-agnostic；后续测试增长后再迁 `test/core/`。 |
| Issue 15 | 接收 | 3E 明确 ProjectState schema 需与 design §3.2 同步，特别是 `docSyncs` 迁移。 |
