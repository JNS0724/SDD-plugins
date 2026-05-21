# 用 OpenCode + OMO 驯服 SDD 文档漂移：sdd-drift-check 入门

你已经会用 OpenCode，也已经装过 OMO。很好，我们可以跳过“什么是 AI 编码助手”这种开场白，直接进入今天的主角：

`sdd-drift-check`，一个专门盯着 SDD 文档别掉队的 hook 插件。

它解决的问题很朴素：模型改着改着代码，`design.md` 和 `tasks.md` 就像会议纪要一样安静地过期了。等你回头看，代码已经跑到山那边，文档还在山脚下说“我们准备出发”。这时候再补文档，很容易变成考古。

`sdd-drift-check` 做的事就是在 OpenCode + OMO 的工具调用过程中提醒模型：

> 朋友，代码动了，先别急着收工。去看看 SDD 文档是不是也该同步。

它不是一个神秘的“文档自动生成器”，也不是一个把模型绑在椅子上的强阻断系统。它更像一个坐在旁边的工程 PM：平时不说话，一旦代码和文档开始分手，就轻轻敲桌子。

## 适用场景

这个插件适合你已经在使用类似这样的 SDD 目录结构：

```text
sdd/
  changes/
    my-feature/
      proposal.md
      design.md
      tasks.md
```

或者：

```text
.sdd/
  changes/
    my-feature/
      proposal.md
      design.md
      tasks.md
```

它关注的是 `sdd/changes/*` 或 `.sdd/changes/*` 下的变更文档，以及实现代码和这些文档之间的漂移。

如果你的项目根本没有 `sdd/` 或 `.sdd/` 目录，它会直接静默退出。没有 SDD，就不硬演 SDD。这个品德值得表扬。

## 它会检查什么

先看行为地图。

| 场景 | 插件行为 |
| --- | --- |
| 修改了 `design.md`，同目录 `tasks.md` 已存在但本轮没同步 | 提醒模型同步 `tasks.md` |
| 修改了 `tasks.md`，同目录 `design.md` 已存在但本轮没同步 | 提醒模型同步 `design.md` |
| 修改了 `proposal.md` | 如果 `design.md` 已存在，给软提醒；不会强迫创建 `design.md` 或 `tasks.md` |
| `design.md` 存在但 `tasks.md` 不存在 | 认为还在设计阶段，不强迫创建任务文档 |
| 修改了普通代码 | 延迟提醒模型在最终回复前评审相关 `design.md` / `tasks.md` |
| 一轮里改了很多代码文件 | 聚合成一个代码批次，不为每个文件疯狂刷屏 |
| 模型评审后认为 SDD 不需要改 | 允许结束，并留下 `.sdd-drift-report.md` 给人确认 |
| DTS / 问题单修复 | 可以跳过代码领先文档提醒 |
| 已归档 change 目录 | 跳过，不翻旧账 |

这套规则的核心不是“任何代码变更都必须改文档”，而是：

> 活跃 SDD 文档在归档前应该和代码事实对齐。

也就是说，如果代码改了行为、接口、错误处理、性能策略、状态流、数据结构、用户可见结果，`design.md` 大概率不能装作没看见；如果任务完成、变更、取消、拆分或失效，`tasks.md` 也该跟上。

但如果只是格式化、注释、纯测试脚手架、无设计影响的配置调整，就可以不改。插件会让模型说明它评审了哪些 SDD 文件，为什么不需要同步。你再决定信不信它。AI 说“我检查过了”不等于宇宙真理，这一点我们已经在真实模型测试里感受过了。

## 推荐模式：OpenCode + OMO 用 PostToolUse + Stop

在 OpenCode + OMO 里，建议启用：

- `UserPromptSubmit`：捕获用户原始意图，方便识别“这是问题单修复，不需要 SDD”。
- `PostToolUse`：工具调用后把提醒写回模型可见的工具结果里，OpenCode 场景最可靠。
- `Stop`：模型准备结束时做最后检查，兼容 Claude Code 风格，也给未来 OpenCode hook 行为留余地。

简单说：`PostToolUse` 是日常值班，`Stop` 是门口保安。

当前 OpenCode + OMO 下，不建议只依赖 Stop。实际验证里，Stop-only 在 OpenCode `opencode run` 场景下不稳定，模型可能已经结束了，提示词才慢悠悠地在门外敲门。你当然可以保留 Stop，但真正要让模型在当轮继续处理 SDD，`PostToolUse` 更稳。

## 安装到你的项目

以下假设你已经会使用 OpenCode 和 OMO，并且项目里已经有 `.opencode/` 配置目录。

### 1. 安装 OMO 依赖

如果项目还没有本地 OMO 依赖：

```powershell
npm install --save-dev oh-my-opencode@3.17.2
```

如果你已经有了，可以跳过。不要为了仪式感重复安装，npm 也会累。

### 2. 复制 hook 脚本

把本仓库里的共享 hook 脚本复制到目标项目：

```powershell
New-Item -ItemType Directory -Force .opencode\hooks\sdd-drift-check
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js
```

如果你的插件仓库不在 `E:\tool\MySkills\MySkills`，把源路径换成你自己的路径。

### 3. 确认 OMO 插件入口

创建或确认 `.opencode/plugin/oh-my-opencode.ts`：

```powershell
New-Item -ItemType Directory -Force .opencode\plugin
Set-Content .opencode\plugin\oh-my-opencode.ts 'export { default } from "oh-my-opencode"'
```

### 4. 打开 OMO 的 Claude hook bridge

创建或修改 `.opencode/oh-my-openagent.jsonc`：

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

重点是：

```jsonc
"hooks": true
```

没有它，后面的 `.claude/settings.json` 写得再漂亮，也可能只是给自己写了一封情书。

### 5. 配置 `.claude/settings.json`

推荐 OpenCode + OMO 使用这个版本：

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

这里的 `PostToolUse.matcher` 不建议写成 `*`。
原因很简单：所有工具都触发 hook，长期会变吵，也可能放大 OMO/Bun 在长会话里的不稳定。我们只关心文件读写和 subagent 结果回收，所以 matcher 里放这些就够了：

- `Read` / `Edit` / `Write` / `MultiEdit`
- `Task` / `task`
- `call_omo_agent`
- `background_output`
- `delegate_task`

也就是说：它要么记录“模型读写了什么文件”，要么在 subagent 返回后补一次 SDD 检查。别的工具就别让它出来加戏。

## 建议加到 `.gitignore`

```gitignore
.sdd-drift-report.md
.sdd-drift-hook-state/
.opencode/*.tmp
```

正常情况下，插件状态会优先写到最近的：

```text
.git/sdd-drift-hook-state/
```

这样不会污染工作区。
但 `.sdd-drift-report.md` 是特意放在项目根目录的，因为它是给人看的，不是给机器藏起来的。

## 第一次验证

准备一个最小 SDD 目录：

```text
sdd/
  changes/
    demo-feature/
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

然后让 OpenCode 做一个小改动：

```text
把 src/app.ts 里的 greet 改成返回带感叹号的热情问候语。完成后检查 sdd/changes/demo-feature/design.md 和 tasks.md 是否需要同步。
```

如果插件生效，你应该看到模型在修改代码后继续读取 SDD 文档，并更新 `design.md` / `tasks.md`，或者明确说明为什么不需要更新。

如果它改完代码就结束，而且完全没读 SDD，先别急着怀疑人生。看下一节。

## 怎么判断插件有没有触发

插件默认会写诊断日志：

```text
<nearest .git>/sdd-drift-hook-state/sdd-drift-check.log.jsonl
```

如果找不到 `.git`，会退到：

```text
<cwd>/.sdd-drift-hook-state/
```

或者：

```text
%TEMP%/sdd-drift-check/
```

日志里会记录：

- hook 是否启动。
- 收到了什么 hook 事件。
- 是否忽略了某个事件。
- 是否发出了 SDD 提醒。
- Stop 是否允许结束。
- 模型评审后“不需要改文档”的确认标记。

如果你使用 OpenCode 时日志完全没有新增，大概率不是模型没听话，而是 hook 根本没被调用。此时优先检查：

1. `.opencode/oh-my-openagent.jsonc` 里 `claude_code.hooks` 是否为 `true`。
2. `.claude/settings.json` 路径和 JSON 是否正确。
3. hook 脚本路径是否存在。
4. `node` 是否在 `PATH`。
5. 你是不是在正确项目目录里启动的 `opencode`。

最后一条听起来很傻，但它在真实世界里含金量很高。

## DTS / 问题单修复怎么处理

有些工作只是问题单修复，比如：

```text
修复 DTS-12345，调整边界条件，代码改完即可，不需要更新 SDD。
```

这种情况下，插件可以跳过“代码领先文档”提醒。
但在 OpenCode + OMO 的 `PostToolUse` 场景里，hook 能拿到的上下文可能有限，问题单识别是 best effort。

如果你希望稳定跳过，可以在启动前设置：

```powershell
$env:SDD_DRIFT_DTS_CONTEXT = "1"
opencode
```

如果你想完全禁用这个例外：

```powershell
$env:SDD_DRIFT_DTS_SKIP = "0"
opencode
```

注意：这个例外只跳过“代码改了但文档没评审”的提醒。
如果模型明确改了 `design.md` 或 `tasks.md`，peer 同步规则仍然会生效。

## 如果模型说“不需要改文档”

这是一个重要场景。

插件不会把“代码变更后必须修改 SDD”写死，因为现实里确实有些变更不影响 SDD，比如格式化、无行为变化的重命名、测试脚手架等。

当模型读完 `design.md` / `tasks.md` 后判断不需要修改，插件允许会话结束，并写一个 `.sdd-drift-report.md`，提示你人工确认。

这个设计是故意的：
模型可以提出判断，但最终确认权在人。我们不想让插件进入“我提醒你、你说不用、我继续提醒你、你继续说不用”的循环。那不是工程自动化，那是桌面版复读机。

## 多个 change 同时存在怎么办

插件会检查根目录下活跃的：

```text
sdd/changes/*/design.md
sdd/changes/*/tasks.md
.sdd/changes/*/design.md
.sdd/changes/*/tasks.md
```

如果有多个正在进行的方案，它会要求模型评审这些活跃方案，而不是只盯当前刚碰到的一个目录。

已归档的目录会跳过。以下情况会被认为是归档：

- 目录名是 `archive` / `archives` / `archived` / `.archive` / `.archived` / `已归档`
- 目录名前后带 `archived`
- 目录里有 `.archived`、`.archive`、`ARCHIVED`、`archived.md`、`archive.md`、`已归档.md`
- 小型状态文件里写了 `status: archived` 或 `状态: 已归档`

插件的态度很明确：活跃方案要管，归档方案别打扰。过去的事情就让它过去，除非你想开复盘会。

## 和 subagent 一起用

如果你的 OMO 工作流会调用 subagent 做分析，记得 matcher 里保留：

```text
Task|task|call_omo_agent|background_output|delegate_task
```

原因是：subagent 分析完之后，主 agent 需要重新看到 SDD 检查提醒。否则可能出现这种情况：

1. 主 agent 改了代码。
2. 主 agent 叫 subagent 分析。
3. subagent 回来了。
4. 主 agent 继续总结。
5. SDD 文档没人管。

这不是 subagent 的错。它只是下班了，主 agent 忘了收作业。

## 常用调试开关

关闭诊断日志：

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

调整同一个代码批次的工具结果提醒次数，默认 1 次：

```powershell
$env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = "2"
opencode
```

如果你担心重复提醒或限流，保持默认 `1` 更稳。
如果你担心长上下文里提醒被压缩丢失，可以临时改成 `2`。
别一上来改成 `99`，那不是增强可靠性，是给模型开广播站。

如果 `node` 不在 PATH：

```powershell
$env:SDD_DRIFT_NODE = "C:\Program Files\nodejs\node.exe"
opencode
```

## 边界和注意事项

这个插件只看 OpenCode / Claude 风格工具事件。
如果模型用 shell 重定向写文件，比如：

```bash
echo xxx > sdd/changes/demo/tasks.md
```

hook 可能看不到这是一次文件编辑。建议让模型用文件工具读写 SDD 文档。

另外，插件是软约束，不是绝对执法。尤其在 OpenCode + OMO 里，最可靠的是 `PostToolUse` 工具结果提醒；Stop-only 不要当成唯一保障。

最终验收时，不要只看模型最后说“已同步”。请看文件：

- `design.md` 是否真的去掉了过时事实。
- `tasks.md` 是否真的更新了对应任务。
- `.sdd-drift-report.md` 是否存在。
- 诊断日志是否显示 hook 被调用。

模型嘴很甜，文件才诚实。

## 推荐使用姿势

我建议你把 SDD 工作流拆成这样：

1. `proposal.md`：描述要做什么，先别急着出任务。
2. `design.md`：多轮评审、修改、定稿。
3. `tasks.md`：设计定稿后再生成任务。
4. 实现代码：模型改代码时，插件提醒它回看活跃 SDD。
5. 收尾：模型同步文档，或者说明无需同步并留下人工确认报告。
6. 归档：方案结束后标记 archive，避免后续继续被检查。

这个节奏有个好处：插件不会在你刚开始头脑风暴 `design.md` 时强迫你立刻生成 `tasks.md`。只有关联文件已经存在，它才开始做同步检查。它不会抢产品经理的活，也不会把“设计还没定”误判成“任务落后了”。

## 最后一口气总结

`sdd-drift-check` 的目标不是让模型多写文档，而是让模型别忘了文档是活的。

在 OpenCode + OMO 里，推荐启用 `UserPromptSubmit + PostToolUse + Stop`。
平时它安静记录；代码领先 SDD 时，它提醒模型评审；明确需要同步时，它要求模型补 `design.md` / `tasks.md`；模型判断不用改时，它留报告给人确认。

它不完美，但它很实用。尤其当你让模型连续开发一个需求时，它能把“代码已经变了，文档还在梦里”的概率压下去不少。

这就够值了。毕竟工程里最可怕的不是文档过期，而是所有人都以为它没过期。
