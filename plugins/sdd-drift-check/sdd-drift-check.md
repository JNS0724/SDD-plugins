# SDD Drift Check - OpenCode and Claude Code hook

## Current behavior note

When an OpenCode `Write` / `Edit` tool changes a normal code file and the current
session has not synchronized any `sdd/changes/**/design.md` after that code
change, the hook now appends a model-visible `SDD drift tool result enforcement`
to the tool result. The model is instructed to read and update the relevant
`design.md` before giving a final answer. Once `design.md` is updated, the
existing peer rule still applies: `design.md` then requires the same change
directory's `tasks.md` to be synchronized.

The same hook entrypoint also supports Claude Code. When the hook input contains
`hook_source: "opencode-plugin"` it emits plain stdout so `oh-my-opencode` can
append the text to the OpenCode tool result. When that marker is absent, it emits
Claude Code structured JSON:
`{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`.
This lets Claude Code inject the enforcement as model-visible context next to the
tool result without using `stderr` / `exit 2`. Set `SDD_DRIFT_OUTPUT=opencode` or
`SDD_DRIFT_OUTPUT=claude` only if a wrapper needs an explicit override.

这个插件用于在 OpenCode 的 SDD 工作流中检查文档漂移。当前推荐方式是安装
`oh-my-opencode@3.17.2`，通过 Claude-compatible `PostToolUse` hook 把约束追加到
OpenCode tool result 中，让下一次模型请求能看到并继续同步 peer 文档。

插件默认不使用 `console.error`、不依赖 `messages.transform`、不调用 `session.prompt`，也不通过抛错制造红字。

## 行为

| 场景 | 结果 |
| --- | --- |
| 改了 `design.md`，但还没改同目录 `tasks.md` | `PostToolUse` 在本次 tool output 后追加 `SDD drift tool result enforcement`，要求先 read + edit/write `tasks.md` |
| 改了 `tasks.md`，但还没改同目录 `design.md` | 同样追加 peer 同步约束 |
| 改了 `proposal.md` | 要求后续同步同目录 `design.md` 和 `tasks.md` |
| peer 文件不存在 | 仍会作为缺失 peer 提示模型创建并同步 |
| peer 已在当前 session 后续同步 | 清除缺口，不再反向制造新的同步要求 |
| 模型忽略约束并结束 | `.sdd-drift-report.md` 记录未同步缺口，供人工排查 |
| 普通代码变更 | 不触发 design/tasks 级联约束；默认也不在 UI 输出警告 |

状态文件优先写入最近 Git 仓库的 `.git/sdd-drift-hook-state/`，避免污染项目根目录。
`.sdd-drift-report.md` 仍写在当前项目根目录，因为它是给人看的排查报告。

## 安装到业务项目

下面假设你在业务项目根目录安装，并把 hook 脚本复制到该项目的
`.opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js`。

### 1. 安装 oh-my-opencode

```powershell
npm install --save-dev oh-my-opencode@3.17.2
```

### 2. 复制 hook 脚本

```powershell
New-Item -ItemType Directory -Force .opencode\hooks\sdd-drift-check
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\package.json .opencode\hooks\sdd-drift-check\package.json
```

### 3. 加载 oh-my-opencode 插件

创建 `.opencode/plugin/oh-my-opencode.ts`：

```powershell
New-Item -ItemType Directory -Force .opencode\plugin
Set-Content .opencode\plugin\oh-my-opencode.ts 'export { default } from "oh-my-opencode"'
```

文件内容：

```ts
export { default } from "oh-my-opencode"
```

### 4. 配置 oh-my-openagent

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

如果只想启用 Claude-compatible hooks，可以参考
`test/opencode-sdd-drift-e2e/.opencode/oh-my-openagent.jsonc`，它禁用了大部分 oh-my 内置 hook。

### 5. 配置 Claude-compatible hooks

创建 `.claude/settings.json`：

```powershell
New-Item -ItemType Directory -Force .claude
```

写入：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
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

`command` 相对业务项目根目录执行。业务项目安装时优先使用
`node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js`，不要照抄本仓库测试工程里的相对路径。

### 6. 忽略运行产物

建议加入业务项目 `.gitignore`：

```gitignore
.sdd-drift-report.md
.sdd-drift-hook-state/
.opencode/*.tmp
```

如果项目在 Git 仓库内，状态默认会进入 `.git/sdd-drift-hook-state/`，不会出现在 `git status`。
上面的 `.sdd-drift-hook-state/` 是给非 Git 目录或旧版本状态目录兜底。

## 本仓库测试

测试工程在 `test/opencode-sdd-drift-e2e`。它为了复用本仓库源码，`.claude/settings.json`
中的 command 是：

```json
"command": "node ../../plugins/sdd-drift-check/sdd-drift-check-hook.js"
```

运行：

```powershell
cd test\opencode-sdd-drift-e2e
npm install
npm test
npm run e2e -- -Scenario sdd-design
npm run e2e -- -Scenario sdd-cascade
npm run e2e -- -Scenario code
```

## 原理

`oh-my-opencode@3.17.2` 会读取 `.claude/settings.json`，把 `PostToolUse` 映射到
OpenCode 的 `tool.execute.after`。hook 的 stdout 会被追加回 OpenCode tool output；
模型下一步请求会带着上一条 tool message，因此能看到 `SDD drift tool result enforcement`
并继续修改缺失的 peer 文档。

本实现用 pending requirement 记录当前 session 内仍需同步的 peer 文件。比如 `design.md`
写完后会登记 `tasks.md` 缺口；当后续 `tasks.md` 被 edit/write 后，缺口被清除，不会再要求
回头改 `design.md`。

## 调试开关

默认静默：不写 stderr、不显示红字、不追加旧式 `SDD DRIFT:` 警告。

如需查看非 peer 类 drift 警告：

```powershell
$env:SDD_DRIFT_SHOW_WARNINGS = "1"
opencode
```

如需模拟 Claude Code 式硬阻断，可显式开启严格模式。它会使用 stderr + exit 2，可能在 UI 中出现 warning：

```powershell
$env:SDD_DRIFT_STRICT = "1"
opencode
```

hook 自身异常默认不打断 agent。如需排查 hook bug：

```powershell
$env:SDD_DRIFT_DEBUG = "1"
opencode
```

## 边界

- 只识别 OpenCode 的 `Edit` / `Write` 文件工具；通过 shell 重定向改文件不会触发。
- 内置 peer 关系是 `proposal.md -> design.md + tasks.md`、`design.md -> tasks.md`、`tasks.md -> design.md`。
- 不代发用户消息，不强制阻断模型停止；稳定性来自 tool result 注入。
- 如果未来 OpenCode 提供真正的 Stop continuation 或 tool output injection API，可以替换为官方机制。
