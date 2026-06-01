# sdd-review-ledger 多场景真实模型验证报告（2026-06-02）

> 范围：OpenCode 1.2.27 + `sdd-review-ledger-opencode.js` + DeepSeek / MiniMax 真实模型。
> 依据：[`sdd-review-ledger-multi-scenario-test-plan.zh.md`](./sdd-review-ledger-multi-scenario-test-plan.zh.md)。
> 目标：把 7 步主路径扩展为 P01-P18 长流程，观察 B / once / T1 / T2 / end backstop、跨会话、doc-only、code-leading、escape hatch、删除代码、长任务等场景。

## 1. 本次先做的测试工程改造

本次没有修改 `sdd-review-ledger` 插件逻辑，只改测试工程，让它能真正执行新测试计划。

改造内容：

1. `run-real-sdd-review-ledger-workflow.ps1`
   - 新增 `split-multi` 场景。
   - 将旧 7 阶段扩展为 P01-P18。
   - `split-multi` 在 `P08`、`P14` 切新 OpenCode session。
   - 每阶段采集：
     - `injectionTypes`
     - `pendingAdded`
     - `pendingCleared`
     - `checkedAdded`
     - `readEvidence`
   - 临时测试工程新增轻量 `npm run check`，避免 P14 受未安装 TypeScript 依赖影响。

2. `test-sdd-review-ledger-workflow-plan.cjs`
   - 新增测试防护网，断言 runner 里必须存在 P01-P18、`split-multi`、新增采集字段、`SDD_REVIEW=off` 场景。

3. `test-sdd-review-ledger-opencode.cjs`
   - 修正旧断言：当前 once 策略下，同一批第二个 code edit 应该被节流，不应该重复提醒。

## 2. 执行命令

构建：

```powershell
npm --prefix plugins\sdd-review-ledger run build
```

真实模型：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-real-sdd-review-ledger-workflow.ps1 -Provider deepseek -Scenario single-session
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-real-sdd-review-ledger-workflow.ps1 -Provider deepseek -Scenario split-multi
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-real-sdd-review-ledger-workflow.ps1 -Provider minimax -Scenario single-session
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-real-sdd-review-ledger-workflow.ps1 -Provider minimax -Scenario split-multi
```

本地回归：

```powershell
npm --prefix test\opencode-sdd-drift-e2e test
git diff --check
```

## 3. 总览结果

| 模型 | 场景 | RunId | 耗时 | Session | 阶段 | 失败阶段 | 最终 pending | 提醒数 | Error words |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| DeepSeek | `single-session` | `0a4e4656` | 1270.3s | 1 | 18 | 0 | 0 | 15 | 0 |
| DeepSeek | `split-multi` | `b277b465` | 913.6s | 3 | 18 | 0 | 0 | 8 | 0 |
| MiniMax | `single-session` | `b29e80b2` | 772.3s | 1 | 18 | 0 | 0 | 13 | 0 |
| MiniMax | `split-multi` | `42081589` | 834.2s | 3 | 18 | 0 | 0 | 12 | 0 |

原始证据路径：

| 模型 | 场景 | WorkRoot |
|---|---|---|
| DeepSeek | `single-session` | `test/opencode-sdd-drift-e2e/.real-workspaces/ledger-workflow-deepseek-single-session-0a4e46565c2c49178636a25c2092d0c1` |
| DeepSeek | `split-multi` | `test/opencode-sdd-drift-e2e/.real-workspaces/ledger-workflow-deepseek-split-multi-b277b46541e64904bd93983ffa071280` |
| MiniMax | `single-session` | `test/opencode-sdd-drift-e2e/.real-workspaces/ledger-workflow-minimax-single-session-b29e80b2a92646d1a41fbbd664ac4c15` |
| MiniMax | `split-multi` | `test/opencode-sdd-drift-e2e/.real-workspaces/ledger-workflow-minimax-split-multi-42081589169748b58608f6a029182e99` |

结论概览：

- 四轮真实模型均完成 P01-P18。
- 四轮最终 `.sdd-review-todo.md` 的「待评审」区均清空。
- 未观察到无限循环、限流中断、OpenCode 非 0 退出、hook 抛错。
- `SDD_REVIEW=off` 的 P17 在四轮里均未触发提醒。
- MiniMax 的 doc-only 阶段整体更安静。
- DeepSeek `single-session` 在 doc-only 与 carry/backlog 场景提醒偏密。
- DeepSeek `split-multi` 暴露一个重要测试/提示词问题：模型把部分代码写到了 `sdd/changes/**/src` 下，导致前半段真实代码审查未按预期触发。

## 4. 阶段设计与观察重点

| 阶段 | 目的 |
|---|---|
| P01-P02 | 只创建 `badge-greeting` 的 design/tasks，观察 doc-leading 是否静默 |
| P03-P04 | 按 tasks 写代码、连续改代码，观察 full 提醒与 once 节流 |
| P05 | 只改 design，观察 doc-only 是否静默 |
| P06-P07 | 代码追 design、良性重构，观察 review 与 no-doc-change rationale |
| P08-P10 | 新 feature + 共享代码 + 横切重构，观察归属与跨 change-dir |
| P11-P13 | i18n doc/code/review-after-edit，观察 leftover/carry |
| P14 | 长任务 + audit-log + `npm run check`，观察长上下文与最终兜底 |
| P15 | 删除代码模块，观察删除场景是否误报或静默丢项 |
| P16 | 代码领先文档，观察是否推动 design/tasks 同步 |
| P17 | `SDD_REVIEW=off`，观察逃生阀 |
| P18 | 收尾 + review-after-edit，观察最终 pending 是否归零 |

## 5. DeepSeek single-session 详情

RunId: `0a4e4656`
Session: 1 个
最终 pending: 0

| Phase | Injection | Reminders | Pending | Checked | Added | Cleared | Read |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| P01-design-only | none | 0 | 0 | 2 | 0 | 0 | - |
| P02-tasks-only | none | 0 | 1 | 2 | 1 | 0 | - |
| P03-code-from-tasks | full:1 | 1 | 3 | 2 | 2 | 0 | todo design tasks |
| P04-multi-code | full:1 | 1 | 5 | 2 | 4 | 2 | todo design tasks code |
| P05-design-change | full:1, carry:1 | 1 | 5 | 2 | 1 | 1 | todo |
| P06-code-after-design-then-tasks | full:1 | 1 | 5 | 2 | 2 | 2 | todo code |
| P07-benign-refactor | full:1 | 1 | 5 | 2 | 1 | 1 | todo |
| P08-vip-design-new-session | full:1, carry:2 | 1 | 6 | 2 | 1 | 0 | todo design |
| P09-vip-code-shared-file | full:1, carry:1 | 1 | 9 | 2 | 5 | 2 | todo tasks code |
| P10-cross-cutting-refactor | full:1, carry:2 | 1 | 0 | 10 | 0 | 9 | todo design tasks code |
| P11-i18n-docs-only | none | 0 | 2 | 10 | 2 | 0 | - |
| P12-i18n-code | full:1 | 1 | 0 | 13 | 0 | 2 | todo design tasks code |
| P13-review-then-edit-design | full:1, leftover-short:2 | 1 | 1 | 13 | 1 | 0 | todo design code |
| P14-audit-log-long-task | full:1 | 1 | 9 | 13 | 8 | 0 | todo code |
| P15-delete-i18n-module | full:1, compact:1, carry:1 | 2 | 9 | 13 | 5 | 5 | todo design tasks code |
| P16-code-leading-bugfix | full:1, carry:10 | 1 | 0 | 16 | 0 | 9 | todo design tasks code |
| P17-review-disabled-change | none | 0 | 0 | 16 | 0 | 0 | - |
| P18-final-leftover-and-wrap | full:1, carry:1 | 1 | 0 | 16 | 0 | 0 | todo design tasks code |

观察：

- P03/P04/P10/P12/P16/P18 的取证路径完整度较好。
- P05/P08 这类 doc-only 阶段出现了 `full/carry`，说明 backlog/carry 在单会话长任务中会让提醒偏密。
- P10 一次清掉 9 个 pending，是本轮最明显的 backlog flush。
- P16 出现 `carry:10`，说明模型在代码领先文档阶段最后完成了集中清理，但提醒量偏高。
- 最终待评审清空，功能性通过；体验层面偏吵。

## 6. DeepSeek split-multi 详情

RunId: `b277b465`
Session: 3 个
最终 pending: 0

| Phase | Injection | Reminders | Pending | Checked | Added | Cleared | Read |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| P01-design-only | none | 0 | 0 | 2 | 0 | 0 | - |
| P02-tasks-only | none | 0 | 1 | 2 | 1 | 0 | - |
| P03-code-from-tasks | none | 0 | 1 | 2 | 0 | 0 | - |
| P04-multi-code | none | 0 | 1 | 2 | 0 | 0 | - |
| P05-design-change | none | 0 | 2 | 2 | 1 | 0 | - |
| P06-code-after-design-then-tasks | none | 0 | 2 | 2 | 1 | 1 | - |
| P07-benign-refactor | none | 0 | 2 | 2 | 0 | 0 | - |
| P08-vip-design-new-session | none | 0 | 3 | 2 | 1 | 0 | - |
| P09-vip-code-shared-file | none | 0 | 4 | 2 | 1 | 0 | - |
| P10-cross-cutting-refactor | none | 0 | 4 | 2 | 0 | 0 | - |
| P11-i18n-docs-only | none | 0 | 6 | 2 | 2 | 0 | - |
| P12-i18n-code | compact:2 | 2 | 6 | 2 | 0 | 0 | - |
| P13-review-then-edit-design | compact:1, leftover-short:8 | 1 | 4 | 3 | 0 | 2 | todo design tasks |
| P14-audit-log-long-task | full:1 | 1 | 7 | 3 | 3 | 0 | todo design tasks code |
| P15-delete-i18n-module | none | 0 | 7 | 3 | 0 | 0 | - |
| P16-code-leading-bugfix | full:1, carry:1 | 1 | 8 | 3 | 7 | 6 | todo design tasks code |
| P17-review-disabled-change | none | 0 | 8 | 3 | 0 | 0 | - |
| P18-final-leftover-and-wrap | full:1, compact:2, leftover-short:6, carry:1 | 3 | 0 | 10 | 0 | 8 | todo design tasks code |

观察：

- 前半段 P03-P11 基本没有 SDD review 提醒，不是 hook 丢失，而是模型把部分代码写错了位置。
- 错写路径：
  - `sdd/changes/badge-greeting/src/badgeFormatter.ts`
  - `sdd/changes/badge-greeting/src/badgeGreeting.ts`
  - `sdd/changes/badge-greeting/src/index.ts`
  - `sdd/changes/vip-tiers/src/tiers.ts`
- 这些路径在 `sdd/changes/**` 下，会被视为 SDD 区域内容，而不是根目录 `src/**` 的正常代码变更。
- P13/P14/P16/P18 后半段仍然能通过 carry/full 收敛，最终 pending 清空。
- 这轮暴露的是测试 prompt 的路径约束不够强，不应直接判定为插件缺陷。

建议后续修测试 prompt：

```text
All implementation files must be created under the repository root src/ directory.
Never create code files under sdd/changes/**/src.
```

## 7. MiniMax single-session 详情

RunId: `b29e80b2`
Session: 1 个
最终 pending: 0

| Phase | Injection | Reminders | Pending | Checked | Added | Cleared | Read |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| P01-design-only | none | 0 | 0 | 2 | 0 | 0 | - |
| P02-tasks-only | none | 0 | 1 | 2 | 1 | 0 | - |
| P03-code-from-tasks | full:1 | 1 | 0 | 5 | 0 | 1 | todo code |
| P04-multi-code | full:1 | 1 | 0 | 6 | 0 | 0 | todo code |
| P05-design-change | none | 0 | 1 | 6 | 1 | 0 | - |
| P06-code-after-design-then-tasks | full:1 | 1 | 1 | 6 | 1 | 1 | todo tasks code |
| P07-benign-refactor | full:1 | 1 | 0 | 6 | 0 | 1 | todo tasks code |
| P08-vip-design-new-session | none | 0 | 1 | 6 | 1 | 0 | - |
| P09-vip-code-shared-file | full:1 | 1 | 0 | 9 | 0 | 1 | todo design tasks code |
| P10-cross-cutting-refactor | full:1 | 1 | 0 | 10 | 0 | 0 | todo code |
| P11-i18n-docs-only | none | 0 | 2 | 10 | 2 | 0 | - |
| P12-i18n-code | full:1 | 1 | 0 | 13 | 0 | 2 | todo code |
| P13-review-then-edit-design | full:1, leftover-short:1 | 1 | 1 | 13 | 1 | 0 | todo design code |
| P14-audit-log-long-task | full:1 | 1 | 0 | 16 | 0 | 1 | todo code |
| P15-delete-i18n-module | compact:2 | 2 | 0 | 16 | 0 | 0 | - |
| P16-code-leading-bugfix | full:1 | 1 | 0 | 16 | 0 | 0 | todo design code |
| P17-review-disabled-change | none | 0 | 0 | 16 | 0 | 0 | - |
| P18-final-leftover-and-wrap | full:1 | 1 | 0 | 16 | 0 | 0 | todo design tasks code |

观察：

- doc-only 的 P05/P08/P11 均静默，只被动进入 todo，符合预期。
- 多数 code 阶段能在本阶段内清空 pending，节奏比 DeepSeek single 更平滑。
- P15 删除 i18n 模块出现 `compact:2`，但最终仍无 pending。
- 审计理由整体比 DeepSeek single 更具体，不过仍有个别 “scripts/check.mjs 理由过简”。

## 8. MiniMax split-multi 详情

RunId: `42081589`
Session: 3 个
最终 pending: 0

| Phase | Injection | Reminders | Pending | Checked | Added | Cleared | Read |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| P01-design-only | none | 0 | 0 | 2 | 0 | 0 | - |
| P02-tasks-only | none | 0 | 1 | 2 | 1 | 0 | - |
| P03-code-from-tasks | full:1 | 1 | 0 | 5 | 0 | 1 | todo code |
| P04-multi-code | full:1 | 1 | 0 | 6 | 0 | 0 | todo design code |
| P05-design-change | none | 0 | 1 | 6 | 1 | 0 | - |
| P06-code-after-design-then-tasks | full:1 | 1 | 1 | 6 | 1 | 1 | todo tasks code |
| P07-benign-refactor | full:1 | 1 | 0 | 6 | 0 | 1 | todo |
| P08-vip-design-new-session | none | 0 | 1 | 6 | 1 | 0 | - |
| P09-vip-code-shared-file | full:1 | 1 | 0 | 9 | 0 | 1 | todo design tasks code |
| P10-cross-cutting-refactor | full:1 | 1 | 0 | 9 | 0 | 0 | todo code |
| P11-i18n-docs-only | none | 0 | 2 | 9 | 2 | 0 | - |
| P12-i18n-code | full:1 | 1 | 0 | 12 | 0 | 2 | todo code |
| P13-review-then-edit-design | full:1, leftover-short:6 | 1 | 1 | 12 | 1 | 0 | todo design code |
| P14-audit-log-long-task | full:1 | 1 | 0 | 15 | 0 | 1 | todo design tasks code |
| P15-delete-i18n-module | full:1 | 1 | 0 | 15 | 0 | 0 | todo design tasks code |
| P16-code-leading-bugfix | full:1 | 1 | 0 | 15 | 0 | 0 | todo design tasks code |
| P17-review-disabled-change | none | 0 | 0 | 15 | 0 | 0 | - |
| P18-final-leftover-and-wrap | full:1 | 1 | 0 | 15 | 0 | 0 | todo design tasks code |

观察：

- 跨会话后仍然稳定触发。
- P08/P14 后 session 切换成功，最终 3 个 session。
- P05/P08/P11 doc-only 阶段静默，符合 B/doc-leading 预期。
- P13 出现 leftover-short，但下一阶段没有持续循环，最终收敛。
- P15 删除模块仍触发 full review，但读了 design/tasks/code 并清空 pending，未观察到误删除文件浮现或报错。

## 9. 行为矩阵判定

| 行为 | 判定 | 证据 |
|---|---|---|
| C1 冷启动 bootstrap | PASS | P01 无主动提醒，初始 `scripts/check.mjs` / design 进入已评审历史 |
| C2 doc 领先 code 静默 | 基本 PASS | MiniMax 两轮 P05/P08/P11 静默；DeepSeek single 因 backlog/carry 偏吵 |
| C3 review 不自动写实现 | PASS | P05 未直接推动 code 实现，后续 P06 才按用户任务写 code |
| C4 once 默认节流 | PASS | 同批多改主要表现为一条 full；测试断言已更新为第二个 code edit 不重复提醒 |
| C5 结束点兜底 | PASS | 四轮最终 pending 均清空，无静默丢项 |
| C6 T1 最终门槛 | PASS | P10/P12/P16/P18 均能清空或集中清理 pending |
| C7/T2 同回合 leftover | PASS with noise | P13/P18 出现 leftover-short，并能收敛；DeepSeek split P13 leftover 次数偏高 |
| C8 跨回合 carry | PASS with noise | DeepSeek single/split 出现 carry 并最终清空；DeepSeek single carry 密度偏高 |
| C9 纯规划静默 | 基本 PASS | MiniMax 表现符合；DeepSeek single 受 backlog 影响出现主动提醒 |
| C11 attribution | 部分观察 | 多 change-dir 可以被模型处理，但 DeepSeek split 有路径写错导致归属观察被污染 |
| C12 良性变更 | PASS | P07 能通过 no-doc-change / evidence rationale 清理 |
| C13 code 领先 doc | PASS | P16 后均能推动相关 design/tasks 或清理 pending |
| C14 删除文件 | PASS | P15 无 hook 错误，最终 pending 可清空 |
| C15 `SDD_REVIEW=off` | PASS | 四轮 P17 均无提醒 |
| C16 跨会话延续 | PASS | `split-multi` 均 3 session，最终 pending 归零 |
| C17 长任务/压缩压力 | 部分观察 | P14 长任务通过，但未确认真的触发上下文压缩 |
| W1 取证质量 | 改善但仍需观察 | 修正编码后复盘显示多数提醒后有 read；部分阶段只读 todo/code，design/tasks 取证不完整 |
| W2 理由质量 | 仍有问题 | 多处仍出现“理由过简，建议补充”；个别 rationale 有截断或语义松动 |

## 10. 隐藏问题清单

### 10.1 测试工程问题：Windows 编码导致正则异常

首次执行 DeepSeek `single-session` 时，还未进入模型调用就失败：

```text
Unterminated [] set
```

根因：PowerShell 脚本中的 todo 解析正则含中文/长破折号，在当前 Windows 输出环境里显示为乱码后形成非法正则。

处理：把 todo 行解析改为 ASCII 安全方案，先抓 `path@hash`，再用宽松方式解析 candidate 和 rationale。

状态：已修复，后续四轮真实模型均跑完。

### 10.2 测试工程问题：readEvidence 原报告不可信

四轮真实模型跑完后，生成的 `workflow-report.md` 中 `Read Evidence` 大量显示 `False`。复盘 JSONL 发现模型实际有 read 行为。

根因：OpenCode 的 stdout 通过 PowerShell 重定向写成 UTF-16LE；辅助复盘脚本按 UTF-8 读取，导致扫不到 JSON 行。

处理：

- runner 已改为基于 PowerShell `Read-Text` 的原文扫描。
- 本报告的 read 结果来自修正后的编码读取复盘，不采用旧 `workflow-report.md` 里的 `readEvidence=False`。

状态：已修复。以后新跑的 workflow summary/report 会记录正确的 readEvidence。

### 10.3 模型行为问题：DeepSeek split-multi 写错代码目录

DeepSeek `split-multi` 前半段未触发 review，最终定位到模型把代码写到了 SDD change-dir 内部：

```text
sdd/changes/badge-greeting/src/badgeFormatter.ts
sdd/changes/badge-greeting/src/badgeGreeting.ts
sdd/changes/badge-greeting/src/index.ts
sdd/changes/vip-tiers/src/tiers.ts
```

影响：

- 这些文件位于 `sdd/changes/**` 下，会被当成 SDD 区域内容，而不是根目录 `src/**` 的业务代码。
- P03-P11 的 review 触发节奏因此被污染。
- 最终仍通过 P13/P14/P16/P18 收敛，但这轮不能完全代表正常工程路径。

建议：

- 修改测试 prompt，明确实现文件必须写入仓库根目录 `src/**`。
- 禁止在 `sdd/changes/**/src` 下创建代码文件。
- 后续可增加测试工程断言：运行结束后若存在 `sdd/changes/**/src/*.ts`，报告中标记为 `PROMPT-PATH-DRIFT`。

### 10.4 体验问题：DeepSeek single-session 提醒偏密

DeepSeek `single-session` 的提醒数为 15，明显高于 DeepSeek `split-multi` 的 8。

主要表现：

- P05 doc-only 阶段出现 `full:1, carry:1`。
- P08 doc-only 阶段出现 `full:1, carry:2`。
- P16 出现 `carry:10`，最后集中清理。

判断：

- 这不是无限循环，也不是功能失败。
- 它说明长单会话里 backlog/carry 对 DeepSeek 的体验偏重，会把 doc-only 阶段也带出主动提醒。

建议：

- 保持当前机制先不改插件。
- 后续如果要优化体验，应基于真实报告再讨论 carry 降噪，而不是立刻修改核心策略。

### 10.5 审计理由质量仍不稳定

四轮最终都清空 pending，但理由质量仍有明显差异：

- DeepSeek single 中多条为：

```text
（理由过简，建议补充）
```

- MiniMax 理由通常更具体，但也存在语义松动。例如将 `Ultimate` 对 `VIP` 的覆盖写成 intentional drift，表达不够严谨。

判断：

- 插件可以把 review 带到模型面前。
- 模型是否给出高质量审计理由，仍然受模型和 prompt 约束影响。

建议：

- 后续可单独优化 `sdd-review-rules.md` 或 review prompt 的 rationale 格式要求。
- 不建议在本轮同步修改插件逻辑，因为本轮目标是先验证新测试计划。

## 11. 本地回归

执行：

```powershell
npm --prefix test\opencode-sdd-drift-e2e test
```

结果：通过。

覆盖项包括：

- `sdd-drift-check` build check
- `sdd-review-ledger` build check
- core 单元测试
- OpenCode native plugin 测试
- `sdd-review-ledger workflow plan coverage test`
- turn checkpoint 测试
- journey fixture 测试

执行：

```powershell
git diff --check
```

结果：通过，仅有 Windows CRLF 提示，无 whitespace error。

## 12. 最终结论

本轮完成了新测试计划的第一版可执行化，并用 DeepSeek / MiniMax 各跑了 `single-session` 和 `split-multi`。

可以确认：

- P01-P18 新 runner 可真实执行。
- 两个真实模型都能跑完整流程。
- OpenCode 跨 session 场景能延续 ledger/todo 状态。
- 最终 pending 能归零。
- `SDD_REVIEW=off` 有效。
- 未出现无限循环、限流失败、OpenCode fatal error。

需要继续关注：

- DeepSeek `single-session` 的 carry/backlog 提醒偏密。
- DeepSeek `split-multi` 暴露的实现路径漂移，应先修测试 prompt。
- 审计理由质量仍不稳定，尤其是“理由过简”和个别语义松动。
- P14 长任务未证明真实上下文压缩发生，只能算长任务观察，不算压缩专项验证。

本轮建议：

1. 接受当前测试工程改造和报告入库。
2. 下一轮优先补强测试 prompt 的路径约束。
3. 在修正路径约束后重跑 DeepSeek `split-multi`，确认 P03-P11 的 review 触发节奏恢复正常。
4. 暂不改插件核心策略，先用这份报告作为后续体验优化基线。
