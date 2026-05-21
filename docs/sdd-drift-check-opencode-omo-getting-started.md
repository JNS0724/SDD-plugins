# sdd-drift-check 入门：让 OpenCode + OMO 别忘了同步 SDD

`sdd-drift-check` 是一个给 OpenCode + OMO 使用的 SDD 文档漂移检查 hook。

它不负责“自动写好文档”，只负责在模型改代码或改 SDD 文档后提醒它：`design.md`、`tasks.md` 这些活跃 SDD 文档可能也要同步。换句话说，它是一个不太爱说话的流程提醒器，平时安静，文档落后时敲一下桌子。

本文默认你已经会使用 OpenCode 和 OMO，只讲这个插件怎么装、怎么用、怎么排查。

## 适用目录

插件识别这两类 SDD 目录：

```text
sdd/changes/<change-id>/
  proposal.md
  design.md
  tasks.md
```

或：

```text
.sdd/changes/<change-id>/
  proposal.md
  design.md
  tasks.md
```

如果项目没有 `sdd/` 或 `.sdd/`，插件会静默退出，不写状态、不出提醒。

## 它检查什么

| 场景 | 行为 |
| --- | --- |
| 改了 `design.md`，同目录 `tasks.md` 已存在但未同步 | 提醒同步 `tasks.md` |
| 改了 `tasks.md`，同目录 `design.md` 已存在但未同步 | 提醒同步 `design.md` |
| 改了 `proposal.md` | 只在 `design.md` 已存在时给软提醒 |
| `tasks.md` 还不存在 | 认为仍在设计阶段，不强迫创建 |
| 改了普通代码 | 提醒最终回复前评审活跃 `design.md` / `tasks.md` |
| 多个 change 同时存在 | 检查所有未归档的活跃 change |
| 模型判断无需改文档 | 允许结束，并写 `.sdd-drift-report.md` 让人确认 |
| DTS / 问题单修改 | 可跳过代码领先文档提醒 |
| 已归档 change | 跳过 |

核心原则很简单：

> 归档前，活跃 SDD 应该和代码事实对齐。

代码如果改变了行为、接口、错误处理、性能策略、数据结构、状态流或用户可见结果，`design.md` 通常要更新；任务完成、取消、拆分或失效时，`tasks.md` 通常要更新。

纯格式化、注释、测试脚手架这类无设计影响的改动，可以不更新文档，但模型需要先评审 SDD。

## 推荐模式

OpenCode + OMO 建议启用：

- `UserPromptSubmit`：捕获用户原始意图，用于识别 DTS / 问题单上下文。
- `PostToolUse`：工具调用后提醒模型，OpenCode 场景最可靠。
- `Stop`：模型准备结束时再做一次收尾检查。

不要只依赖 Stop。真实验证里，OpenCode + OMO 的 Stop-only 不能稳定让模型继续当轮处理。`PostToolUse` 才是当前更可靠的级联提醒点。

## 安装

### 1. 安装 OMO

如果项目还没有本地 OMO 依赖：

```powershell
npm install --save-dev oh-my-opencode@3.17.2
```

### 2. 复制 hook

```powershell
New-Item -ItemType Directory -Force .opencode\hooks\sdd-drift-check
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js
```

如果你的插件仓库路径不同，替换源路径即可。

### 3. 确认 OMO 插件入口

```powershell
New-Item -ItemType Directory -Force .opencode\plugin
Set-Content .opencode\plugin\oh-my-opencode.ts 'export { default } from "oh-my-opencode"'
```

### 4. 打开 OMO hook bridge

`.opencode/oh-my-openagent.jsonc`：

```jsonc
{
  "$schema": "../node_modules/oh-my-opencode/schema.json",
  "disabled_hooks": ["legacy-plugin-toast"],
  "claude_code": {
    "commands": false,
    "skills": false,
    "agents": false,
    "mcp": false,
    "plugins": false,
    "hooks": true
  }
}
```

关键是 `"hooks": true`。

### 5. 配置 hooks

`.claude/settings.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit|read|edit|write|multiedit|multi_edit|Task|task|call_omo_agent|background_output|delegate_task",
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ]
  }
}
```

`PostToolUse.matcher` 不建议写 `*`。文件工具和 subagent 结果工具够用，也能减少长会话里的噪音。

## 建议忽略文件

加入 `.gitignore`：

```gitignore
.sdd-drift-report.md
.sdd-drift-hook-state/
.opencode/*.tmp
```

正常状态会优先写到：

```text
.git/sdd-drift-hook-state/
```

`.sdd-drift-report.md` 留在项目根目录，是为了让人能看到待确认项。

## 快速验证

准备：

```text
sdd/changes/demo/
  design.md
  tasks.md
```

`design.md`：

```markdown
# Design

当前实现返回普通问候语。
```

`tasks.md`：

```markdown
# Tasks

- [ ] 实现热情问候语。
```

让 OpenCode 执行：

```text
把 src/app.ts 里的 greet 改成返回带感叹号的热情问候语。完成后检查 sdd/changes/demo/design.md 和 tasks.md 是否需要同步。
```

预期结果：

- 模型改代码后继续读取 `design.md` / `tasks.md`。
- 如文档落后，模型同步 SDD。
- 如果模型认为无需更新，应说明原因，并可能留下 `.sdd-drift-report.md` 供确认。

## 排查

默认诊断日志：

```text
<nearest .git>/sdd-drift-hook-state/sdd-drift-check.log.jsonl
```

如果没有 `.git`，会退到：

```text
<cwd>/.sdd-drift-hook-state/
%TEMP%/sdd-drift-check/
```

如果日志没有新增，通常是 hook 没被调用。优先检查：

1. `.opencode/oh-my-openagent.jsonc` 是否开启 `claude_code.hooks`。
2. `.claude/settings.json` 是否存在且 JSON 正确。
3. hook 脚本路径是否正确。
4. `node` 是否在 `PATH`。
5. 是否在正确项目目录启动 `opencode`。

如果 `node` 不在 `PATH`：

```powershell
$env:SDD_DRIFT_NODE = "C:\Program Files\nodejs\node.exe"
opencode
```

## DTS / 问题单场景

问题单修复有时只需要改代码，不需要同步 SDD。可以显式设置：

```powershell
$env:SDD_DRIFT_DTS_CONTEXT = "1"
opencode
```

禁用这个例外：

```powershell
$env:SDD_DRIFT_DTS_SKIP = "0"
opencode
```

这个例外只跳过“代码领先文档”提醒；如果模型明确改了 `design.md` 或 `tasks.md`，peer 同步仍会生效。

## 多 change 与归档

代码变更后，插件会评审根目录下所有活跃：

```text
sdd/changes/*/{design.md,tasks.md}
.sdd/changes/*/{design.md,tasks.md}
```

以下目录会跳过：

- `archive`、`archives`、`archived`、`.archive`、`.archived`、`已归档`
- 名称带 `archived` / `已归档`
- 包含 `.archived`、`.archive`、`ARCHIVED`、`archived.md`、`archive.md`、`已归档.md`
- 状态文件里写了 `status: archived` 或 `状态: 已归档`

## subagent 场景

如果 OMO 会调用 subagent，保留这些 matcher：

```text
Task|task|call_omo_agent|background_output|delegate_task
```

这样 subagent 返回后，主 agent 还能看到未完成的 SDD 检查。

## 常用开关

关闭日志：

```powershell
$env:SDD_DRIFT_LOG = "0"
opencode
```

指定日志路径：

```powershell
$env:SDD_DRIFT_LOG_PATH = "E:\tmp\sdd-drift-check.log.jsonl"
opencode
```

调整日志保留天数，默认 3 天：

```powershell
$env:SDD_DRIFT_LOG_RETENTION_DAYS = "7"
opencode
```

调整同一代码批次的工具结果提醒次数，默认 1 次：

```powershell
$env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = "2"
opencode
```

如果遇到重复提醒或限流，保持默认 `1` 更稳。

## 边界

- 只追踪 OpenCode / Claude 风格工具事件。
- shell 重定向写文件可能不可见，建议让模型用文件工具改 SDD。
- OpenCode + OMO 下，`PostToolUse` 比 Stop-only 更可靠。
- 最终以文件状态为准，不只看模型最后说“已同步”。

检查结果时重点看：

- `design.md` 是否去掉过时事实。
- `tasks.md` 是否同步任务状态。
- `.sdd-drift-report.md` 是否存在。
- 诊断日志是否显示 hook 被调用。

## 推荐工作流

1. 先写 `proposal.md`。
2. 多轮评审 `design.md`。
3. 设计定稿后生成 `tasks.md`。
4. 实现代码。
5. 让插件提醒模型同步活跃 SDD。
6. 完成后归档 change，避免后续继续检查。

一句话总结：`sdd-drift-check` 不会替你写好 SDD，但能显著降低“代码已经变了，文档还在梦里”的概率。
