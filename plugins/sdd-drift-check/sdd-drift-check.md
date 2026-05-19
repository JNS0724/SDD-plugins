# SDD Drift Check

OpenCode / Claude Code compatible hook for SDD drift checks.

## Current Status

`PostToolUse` is now optional. The checked-in default config only enables
`Stop`, so the UI does not get tool-result enforcement text unless you opt in.

## Runtime Environment

This package has two entrypoints:

- `sdd-drift-check-hook.js`: Claude Code-compatible command hook. Use this with
  Claude Code or with OpenCode through `oh-my-opencode` hook bridging.
- `sdd-drift-check-opencode.js`: native OpenCode plugin adapter. Use this when
  you want OpenCode to load the plugin directly from `.opencode/plugins/`.

Both entrypoints share the same drift rules, state files, reports, and
diagnostic logs. The native OpenCode adapter listens to `chat.message`,
`tool.execute.after`, and `session.idle`. It captures user-message context for
issue-ticket detection, converts tool/idle events into the shared hook input
shape, and appends model-visible reminders to the tool result when drift is
detected.

Native OpenCode caveat: `session.idle` is an event, not a mutable Stop hook
response. The native adapter can refresh reports/logs at idle time, but current
OpenCode plugin hooks do not provide a direct Stop-continuation output channel.
For reliable continuation in OpenCode, keep `tool.execute.after` enabled.

Important OpenCode note: real testing with OpenCode 1.2.27 +
`oh-my-opencode@3.17.2` showed that `Stop`-only did not trigger continuation in
`opencode run`, even though the same transcript produced the correct block
prompt when the hook was invoked directly. For reliable OpenCode cascade today,
enable the optional `PostToolUse` hook below. Keep `Stop` enabled for
Claude-compatible behavior and future OpenCode support.

The hook does not use `console.error`, `messages.transform`, or
`session.prompt`. It is silent unless it has to return model-visible hook output.

## Behavior

| Scenario | Result |
| --- | --- |
| project has no `sdd/` or `.sdd/` directory | Hook exits without state, reports, or model-visible reminders |
| `design.md` changed but same-directory `tasks.md` not synced | Requires `tasks.md` sync |
| `tasks.md` changed but same-directory `design.md` not synced | Requires `design.md` sync |
| `proposal.md` changed | Emits a soft next-stage reminder only when `design.md` already exists; proposal-only turns may finish normally |
| peer file absent | Treats it as a later SDD stage and does not inject cascade synchronization |
| peer file exists but was not synced in this session | Reports it as unsynced and asks the model to read/update it |
| peer file synced later in the same session | Clears the gap and does not create a reverse ping-pong requirement |
| normal code changed without later SDD review | Emits deferred reminders to review relevant `design.md` and `tasks.md` before the final answer |
| many code files changed in one turn | Keeps accumulating changed files and emits bounded compact reminders until the latest code batch has reviewed `design.md` and `tasks.md` |
| DTS / issue-ticket context | Skips code-ahead-of-doc review reminders; issue context is inferred from hook-visible prompt/message/transcript text or forced with `SDD_DRIFT_DTS_CONTEXT=1` |
| code only affects task progress | Allows a tasks-only update, or no document edit, after both `design.md` and `tasks.md` have been reviewed |
| model ignores constraints and stops | Writes `.sdd-drift-report.md` for human review |

State is stored under the nearest `.git/sdd-drift-hook-state/` when possible, so
normal hook state does not pollute project status. `.sdd-drift-report.md` is kept
in the project root because it is meant to be visible.

State updates are serialized with a short-lived lock per session. This matters
when an agent emits parallel file writes: a `design.md` edit that asks for
`tasks.md` synchronization and the follow-up `tasks.md` edit must be merged into
one session state, otherwise one hook process can overwrite the other and create
design/tasks ping-pong reminders.

`proposal.md` is treated as a stage boundary. Editing it does not create
`design.md` by itself. If `design.md` already exists, the hook can softly remind
the model to review or update it before planning work, but it is not a
Stop-blocking gap and it does not require `tasks.md` directly. Once `design.md`
is actually edited, the normal `design.md -> tasks.md` synchronization rule
applies only if `tasks.md` already exists.

Missing peer documents are treated as future workflow stages rather than drift.
For example, a user can generate and manually refine `design.md` for several
turns while `tasks.md` does not exist, then later create `tasks.md` from the
approved design without the hook forcing an immediate reverse `tasks.md ->
design.md` edit. After both files exist, later edits again use the normal peer
sync rules.

The hook also tracks peer-sync responses inside the session. If `tasks.md` is
being edited to satisfy a pending `design.md -> tasks.md` requirement, immediate
follow-up edits to that same `tasks.md` are treated as part of the same sync
cycle rather than as a fresh `tasks.md -> design.md` requirement. A new source
document edit or a clean `Stop` starts the next cycle.

Peer drift output focuses on existing-but-unsynced files. This avoids telling the
model to create `tasks.md` just because `design.md` is still under review. The
first reminder for a peer gap is full; repeated reminders for the same pending
gap are compact so the signal survives long turns without flooding context.

If the hook cannot acquire the per-session state lock, it records
`state_lock_unavailable` in the diagnostic log and skips that hook event instead
of writing state without a lock. This favors avoiding corrupt session state over
trying to enforce from a stale snapshot.

For `Stop`, the hook can hydrate state from Claude Code-style transcript JSONL
by pairing assistant `tool_use` records with successful user `tool_result`
records. Failed tool results are ignored so an attempted but unsuccessful write
does not create a false drift requirement.
Transcript hydration is persisted per session, so repeated `Stop` events do not
replay the same historical tools and change the pending signature. Code-review
Stop reminders default to one block via `SDD_DRIFT_CODE_REVIEW_STOP_MAX_BLOCKS`
because code-ahead-of-doc review is a human-confirmable checkpoint, not a hard
peer-document synchronization requirement. Peer-document sync still uses
`SDD_DRIFT_STOP_MAX_BLOCKS` and defaults to two blocks.

The hook also writes a lightweight JSONL diagnostic log by default:

```text
<nearest .git>/sdd-drift-hook-state/sdd-drift-check.log.jsonl
```

If the hook is not using a Git state directory, the log follows the same fallback
as state: `<cwd>/.sdd-drift-hook-state/` first, then `%TEMP%/sdd-drift-check/`.
The log intentionally does not include file contents or API keys. It records hook
entry, ignored events, emitted enforcement, Stop blocks, review-confirmation
markers, and uncaught hook exceptions. If no new log line appears while you use
OpenCode or Claude Code, the hook probably was not invoked.

Logs are retained for the latest 3 days by default. Cleanup runs before each
diagnostic append and prunes old JSONL records from the active log plus same-name
numeric rotation files such as `sdd-drift-check.log.jsonl.1`.

## Install In A Project

### OpenCode Native Plugin

Copy both files: the native adapter goes under `.opencode/plugins/`, while the
shared command hook stays outside that directory so OpenCode does not try to load
it as a second plugin.

```powershell
New-Item -ItemType Directory -Force .opencode\plugins
New-Item -ItemType Directory -Force .opencode\hooks\sdd-drift-check
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-opencode.js .opencode\plugins\sdd-drift-check-opencode.js
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js
```

OpenCode automatically loads local plugins from `.opencode/plugins/`.
The adapter finds the shared hook at:

```text
.opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js
```

Override the path if needed:

```powershell
$env:SDD_DRIFT_HOOK_SCRIPT = "E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js"
opencode
```

The native adapter runs the shared hook with `node`. If `node` is not on `PATH`,
set:

```powershell
$env:SDD_DRIFT_NODE = "C:\Program Files\nodejs\node.exe"
opencode
```

### OpenCode With oh-my-opencode

Install `oh-my-opencode`:

```powershell
npm install --save-dev oh-my-opencode@3.17.2
```

Copy the hook:

```powershell
New-Item -ItemType Directory -Force .opencode\hooks\sdd-drift-check
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js
```

Create `.opencode/plugin/oh-my-opencode.ts`:

```powershell
New-Item -ItemType Directory -Force .opencode\plugin
Set-Content .opencode\plugin\oh-my-opencode.ts 'export { default } from "oh-my-opencode"'
```

Create `.opencode/oh-my-openagent.jsonc`:

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

### Claude Code Or Claude-Compatible Hook Config

Default Stop-only config, with no `PostToolUse`:

```powershell
New-Item -ItemType Directory -Force .claude
```

`.claude/settings.json`:

```json
{
  "hooks": {
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

Reliable OpenCode cascade mode, with optional `PostToolUse` enabled:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit",
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

The hook treats `Edit`, `Write`, and Claude Code's common `MultiEdit` tool as
edits. Add `Read` to the optional `PostToolUse` matcher so the hook can verify
that SDD review actually happened. It deduplicates repeated `PostToolUse` calls
by `tool_use_id`, so having a user-level and project-level hook config should
not create duplicate enforcement or design/tasks ping-pong.

Code-ahead-of-doc drift is batched at session level. The first code edit that
gets ahead of SDD emits a full model-visible deferred review reminder. Later
tool calls in the same unreviewed batch may emit compact reminders until the
listed SDD documents have both been read. To avoid issue-ticket or rate-limit
loops when context inference fails, tool-result reminders are capped by
`SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS`, default `1` total reminder per
unreviewed code batch. After the cap, the hook stays silent for tool results and
keeps the unresolved review visible in the diagnostic log/report instead of
continuing to inject model-visible text.

Frontend entry files are treated as code too. This includes `html` and `css`
alongside JavaScript, TypeScript, framework files, and common backend/source
extensions, so single-file browser prototypes such as `index.html` still trigger
the code-ahead-of-doc review checkpoint.

DTS / issue-ticket fixes are treated as an operational exception to
code-ahead-of-doc drift. Because issue-ticket work cannot be identified reliably
from file paths, the hook only skips this review when hook-visible context
contains markers such as `DTS`, `DTS问题单`, `issue ticket`, `bug fix`, `问题单修改`,
or when `SDD_DRIFT_DTS_CONTEXT=1` is set for the session. In OpenCode native
plugin mode, the adapter captures user messages through `chat.message` before
later `tool.execute.after` events, so the issue-ticket marker can be persisted
in hook state. In OpenCode through oh-my-opencode `PostToolUse`, current hook
input can still be limited to hook/session/tool metadata, so prompt-based issue
inference remains best effort there. For reliable OpenCode issue-ticket
handling, set `SDD_DRIFT_DTS_CONTEXT=1` on that run. Set
`SDD_DRIFT_DTS_SKIP=0` to disable this exception entirely. The exception does
not disable peer synchronization after explicit SDD document edits.

The batch clears after either:

- the latest code change is followed by an actual SDD edit and peer rules are
  satisfied; or
- both relevant `design.md` and `tasks.md` have been read, then the hook records
  a no-edit review-confirmation marker in hook state for the current code batch.

The model should update only the documents that actually need changes; it may
leave both documents unchanged if review shows they already match the code. That
no-edit path is not hard-blocked: the hook allows the turn to finish and writes a
`.sdd-drift-report.md` note asking the user to confirm whether documentation
really should remain unchanged.
If the report contents are unchanged on a later unrelated hook pass, the hook
does not rewrite the report just to refresh the timestamp.
When it does edit an SDD document, the injected prompt explicitly asks it to
keep existing Markdown headings, preserve the top-level template title, avoid
single-line summary replacement, and update the closest existing paragraph or
task item instead of adding new sections.

For unrelated files, "silent" means the hook may still append diagnostic log
records such as `hook_start`, `posttooluse_no_output`, or
`stop_allow_no_pending`, but it must not return model-visible enforcement or
reminder text and must not rewrite `.sdd-drift-report.md` when the report body
is unchanged.

When the environment supports subagents and the current project allows them, the
prompt suggests using a read-only subagent for SDD review. This is optional:
without subagents, the main agent performs the same review with normal `Read`
tools and remains responsible for any edits.

Recommended `.gitignore` entries:

```gitignore
.sdd-drift-report.md
.sdd-drift-hook-state/
.opencode/*.tmp
```

## Tests

```powershell
cd test\opencode-sdd-drift-e2e
npm install
npm test
npm run e2e -- -Scenario sdd-design
npm run e2e -- -Scenario sdd-cascade
npm run e2e -- -Scenario code
npm run e2e -- -Scenario code-no-doc-change
```

Real model checks:

```powershell
npm run e2e:real -- -Provider deepseek -Scenario design-cascade -HookMode stop-only
npm run e2e:real -- -Provider deepseek -Scenario design-cascade -HookMode posttooluse-and-stop
npm run e2e:real -- -Provider minimax -Scenario design-cascade -HookMode posttooluse-and-stop
```

Real OpenCode workflow and silent-regression checks:

```powershell
npm run e2e:real:snake -- -Provider deepseek
npm run e2e:real:silent -- -Provider deepseek
```

Native OpenCode plugin check:

```powershell
npm run e2e:real:native -- -Provider deepseek
npm run e2e:real:native -- -Provider minimax
```

Claude Code companion checks are under `test/claude-code-sdd-drift-e2e`.
Provider keys are intentionally local-only:

```powershell
cd test\claude-code-sdd-drift-e2e
Copy-Item .claude\providers\deepseek.local.ps1.example .claude\providers\deepseek.local.ps1
Copy-Item .claude\providers\minimax.local.ps1.example .claude\providers\minimax.local.ps1
```

Fill the `.local.ps1` files with an Anthropic Messages compatible gateway, then
run:

```powershell
npm run e2e:real -- -Provider deepseek -Scenario multi-code-cascade
npm run e2e:real -- -Provider minimax -Scenario multi-code-cascade
```

Run the same real-model scenario across both harnesses:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File test\run-sdd-drift-real-matrix.ps1 -Provider deepseek -Scenario multi-code-cascade -Target both
```

Observed on 2026-05-16:

| Provider | Hook mode | Result |
| --- | --- | --- |
| DeepSeek | `stop-only` | Failed: OpenCode reached `session.idle`, but Stop continuation was not invoked |
| DeepSeek | `posttooluse-and-stop` | Passed: `tasks.md` was synchronized, no report remained |
| Minimax M2.7 | `posttooluse-and-stop` | Passed: `tasks.md` was synchronized, no report remained |

## Debug Switches

Disable diagnostic file logging:

```powershell
$env:SDD_DRIFT_LOG = "0"
opencode
```

Write diagnostic logs to a specific file:

```powershell
$env:SDD_DRIFT_LOG_PATH = "E:\tmp\sdd-drift-check.log.jsonl"
opencode
```

Change log rotation size, default `2097152` bytes:

```powershell
$env:SDD_DRIFT_LOG_MAX_BYTES = "5242880"
opencode
```

Change the maximum number of model-visible tool-result reminders for one
unreviewed code batch, default `1`. Set `2` if you prefer one compact follow-up
reminder; set `0` to disable tool-result reminders for code-ahead-of-doc review
while keeping peer SDD synchronization active:

```powershell
$env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = "2"
opencode
```

Change diagnostic log retention, default `3` days. Set `0` to disable age-based
cleanup temporarily:

```powershell
$env:SDD_DRIFT_LOG_RETENTION_DAYS = "7"
opencode
```

Show non-peer warnings:

```powershell
$env:SDD_DRIFT_SHOW_WARNINGS = "1"
opencode
```

Strict blocking mode, which may show UI warnings because it uses `stderr` and
exit code 2:

```powershell
$env:SDD_DRIFT_STRICT = "1"
opencode
```

Hook bug diagnostics:

```powershell
$env:SDD_DRIFT_DEBUG = "1"
opencode
```

## Boundaries

- Tracks OpenCode/Claude file tools only. Shell redirection is not visible to the
  hook.
- Built-in peer rules are `proposal.md -> design.md` as a soft stage reminder
  only when `design.md` exists, `design.md -> tasks.md` only when `tasks.md`
  exists, and independent `tasks.md -> design.md` only when `design.md` exists.
- OpenCode Stop-only continuation is kept as compatible output, but should not
  be treated as reliable cascade enforcement until the OpenCode/oh-my bridge
  invokes it consistently.
