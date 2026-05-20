# Claude Code SDD Drift E2E

This is a Claude Code companion harness for `test/opencode-sdd-drift-e2e`.
It validates the same scenarios against the same hook implementation:

- `design-cascade`: edit `design.md`, then hook feedback should lead the model
  to synchronize `tasks.md`.
- `code-cascade`: edit one code file, then review `design.md` and `tasks.md`
  and synchronize the SDD docs that actually need changes.
- `multi-code-cascade`: edit multiple code files in one task, emit a full
  deferred review reminder followed by compact reminders, then synchronize SDD
  docs at the checkpoint.

## Configure Providers

Both provider templates use each vendor's Anthropic-compatible endpoint.
Only the API key should be filled locally.

DeepSeek:

```powershell
cd test\claude-code-sdd-drift-e2e
notepad .claude\providers\deepseek.local.ps1
```

Configured base URL: `https://api.deepseek.com/anthropic`.

Minimax:

```powershell
cd test\claude-code-sdd-drift-e2e
notepad .claude\providers\minimax.local.ps1
```

Configured China base URL: `https://api.minimaxi.com/anthropic`.
For the international endpoint, change it to `https://api.minimax.io/anthropic`.

The `.local.ps1` files are ignored by git.

## Run

```powershell
cd test\claude-code-sdd-drift-e2e
npm run e2e:real -- -Provider deepseek -Scenario multi-code-cascade
npm run e2e:real -- -Provider minimax -Scenario multi-code-cascade
```

Use DeepSeek V4 Flash explicitly:

```powershell
npm run e2e:real -- -Provider deepseek -Scenario multi-code-cascade -ModelOverride deepseek-v4-flash
```

The script uses Claude Code print mode with project settings only:

```powershell
claude --print --output-format stream-json --include-hook-events --setting-sources project
```

The checked-in `.claude/settings.json` enables `UserPromptSubmit`, `PostToolUse`,
and `Stop`. `UserPromptSubmit` lets the hook persist issue-ticket context before
later tool events. `PostToolUse` uses an explicit matcher for file tools and
subagent result checkpoints, avoiding the broad `matcher: "*"` shape that can
make OpenCode/oh-my-opencode run the hook for unrelated tools. For Claude Code,
`PostToolUse` returns
`additionalContext`, and `Stop` returns `{"decision":"block","reason":"..."}`
when synchronization or review is still missing.
