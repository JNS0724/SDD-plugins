# SDD Drift Check - oh-my-opencode hook

这个实现用于在 OpenCode 的 SDD 流程中检查文档漂移：当本轮会话改了
`sdd/changes/<id>/design.md` 却没有同步同目录 `tasks.md` 时，把约束追加到
OpenCode 的 tool result 中，让下一次模型调用能直接看到并继续读写 peer 文档。

当前推荐安装方式是使用 `oh-my-opencode@3.17.2` 的 Claude-compatible hook 机制。
本插件不使用 `console.error`，不依赖 `messages.transform`，不调用 `session.prompt`，
也不通过抛错制造红字。

## 行为

| 场景 | 结果 |
| --- | --- |
| 改了 `design.md`，没改 `tasks.md` | `PostToolUse` hook 在本次 tool output 后追加 `SDD drift tool result enforcement`，要求先 read + edit/write `tasks.md` |
| 改了 `tasks.md`，没改 `design.md` | 同样注入 peer 同步约束 |
| peer 文件已同步 | 不再注入约束，并清理 `.sdd-drift-report.md` |
| 模型忽略约束并结束 | `.sdd-drift-report.md` 记录未同步缺口，供人工排查 |
| 普通代码变更 | 不触发 design/tasks 级联约束；默认不在 UI 输出警告 |

报告文件会在 `PostToolUse` 后即时刷新，`Stop` hook 只做补充清理。这样可以兼容
`opencode run` 在 `session.idle` 后快速退出、Stop hook 不一定有足够时间完成的情况。

## 安装到业务项目

下面假设你要在某个业务项目根目录安装，hook 脚本会放在该项目的
`.opencode/hooks/sdd-drift-check-hook.cjs`。

### 1. 安装 oh-my-opencode

在业务项目根目录执行：

```powershell
npm install --save-dev oh-my-opencode@3.17.2
```

### 2. 复制 hook 脚本

如果你从本仓库复制到另一个业务项目：

```powershell
New-Item -ItemType Directory -Force .opencode\hooks
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.cjs .opencode\hooks\sdd-drift-check-hook.cjs
```

如果当前项目本身就是这个仓库，也可以直接引用
`plugins\sdd-drift-check\sdd-drift-check-hook.cjs`，但更推荐复制到目标项目的
`.opencode/hooks/`，这样 hook 配置不依赖外部目录。

### 3. 加载 oh-my-opencode 插件

创建 `.opencode/plugin/oh-my-opencode.ts`：

```powershell
New-Item -ItemType Directory -Force .opencode\plugin
Set-Content .opencode\plugin\oh-my-opencode.ts 'export { default } from "oh-my-opencode"'
```

文件内容应为：

```ts
export { default } from "oh-my-opencode"
```

### 4. 配置 oh-my-openagent

`oh-my-opencode@3.17.2` 的 npm 包名仍是 `oh-my-opencode`，但 canonical 配置文件名是
`.opencode/oh-my-openagent.jsonc`。

创建 `.opencode/oh-my-openagent.jsonc`：

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

如果你只想启用 Claude-compatible hooks，尽量减少 oh-my 其它内置能力干扰，可以直接参考
`test/opencode-sdd-drift-e2e/.opencode/oh-my-openagent.jsonc`，它禁用了大部分内置 hook。

### 5. 配置 Claude-compatible hooks

创建 `.claude/settings.json`：

```powershell
New-Item -ItemType Directory -Force .claude
```

写入下面内容：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check-hook.cjs"
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
            "command": "node .opencode/hooks/sdd-drift-check-hook.cjs"
          }
        ]
      }
    ]
  }
}
```

注意：`command` 是相对业务项目根目录执行的。如果你没有把脚本复制到
`.opencode/hooks/`，就把这里改成你的实际脚本路径。

### 6. 忽略运行产物

把这些加入业务项目 `.gitignore`：

```gitignore
.sdd-drift-report.md
.sdd-drift-hook-state/
.opencode/*.tmp
```

## 本仓库测试工程

本仓库的端到端测试工程在 `test/opencode-sdd-drift-e2e`。它为了复用仓库里的源码，
`.claude/settings.json` 里使用的是：

```json
"command": "node ../../plugins/sdd-drift-check/sdd-drift-check-hook.cjs"
```

这是测试工程相对仓库结构的路径。业务项目安装时不要照抄这个相对路径，优先使用：

```json
"command": "node .opencode/hooks/sdd-drift-check-hook.cjs"
```

## 验证

安装完成后，在 OpenCode 里让模型修改：

```text
sdd/changes/<change-id>/design.md
```

但先不要同步同目录 `tasks.md`。预期现象：

- `design.md` 的 `write` / `edit` tool result 中会追加 `SDD drift tool result enforcement`。
- 下一次模型请求会带着这段 tool message，模型应继续 read + edit/write `tasks.md`。
- 同步成功后 `.sdd-drift-report.md` 不存在或被清理。
- 如果模型忽略约束并结束，`.sdd-drift-report.md` 会记录缺口。
- 默认不会有 `console.error` 红字提示。

也可以运行本仓库 fake provider e2e：

```powershell
cd test\opencode-sdd-drift-e2e
npm install
npm run e2e -- -Scenario sdd-design
npm run e2e -- -Scenario sdd-cascade
npm run e2e -- -Scenario code
```

Windows 沙箱环境下，oh-my hook 会通过 `cmd.exe` 启动命令，端到端测试可能需要提升权限；
正常 OpenCode 使用不需要额外处理。

## 原理

`oh-my-opencode` 会读取 `.claude/settings.json`，把 `PostToolUse` 映射到 OpenCode 的
`tool.execute.after`。hook 脚本从 stdin 读取 Claude hook JSON，记录本 session 改过的
SDD 文件，并在存在 peer 缺口时向 stdout 写入约束文本。

在 `oh-my-opencode@3.17.2` 中，`PostToolUse` command 的 stdout 会被追加进 OpenCode
tool output。模型下一步请求会带着上一条 tool message，因此能看到这段约束并继续修改
`tasks.md`。这比依赖 `session.prompt` 或 `messages.transform` 更兼容。

## 调试开关

默认完全静默：不写 stderr，不显示红字，不追加旧的 `SDD DRIFT:` 人类可见提示。

如需调试非 peer 类 drift，可以在启动 OpenCode 前设置：

```powershell
$env:SDD_DRIFT_SHOW_WARNINGS = "1"
opencode
```

## 边界

- 只识别 OpenCode 的 `Edit` / `Write` 文件工具。通过 shell 重定向改文件不会触发。
- 只内置 `design.md` 和 `tasks.md` 的 peer 关系。
- 不代发用户消息，不强制阻断模型停止；稳定性来自 tool result 注入。
- 如果未来 OpenCode 提供真正的 Stop continuation 或 tool output injection API，可以把
  当前 stdout 注入替换成官方机制。
