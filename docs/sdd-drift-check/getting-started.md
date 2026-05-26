# sdd-drift-check 插件入门

`sdd-drift-check` 用来提醒 AI agent：代码变了，活跃的 SDD 文档可能也要同步。

它不会替你判断一切，也不会把文档自动写成完美状态。它做的是在合适的 checkpoint 把模型拉回来：先 review `design.md` / `tasks.md`，该改就改，不该改就说明原因。

本文面向已经会使用 OpenCode 或 Claude Code 的用户。

## 适用运行环境

支持两种主路径：

| 运行环境 | 使用文件 | 推荐场景 |
| --- | --- | --- |
| OpenCode | `sdd-drift-check-opencode.js` + `sdd-drift-check-hook.js` | OpenCode 原生插件方式，推荐给 OpenCode 用户 |
| Claude Code | `sdd-drift-check-hook.js` | Claude Code command hook |

OpenCode 用户请使用原生插件入口；Claude Code 用户请使用 command hook 入口。

## 前置条件

- 本机能运行 `node`。
- 项目里有 `sdd/` 或 `.sdd/` 目录。
- SDD change 目录采用下面这种结构：

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

如果项目没有 `sdd/` 或 `.sdd/`，插件会静默退出，不写状态、不提醒模型。

## OpenCode 安装

在你的项目根目录执行：

```powershell
New-Item -ItemType Directory -Force .opencode\plugins
New-Item -ItemType Directory -Force .opencode\hooks\sdd-drift-check

Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-opencode.js .opencode\plugins\sdd-drift-check-opencode.js
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js
```

OpenCode 会自动加载 `.opencode/plugins/` 下的本地插件。原生插件会调用共享 hook：

```text
.opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js
```

如果你想把 hook 放到其他位置，启动 OpenCode 前设置：

```powershell
$env:SDD_DRIFT_HOOK_SCRIPT = "E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js"
opencode
```

如果 `node` 不在 `PATH`：

```powershell
$env:SDD_DRIFT_NODE = "C:\Program Files\nodejs\node.exe"
opencode
```

## Claude Code 安装

在你的项目根目录执行：

```powershell
New-Item -ItemType Directory -Force .claude\hooks\sdd-drift-check
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .claude\hooks\sdd-drift-check\sdd-drift-check-hook.js
```

创建或更新 `.claude/settings.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/sdd-drift-check/sdd-drift-check-hook.js"
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
            "command": "node .claude/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit|NotebookEdit|Task|read|edit|write|multiedit|multi_edit|task",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/sdd-drift-check/sdd-drift-check-hook.js"
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
            "command": "node .claude/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ]
  }
}
```

如果只想做最终兜底，可以只配置 `UserPromptSubmit`、`PreCompact` 和 `Stop`。更推荐上面的完整配置，因为它能在文件变更后更早记录状态。

## 插件会检查什么

| 场景 | 行为 |
| --- | --- |
| 改了 `design.md`，同目录 `tasks.md` 已存在但未同步 | 提醒同步 `tasks.md` |
| 改了 `tasks.md`，同目录 `design.md` 已存在但未同步 | 提醒同步 `design.md` |
| 改了 `proposal.md` | 只在 `design.md` 已存在时给软提醒 |
| `tasks.md` 还不存在 | 认为仍在设计阶段，不强迫创建 |
| 改了普通代码 | 记录代码变更，并在阶段末提醒 review 活跃 `design.md` / `tasks.md` |
| 多个 change 同时存在 | 检查所有未归档的活跃 change |
| 模型判断无需改文档 | 允许结束，并写 `.sdd-drift-report.md` 让人确认 |
| DTS / 问题单修改 | 可跳过代码领先文档提醒 |
| 已归档 change | 跳过 |

核心原则：

> 归档前，活跃 SDD 应该和代码事实对齐。

代码如果改变了行为、接口、错误处理、性能策略、数据结构、状态流或用户可见结果，`design.md` 通常要更新。任务完成、取消、拆分或失效时，`tasks.md` 通常要更新。

纯格式化、注释、测试脚手架这类无设计影响的改动，可以不更新文档，但模型应该先 review SDD。

## 使用后会看到什么

大多数时候它应该是安静的。

| 使用场景 | 你可能看到的现象 | 是否正常 |
| --- | --- | --- |
| 项目没有 `sdd/` 或 `.sdd/` | 没有提醒 | 正常 |
| 新会话有历史 drift | 模型开局可能收到 carry-over 提醒 | 正常 |
| 模型改普通代码 | 可能出现一次 `SDD drift code review noted` | 正常，这是弱提醒 |
| 模型连续改多个代码文件 | 后续通常静默记录，阶段末统一 review | 正常 |
| 模型改 `design.md` | 如果 `tasks.md` 已存在，会提醒同步 `tasks.md` | 正常 |
| 模型改 `tasks.md` | 如果 `design.md` 已存在，会提醒同步 `design.md` | 正常 |
| 模型准备问“要不要提交/继续” | 可能出现 `SDD drift question checkpoint` | 通常正常，插件在让模型先完成 SDD review |
| 上下文压缩 | pending SDD 状态会写入压缩摘要 | 正常 |
| 模型认为无需改文档 | 可以结束，可能留下 `.sdd-drift-report.md` | 正常，需要用户最终确认 |

模型看到的提示词会长这样：

```text
<system-reminder>
[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - CODE REVIEW CHECKPOINT]

STATE
...

REQUIRED ACTION
...
</system-reminder>
```

这不是隐藏系统消息，而是通过 hook/tool 结果传给模型的可见提醒。模型完成 SDD review 或同步后，应回到原始任务继续工作，而不是把 SDD 审查当成最终任务。

## 快速验证

准备一个最小 SDD change：

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

然后让 agent 执行：

```text
把 src/app.ts 里的 greet 改成返回带感叹号的热情问候语。完成后检查 sdd/changes/demo/design.md 和 tasks.md 是否需要同步。
```

预期：

- agent 修改代码。
- agent review `design.md` / `tasks.md`。
- 如果文档落后，agent 更新对应 SDD 文档。
- 如果无需更新，agent 说明 review 了哪些文件以及为什么无需改。

## 日志和状态

默认状态和日志位置：

```text
<nearest .git>/sdd-drift-hook-state/
```

常用检查命令：

```powershell
Get-ChildItem -Force .git\sdd-drift-hook-state
Get-Content .git\sdd-drift-hook-state\sdd-drift-check.log.jsonl -Tail 40
```

如果项目不是 Git 仓库，再看：

```powershell
Get-ChildItem -Force .sdd-drift-hook-state
Get-ChildItem -Force "$env:TEMP\sdd-drift-check"
```

常见正常事件：

```text
hook_start
posttooluse_no_output
emit_code_tool_reminder
emit_peer_enforcement
emit_question_checkpoint_enforcement
precompact_summary_emit
stop_allow_no_pending
```

如果没有任何新日志，通常是插件没有被加载，或 command hook 路径写错了。

## 建议忽略文件

加入 `.gitignore`：

```gitignore
.sdd-drift-report.md
.sdd-drift-hook-state/
.opencode/*.tmp
```

`.sdd-drift-report.md` 留在项目根目录，是为了让人能看到待确认项；如果你希望提交前保持干净，可以把它加入 ignore。

## 常用开关

关闭诊断日志：

```powershell
$env:SDD_DRIFT_LOG = "0"
```

指定日志路径：

```powershell
$env:SDD_DRIFT_LOG_PATH = "E:\tmp\sdd-drift-check.log.jsonl"
```

调整日志保留天数，默认 3 天：

```powershell
$env:SDD_DRIFT_LOG_RETENTION_DAYS = "7"
```

显式声明本轮是 DTS / 问题单修复，跳过代码领先文档提醒：

```powershell
$env:SDD_DRIFT_DTS_CONTEXT = "1"
```

禁用 DTS 例外：

```powershell
$env:SDD_DRIFT_DTS_SKIP = "0"
```

控制代码工具结果里的弱提醒次数。默认每个会话最多一次，后续代码改动只记录状态，等 Stop / 提问 / 压缩前统一 review：

```powershell
$env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = "1"
$env:SDD_DRIFT_CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS = "1"
```

## 归档规则

这些 change 会被视为已归档并跳过：

- 目录名是 `archive`、`archives`、`archived`、`.archive`、`.archived`、`已归档`
- 目录名带 `archived` / `已归档`
- 包含 `.archived`、`.archive`、`ARCHIVED`、`archived.md`、`archive.md`、`已归档.md`
- `status.md` / `state.md` 等小状态文件里写了 `status: archived` 或 `状态: 已归档`

## 边界

- 只追踪 OpenCode / Claude Code 可见的工具事件。
- shell 重定向写文件可能不可见，建议让 agent 用文件工具改 SDD。
- OpenCode 的 Stop continuation 是 best effort；OpenCode 可靠路径主要是工具结果提醒和 question checkpoint。
- 最终以文件状态为准，不只看模型最后说“已同步”。

## 推荐工作流

1. 先写 `proposal.md`。
2. 多轮评审 `design.md`。
3. 设计定稿后生成 `tasks.md`。
4. 实现代码。
5. 让插件提醒 agent review / 同步活跃 SDD。
6. 完成后归档 change，避免后续继续检查。

一句话总结：这个插件不是文档魔法棒，但能显著降低“代码已经变了，SDD 还停在上周五下午”的概率。
