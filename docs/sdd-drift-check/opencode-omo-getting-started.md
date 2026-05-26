# sdd-drift-check 旧版 OpenCode + OMO 桥接指南

> 当前推荐入口是 OpenCode 原生插件或 Claude Code command hook，见
> [sdd-drift-check.md](./sdd-drift-check.md)。本文保留给仍在使用
> OpenCode + OMO hook bridge 的项目作为历史兼容参考，不进入当前主验收矩阵。

`sdd-drift-check` 是一个 SDD 文档漂移检查 hook。旧版 OpenCode + OMO
桥接可以把 Claude Code 风格 hook 转接给 OpenCode，但 Stop continuation
和部分 checkpoint 行为取决于 OMO 的桥接能力，稳定性不如 OpenCode 原生插件。

它不负责“自动写好文档”，只负责在模型改代码或改 SDD 文档后提醒它：`design.md`、`tasks.md` 这些活跃 SDD 文档可能也要同步。换句话说，它是一个不太爱说话的流程提醒器，平时安静，文档落后时敲一下桌子。

本文默认你已经会使用 OpenCode 和 OMO，只讲旧桥接方式怎么装、怎么用、怎么排查。新项目请优先使用原生 OpenCode 插件安装方式。

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
| 改了普通代码 | 每个会话最多一次弱提醒；后续代码改动先记录，等 `Stop` / 提问 / 压缩前统一评审活跃 `design.md` / `tasks.md` |
| 多个 change 同时存在 | 检查所有未归档的活跃 change |
| 跨会话遗留 drift | 通过项目级 `project.json` 继续识别并提醒 |
| 模型判断无需改文档 | 允许结束，并写 `.sdd-drift-report.md` 让人确认 |
| DTS / 问题单修改 | 可跳过代码领先文档提醒 |
| 已归档 change | 跳过 |

核心原则很简单：

> 归档前，活跃 SDD 应该和代码事实对齐。

代码如果改变了行为、接口、错误处理、性能策略、数据结构、状态流或用户可见结果，`design.md` 通常要更新；任务完成、取消、拆分或失效时，`tasks.md` 通常要更新。

纯格式化、注释、测试脚手架这类无设计影响的改动，可以不更新文档，但模型需要先评审 SDD。

## 推荐模式（旧 OMO 桥接）

OpenCode + OMO 旧桥接建议启用：

- `UserPromptSubmit`：捕获用户原始意图，用于识别 DTS / 问题单上下文。
- `PreCompact`：上下文压缩前注入未完成的 SDD 状态摘要。
- `PostToolUse`：记录工具调用结果；直接改 SDD 文档时会即时提醒 peer 同步。
- `PreToolUse`：只拦截提问/确认类工具，避免模型把“要不要提交/继续”抛给用户前漏掉 SDD 检查。
- `Stop`：模型准备结束时再做一次收尾检查。

代码文件变更默认采用“一次弱提醒 + 阶段末聚合审查”，而不是每次 `.ts` 写入后都打断模型。这样长任务里连续改代码不会被 SDD 审查切碎；到模型准备停止、提问、进入子任务 checkpoint 或上下文压缩前，hook 再统一提醒它评审并同步 SDD。

### 多轮改代码时会怎样

插件不会把每一次代码写入都变成一次 SDD 审查。它更像一个阶段检查员：先让模型把当前实现做完，再提醒它回头看活跃 SDD 是否落后。

例子一：你让模型“实现登录功能”。

模型可能连续修改 `src/auth.ts`、`src/routes.ts`、`src/session.ts`。第一次代码写入后，你可能看到一次 `SDD drift code review noted`；后面几个文件继续改时通常不会再提醒。等模型准备结束、提问或压缩上下文前，插件会要求它统一 review 活跃的 `design.md` / `tasks.md`，该同步就同步。

例子二：同一个会话里，你又说“再加一个忘记密码入口”。

模型继续改 `src/auth.ts` 或 `src/password-reset.ts` 时，默认不一定再出现新的 `SDD drift code review noted`，因为代码工具结果里的弱提醒默认是每个会话最多一次。这不代表插件没记录。新的代码事实仍会进入检查状态，模型准备结束、提问或压缩上下文前，仍应该再次评审 SDD。

例子三：模型评审后说“这次不用改 SDD”。

如果只是格式化、注释、测试脚手架这类没有设计影响的改动，模型可以在读过 `design.md` / `tasks.md` 后说明无需修改。之后你继续让它改新功能时，之前的“无需修改”不会永久生效；只要又发生新的代码改动，阶段末仍会重新检查。

如果你希望同一个会话里每次追加需求后都更明显地提醒模型，可以把后面的 `SDD_DRIFT_CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS` 调大。默认值更克制，目的是减少长任务里的重复打断。

## 使用后会看到什么

这个插件大部分时间应该是安静的。它只在模型准备把代码、SDD 文档或会话控制权推进到下一个阶段时插一句“先把 SDD 对齐”。

| 使用场景 | 你可能看到的现象 | 这是不是问题 |
| --- | --- | --- |
| 项目没有 `sdd/` 或 `.sdd/` | 没有提醒，通常也不会有业务状态变化 | 正常，插件没有 SDD 工作区可检查 |
| 新开或继续一个会话 | 一般无感；如果上次有未处理 drift，模型开局可能收到 carry-over 提醒 | 正常，这是跨会话恢复 |
| 模型改了普通代码 | 本会话第一次代码批次可能出现一次 `SDD drift code review noted`；后续代码改动通常静默记录 | 正常，这是弱提醒，不要求立刻停下编码；最终仍会在阶段末聚合检查 |
| 用户在同一会话里多次追加需求并继续改代码 | 后续改动可能没有新的 `PostToolUse` 弱提醒，但会更新内部代码修改序号，并在 `Stop` / 提问 / 压缩前重新检查 | 正常限制；当前按 session 聚合，不按每次用户消息强切提醒窗口 |
| 模型改了 `design.md` | 如果同目录 `tasks.md` 已存在，模型会被提醒同步 `tasks.md` | 正常，属于文档 peer 同步 |
| 模型改了 `tasks.md` | 如果同目录 `design.md` 已存在，模型会被提醒同步 `design.md` | 正常，属于文档 peer 同步 |
| OMO plan/task/subagent 改了代码 | 子 agent 返回后，主 agent 可能收到 SDD checkpoint 提醒 | 正常，但要求 matcher 包含 `Task|task|call_omo_agent|background_output|delegate_task` |
| 模型准备问“要不要提交/继续” | 可能出现红字 `Error`，内容以 `SDD drift question checkpoint` 开头 | 通常正常，这是 `PreToolUse` 主动 deny 这个提问工具，让模型先继续 SDD 审查 |
| checkpoint 后立刻发生上下文压缩 | 压缩摘要会保留未完成 SDD checkpoint；恢复后模型应先继续 SDD 审查 | 正常；如果恢复后仍忘记，查看日志确认 `PreCompact` 是否触发 |
| 模型准备结束 | `Stop` 会对未评审的代码批次做阶段末兜底提醒；OpenCode 里如果运行时没有继续当轮执行，会在报告里留下未处理项 | 正常限制；问题排查看日志和 `.sdd-drift-report.md` |
| 模型评审后认为文档不用改 | 可以结束；可能留下 `.sdd-drift-report.md` 供人确认 | 正常，最终由人决定是否接受 |
| 问题单 / DTS 修复 | 可设置 `SDD_DRIFT_DTS_CONTEXT=1` 跳过代码领先文档提醒 | 正常例外，但直接改 SDD 文档仍会触发 peer 同步 |

SDD 审查完成后，模型应该回到原始用户任务/请求继续推进；只有原任务也完成时才应该最终回复。若你看到模型“审查完 SDD 就结束会话”，优先看日志里最后一次提醒是否来自 `emit_code_tool_reminder`、`emit_question_checkpoint_enforcement` 或 `stop_block_emit`，这些路径的提示词都会要求模型回到原任务。

红字 `SDD drift question checkpoint` 容易误导。它不是 `console.error`，也不是 JS 异常；它是 hook 返回了结构化的 `permissionDecision: "deny"`，OpenCode/OMO 把“工具被拒绝”渲染成红色。它的目标是阻止模型在 SDD 还没处理时把问题抛给你。

当前提示词正文会以这类结构出现：

```text
<system-reminder>
[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - QUESTION CHECKPOINT]
...
</system-reminder>
```

这不是隐藏系统消息，而是通过 hook/tool 结果传给模型的高优先级可见提醒。正常情况下，模型应完成 SDD review/sync 后回到原来的任务，而不是把 SDD 审查当成最终任务。

需要当成问题排查的情况是：

- 红字后模型没有继续 SDD 审查，也没有任何后续工具调用。
- 同一个 checkpoint 反复出现，模型一直绕不开。
- 日志里出现 `handler_exception`、`circuit_open`，或红字内容是 JS stack trace。

排查时先看：

```powershell
Get-Content .git\sdd-drift-hook-state\sdd-drift-check.log.jsonl -Tail 40
```

常见正常事件：

```text
emit_question_checkpoint_enforcement
precompact_summary_emit
emit_subagent_checkpoint_enforcement
emit_code_tool_reminder
emit_peer_enforcement
stop_allow_no_pending
```

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
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Question|question|AskUserQuestion|ask_user_question|askuserquestion|Confirm|confirm",
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
        "matcher": "Read|Edit|Write|MultiEdit|read|edit|write|multiedit|multi_edit|Task|task|call_omo_agent|background_output|delegate_task|Question|question|AskUserQuestion|ask_user_question|askuserquestion|Confirm|confirm",
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

`PostToolUse.matcher` 不建议写 `*`。文件工具、subagent 结果工具、提问/确认工具够用，也能减少长会话里的噪音。

这些 matcher 不要漏：

```text
Task|task|call_omo_agent|background_output|delegate_task
Question|question|AskUserQuestion|ask_user_question|askuserquestion|Confirm|confirm
```

第一行让 OMO plan/task/subagent 返回后还能触发 SDD 检查；第二行用于捕获“要不要提交/继续”这类交接点。

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

安装后先确认 hook 有被调用：

```powershell
Get-ChildItem -Force .git\sdd-drift-hook-state
Get-Content .git\sdd-drift-hook-state\sdd-drift-check.log.jsonl -Tail 20
```

如果项目不是 Git 仓库，再看：

```powershell
Get-ChildItem -Force .sdd-drift-hook-state
Get-ChildItem -Force "$env:TEMP\sdd-drift-check"
```

正常日志会出现 `hook_start`、`user_prompt_context_captured`、`posttooluse_no_output`、`emit_subagent_checkpoint_enforcement` 或 `stop_allow_no_pending` 这类事件。

如果 `SDD drift question checkpoint` 刚出现就遇到上下文压缩，`PreCompact` 会把这个未完成检查写入压缩上下文。恢复后模型应先继续 SDD 审查/同步，再处理提交、继续任务或最终回复。

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

调整代码工具结果提醒次数。默认每个会话最多 1 次弱提醒，后续代码改动只记录状态，等 `Stop` / 提问 / 压缩前这类阶段检查点再统一触发 SDD 审查：

```powershell
$env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = "1"
$env:SDD_DRIFT_CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS = "1"
opencode
```

如果你想完全不在代码工具结果里提醒，把任意一个值设成 `0`。如果你想恢复更频繁的旧体验，可以把 session 上限调大。`design.md` / `tasks.md` 互相同步仍然会即时提醒。

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
