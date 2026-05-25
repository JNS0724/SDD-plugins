# sdd-drift-check 核心重构方案

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

## 当前基础

已完成的结构基础：

```text
src/core/
├─ output.js
├─ runtime-config.js
├─ sdd-rules.js
└─ tool-events.js
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

## 阶段 3A：扩展安全网

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
- checkpoint output hydration。
- transcript hydration。
- OpenCode native adapter before-cache / Stop inject / tool result append。

新增或扩展测试：

```text
test-core-drift-characterization.cjs
test-core-project-carryover.cjs
test-core-report-idempotent.cjs
test-core-hydration.cjs
```

验收：

```powershell
cd test\opencode-sdd-drift-e2e
npm test
```

## 阶段 3B：抽路径与文件分类

新增模块：

```text
src/core/paths.js
src/core/file-classifier.js
```

迁移内容：

- `toPosix`
- `normalizeKey`
- `samePath`
- `rel`
- `resolveFile`
- `isSddPath`
- `isSddChangePath`
- `findSdd`
- `getChangeDoc`
- `isCodePath`
- archive change-dir 判断

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

验收：

```powershell
npm run build
npm test
```

## 阶段 3F：抽 Drift Engine

新增模块：

```text
src/core/drift-engine.js
```

迁移内容：

- `drift`
- `collectPeerGaps`
- `collectCodeGaps`
- `collectCombinedPeerGaps`
- `collectCombinedCodeGaps`
- attribution review decision。
- no-edit confirmation 判定。
- carry-over reminder 判定。

新增测试：

```text
test-core-drift-engine.cjs
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

验收：

```powershell
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
- `buildPreCompactSummary`
- `.sdd-drift-report.md` 生成和清理。
- transcript hydration。
- checkpoint output hydration。

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

验收：

```powershell
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

如果需要验证 Claude Code，再运行：

```powershell
cd test\claude-code-sdd-drift-e2e
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

## 分阶段完成标准

每阶段完成必须满足：

- 新增/调整的 core 测试通过。
- `npm run build` 成功。
- `npm test` 成功。
- 发布件 `sdd-drift-check-hook.js` 和 `sdd-drift-check-opencode.js` 已同步。
- 不改变用户安装路径。
- 不重新引入 OMO 作为目标用户面。
