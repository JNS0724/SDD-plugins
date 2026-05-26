# SDD Drift Check

OpenCode / Claude Code compatible hook for SDD drift checks.

## Current Status

Claude Code uses the command-hook artifact. OpenCode uses the native plugin
adapter. Both runtime faces share the same drift rules, state files, reports,
and diagnostic logs. In native OpenCode, Stop continuation is best effort
because it fires after `session.idle`; the reliable model-visible path is still
`tool.execute.after`.

## Runtime Environment

This package has two entrypoints:

- `sdd-drift-check-hook.js`: Claude Code-compatible command hook. Use this with
  Claude Code hook configuration.
- `sdd-drift-check-opencode.js`: native OpenCode plugin adapter. Use this when
  you want OpenCode to load the plugin directly from `.opencode/plugins/`.
- `sdd-drift-check-rules.md`: optional runtime prompt-rules file. Put it in the
  same directory as the installed JS artifact when users need to customize SDD
  review principles.

Both entrypoints share the same drift rules, state files, reports, and
diagnostic logs. The native OpenCode adapter is intentionally separate from the
Claude-compatible command hook: Claude uses `sdd-drift-check-hook.js`, while
pure OpenCode loads the self-contained `sdd-drift-check-opencode.js` plugin
artifact. The two artifacts are built from shared source modules, but neither
runtime requires users to install the other runtime's JS file.

The native OpenCode adapter listens to `chat.message`, `tool.execute.before`,
`tool.execute.after`, `session.idle`, and OpenCode's `session.status` idle
event. It captures user-message context for issue-ticket detection, caches tool
arguments in `tool.execute.before`, converts tool/idle events into the shared
hook input shape, and appends model-visible reminders to the tool result when
drift is detected. Question-like tools are checked in `tool.execute.before`, so
an agent that is about to ask "commit now?" can be redirected to finish the SDD
checkpoint first.

Native OpenCode caveat: `session.idle` / idle `session.status` is an event, not
a mutable Stop hook response. The native adapter can refresh reports/logs and,
when the shared Stop hook returns `inject_prompt`, makes a best-effort
`session.prompt` continuation call. Current OpenCode plugin hooks still do not
provide a direct Stop-continuation output channel. For reliable continuation in
OpenCode, keep `tool.execute.after` enabled.

Important OpenCode note: real testing with OpenCode 1.2.27 showed that
Stop-only did not reliably trigger continuation in `opencode run`. Stop output
can appear after the assistant has already ended, without causing another model
turn. For reliable OpenCode cascade today, keep the native plugin's
`tool.execute.after` handling enabled. Stop remains enabled as a bounded
best-effort continuation attempt plus final report/log checkpoint. If you prefer
no OpenCode Stop continuation attempt at all, set
`SDD_DRIFT_OPENCODE_STOP_MODE=report-only`.

The Claude command hook does not use `console.error` or `messages.transform`.
The native OpenCode adapter only uses `session.prompt` as a best-effort Stop
continuation path after parsing a structured `inject_prompt`; ordinary
model-visible reminders still go through tool results.

## Model-Visible Prompt Shape

All SDD prompts now use the same structured wrapper:

```text
<system-reminder>
[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - <TYPE>]

STATE
...

REQUIRED ACTION
...

SDD EDIT RULES / ALIGNMENT RULES / EXIT CRITERIA
...
</system-reminder>
```

This is intentionally model-visible directive text, not a hidden system-role
override. The hook still depends on the runtime channel that carries the text:
Claude Code receives command-hook output, while native OpenCode receives tool
result reminders and best-effort Stop continuation prompts.

Prompt types currently include:

| Type | When it appears |
| --- | --- |
| `CODE REVIEW NOTICE` | First weak notice after implementation code changes; it tells the model to keep working now and review SDD before final answer |
| `CODE REVIEW CHECKPOINT` / `CODE REVIEW REMINDER` | Stage-end code review requirement for active `design.md` / `tasks.md` |
| `PEER SYNC CHECKPOINT` / `PEER SYNC REMINDER` | Existing `design.md` and `tasks.md` peers are out of sync after an SDD document edit |
| `PROPOSAL STAGE REMINDER` | `proposal.md` changed and `design.md` already exists |
| `QUESTION CHECKPOINT` | A question/confirm/handoff tool is about to return control before SDD review is done |
| `STOP ENFORCEMENT` | Claude-compatible Stop path found unresolved SDD work |
| `COMPACTION CHECKPOINT RECOVERY` / `COMPACTION DRIFT SUMMARY` | `PreCompact` preserves pending SDD state through context compression |
| `CARRY-OVER DRIFT` | New session sees unresolved project-level drift from prior sessions |
| `ATTRIBUTION REVIEW` | Multiple active change directories could own the same code change |

The section layout is part of the tested prompt contract. In particular, SDD
edits must preserve existing headings/templates, modify the closest stale
paragraph or task item, avoid adding new sections merely to satisfy the hook,
and return to the original user task after the SDD checkpoint is handled.

## Custom Prompt Rules

The review principles are loaded dynamically from `sdd-drift-check-rules.md`.
The lookup order is:

1. `SDD_DRIFT_RULES_FILE`, when set.
2. `sdd-drift-check-rules.md` in the same directory as the running JS artifact.
3. Built-in defaults if no rules file is found, or if a section is empty.

The supported section headings are:

- `## SDD 编辑规则` (`## SDD EDIT RULES`)
- `## 活跃 SDD 对齐规则` (`## Active SDD Alignment Rules`)
- `## 归属评审规则` (`## Attribution Review Rules`)
- `## 子代理评审规则` (`## Subagent Review Rule`)
- `## 退出标准` (`## Exit Criteria`)

Edit bullet lines under those headings to change the principles injected into
future reminders. The file is read each time the plugin builds a prompt, so
users do not need to rebuild the plugin or restart a long-running OpenCode
process just to adjust wording. If a section is missing, that section keeps the
built-in defaults.

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
| new session starts with prior unresolved drift | Restores project-level carry-over drift from `project.json` and can inject a compact reminder through `UserPromptSubmit` / `PreCompact` / `Stop` |
| DTS / issue-ticket context | Skips code-ahead-of-doc review reminders; Claude Code captures prompt context through `UserPromptSubmit`, native OpenCode captures it through `chat.message`, and any runtime can force it with `SDD_DRIFT_DTS_CONTEXT=1` |
| code only affects task progress | Allows a tasks-only update, or no document edit, after both `design.md` and `tasks.md` have been reviewed |
| model ignores constraints and stops | Writes `.sdd-drift-report.md` for human review |

State is stored under the nearest `.git/sdd-drift-hook-state/` when possible, so
normal hook state does not pollute project status. The directory contains
per-session state files plus `project.json`, which is the cross-session authority
for active change directories, document review timestamps, linked code files, and
`alignedAtMs` baselines. `.sdd-drift-report.md` is kept in the project root
because it is meant to be visible.

State updates are serialized with short-lived locks for both the session file and
`project.json`. This matters when an agent emits parallel file writes: a
`design.md` edit that asks for `tasks.md` synchronization and the follow-up
`tasks.md` edit must be merged into one coherent state, otherwise one hook
process can overwrite the other and create design/tasks ping-pong reminders.

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

In native OpenCode mode, Stop returns a short `reason` and a full
`inject_prompt` so the OpenCode adapter can attempt continuation without dumping
the full SDD prompt as the visible block reason. This is best effort only: if
the session has already settled, OpenCode may still not start another model
turn. Claude Code receives normal `decision: "block"` Stop output. To make
OpenCode Stop report-only, set `SDD_DRIFT_OPENCODE_STOP_MODE=report-only` or
`SDD_DRIFT_OPENCODE_STOP_INJECT=0`.

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

Copy the OpenCode artifact under `.opencode/plugins/` for one project:

```powershell
New-Item -ItemType Directory -Force .opencode\plugins
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-opencode.js .opencode\plugins\sdd-drift-check-opencode.js
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-rules.md .opencode\plugins\sdd-drift-check-rules.md
```

Or install it globally for all OpenCode projects:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-opencode.js "$env:USERPROFILE\.config\opencode\plugins\sdd-drift-check-opencode.js" -Force
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-rules.md "$env:USERPROFILE\.config\opencode\plugins\sdd-drift-check-rules.md" -Force
```

OpenCode automatically loads local plugins from `.opencode/plugins/` and
`~/.config/opencode/plugins/`. On Windows the global path is usually
`C:\Users\<user>\.config\opencode\plugins\`.
`sdd-drift-check-opencode.js` is self-contained; do not also copy
`sdd-drift-check-hook.js` into `.opencode/plugins/`.
Keep `sdd-drift-check-rules.md` in the same directory as the installed JS file;
the plugin reloads it whenever it builds a reminder prompt.

### Claude Code Or Claude-Compatible Hook Config

For Claude Code, this minimal Stop-only config captures `UserPromptSubmit`
context and does not enable `PostToolUse`:

```powershell
New-Item -ItemType Directory -Force .claude\hooks\sdd-drift-check
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-hook.js .claude\hooks\sdd-drift-check\sdd-drift-check-hook.js
Copy-Item E:\tool\MySkills\MySkills\plugins\sdd-drift-check\sdd-drift-check-rules.md .claude\hooks\sdd-drift-check\sdd-drift-check-rules.md
```

`.claude/settings.json`:

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

After installing in a real project, verify that the hook is being called:

```powershell
Get-ChildItem -Force .git\sdd-drift-hook-state
Get-Content .git\sdd-drift-hook-state\sdd-drift-check.log.jsonl -Tail 20
```

If the project has no `.git` directory, check the fallback locations:

```powershell
Get-ChildItem -Force .sdd-drift-hook-state
Get-ChildItem -Force "$env:TEMP\sdd-drift-check"
```

Useful diagnostic events include `hook_start`,
`user_prompt_context_captured`, `posttooluse_no_output`,
`emit_subagent_checkpoint_enforcement`, and `stop_allow_no_pending`. If none
of them appear after an OpenCode or Claude Code conversation, the plugin or
command-hook path is not wired correctly.

If compaction happens immediately after a question checkpoint, `PreCompact`
preserves that active checkpoint explicitly. The compacted context tells the
model to resume the interrupted SDD review/synchronization before continuing
other work, asking commit/continue questions, or producing the final answer.

SDD review is a checkpoint inside the current user task, not the task endpoint.
After the required SDD review or synchronization is complete, the model should
return to the original user task/request from where it paused. It should only
produce the final answer after both the original work and SDD checkpoint are
complete.

Code-ahead-of-doc drift is batched at session level. Implementation-code edits
are recorded during `PostToolUse`, and by default the hook emits at most one
weak code-review reminder per session. The reminder tells the model to continue
coding if implementation work remains, then review SDD before the final answer.
This keeps long coding batches from being interrupted after every `.ts`/code
edit while still giving OpenCode models a model-visible constraint before they
try to finish.

The review target set is every existing `design.md` and `tasks.md` under active
root-level `sdd/changes/*` and `.sdd/changes/*` directories. This covers
multiple change proposals in progress at the same time instead of only the
change directory touched in the current turn. Archived change directories are
excluded. `SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS` controls the per-batch
cap, and `SDD_DRIFT_CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS` controls the
session-wide cap; both default to `1`. Set either to `0` to fully defer code
review to `Stop` / question / compaction checkpoints. Peer SDD document
synchronization still emits immediately because a `design.md`/`tasks.md` edit
should be kept consistent with its existing peer in the same turn.

The code-review prompt treats active SDD files as live planning records, not
optional commentary. Until a change directory is archived, `design.md` and
`tasks.md` should be kept aligned with implemented code facts. Behavior changes,
API/contract changes, algorithms, state/data flow, data structures, performance
strategy, error handling, security boundaries, user-visible results, and
implementation constraints are all design-impacting changes even when the model
calls the work an optimization or refactor. `tasks.md` should also move with the
code when tasks are completed, changed, canceled, split, or invalidated. The
prompt explicitly tells the model not to satisfy alignment by only adding a
marker, generic completion note, or summary: it should replace the stale sentence,
paragraph, or checklist item so the document states the actual implemented
behavior, API, error handling, performance strategy, or task status, and it
should not leave old wording that still contradicts the changed code. The
no-edit path is reserved for mechanical changes with no design or task impact,
such as formatting-only edits, comment-only edits, test-only scaffolding, or
config/dependency churn that does not alter the active SDD plan.

Frontend entry files are treated as code too. This includes `html` and `css`
alongside JavaScript, TypeScript, framework files, and common backend/source
extensions, so single-file browser prototypes such as `index.html` still trigger
the code-ahead-of-doc review checkpoint.

DTS / issue-ticket fixes are treated as an operational exception to
code-ahead-of-doc drift. Because issue-ticket work cannot be identified reliably
from file paths, the hook only skips this review when hook-visible context
contains markers such as `DTS`, `DTS问题单`, `issue ticket`, `bug fix`, `问题单修改`,
or when `SDD_DRIFT_DTS_CONTEXT=1` is set for the session. In Claude Code, enable
the `UserPromptSubmit` hook so the original user request is captured before
later `PostToolUse` events. In OpenCode native plugin mode, the adapter captures
user messages through `chat.message` before later `tool.execute.after` events,
so the issue-ticket marker can be persisted in hook state. For explicit
issue-ticket handling in either runtime, set `SDD_DRIFT_DTS_CONTEXT=1` on that
run. Set `SDD_DRIFT_DTS_SKIP=0` to disable this
exception entirely. The exception does not disable peer synchronization after
explicit SDD document edits.

The batch clears after either:

- every active `sdd/changes/*/{design.md,tasks.md}` review target has been
  touched after the latest code change, and at least one reviewed SDD document
  was actually edited; any remaining design/tasks peer sync is handled by the
  separate peer-sync rule; or
- every active review target has been read, then the hook records a no-edit
  review-confirmation marker in hook state for the current code batch.

A change directory is treated as archived, and therefore skipped, when its
directory name is `archive`, `archives`, `archived`, `.archive`, `.archived`, or
`已归档`; when its name is explicitly suffixed/prefixed with `archived` or
`已归档`; when it contains marker files such as `.archived`, `.archive`,
`ARCHIVED`, `archived.md`, `archive.md`, or `已归档.md`; or when a small status
file such as `status.md` contains `status: archived` or `状态: 已归档`.

The model should update only the documents that actually need changes, but
"optimization" or "refactor" is not by itself a reason to skip SDD edits. It may
leave both documents unchanged only when review shows they already match the
code or the code change has no active design/task impact. That no-edit path is
not hard-blocked: the hook allows the turn to finish and writes a
`.sdd-drift-report.md` note asking the user to confirm whether documentation
really should remain unchanged. The final response should also say which active
SDD files were reviewed and why no document edit was needed.
If the report contents are unchanged on a later unrelated hook pass, the hook
does not rewrite the report just to refresh the timestamp.
When it does edit an SDD document, the injected prompt explicitly asks it to
keep existing Markdown headings, preserve the top-level template title, avoid
single-line summary replacement, keep unrelated existing paragraphs and task
items, and update the closest existing paragraph or task item instead of adding
new sections.

For unrelated files, "silent" means the hook may still append diagnostic log
records such as `hook_start`, `posttooluse_no_output`, or
`stop_allow_no_pending`, but it must not return model-visible enforcement or
reminder text and must not rewrite `.sdd-drift-report.md` when the report body
is unchanged.

In OpenCode, a `QUESTION CHECKPOINT` can be rendered as a red denied-tool result
because the hook blocks the question/handoff tool before control returns to the
user. That is expected when the text begins with `SDD drift question checkpoint`
or the structured `<system-reminder>` wrapper. Treat it as a bug only if the
model does not continue with SDD review, the same checkpoint loops repeatedly,
or the diagnostic log records `handler_exception` / `circuit_open`.

When the environment supports subagents and the current project allows them, the
prompt suggests using a read-only subagent for SDD review. This is optional:
without subagents, the main agent performs the same review with normal `Read`
tools and remains responsible for any edits.

For native OpenCode mode, subagent checkpoint events can pass the tool result
text into the command hook as `tool_output`. If a child context edits code and
returns a changed-files summary, the hook uses that summary to hydrate the
parent-session state before checking SDD drift. This fallback is conservative:
it only trusts checkpoint output lines that describe changed files and only
records existing code paths inside the current workspace. If the child result
says implementation/edit work completed but does not list files, or the
checkpoint event has no text output at all, the hook can also scan recently
modified code files in the current workspace
(`SDD_DRIFT_CHECKPOINT_MTIME_SCAN=0` disables that fallback).

Recommended `.gitignore` entries:

```gitignore
.sdd-drift-report.md
.sdd-drift-hook-state/
.opencode/*.tmp
```

## Build And Package

The committed runtime artifacts are:

```text
plugins/sdd-drift-check/sdd-drift-check-hook.js
plugins/sdd-drift-check/sdd-drift-check-opencode.js
plugins/sdd-drift-check/sdd-drift-check-rules.md
```

The adapter sources live under:

```text
plugins/sdd-drift-check/src/core/output.js
plugins/sdd-drift-check/src/core/runtime-config.js
plugins/sdd-drift-check/src/core/sdd-rules.js
plugins/sdd-drift-check/src/core/tool-events.js
plugins/sdd-drift-check/src/adapters/claude-code/command-hook.js
plugins/sdd-drift-check/src/adapters/opencode/native-plugin.js
```

`src/core/` contains runtime-neutral shared code used by the adapters:
tool event classification, runtime config parsing, output protocol helpers, and
SDD rule text/constants. The remaining drift-state logic still lives in the
Claude command-hook adapter in this phase and can move into `src/core/`
incrementally.

After changing `src/`, rebuild the distributable artifacts:

```powershell
cd plugins\sdd-drift-check
npm install
npm run build
```

Then verify the committed artifact is in sync:

```powershell
npm run build:check
```

`build:check` creates temporary JS artifacts and byte-compares them with both
committed JS runtime files. If it fails, run `npm run build` and commit the
updated artifact(s) together with the source change. `sdd-drift-check-rules.md`
is not bundled; it is read dynamically at runtime.

## Tests

```powershell
cd test\opencode-sdd-drift-e2e
npm install
npm test
```

OpenCode native real model checks:

```powershell
npm run e2e:real -- -Provider deepseek
npm run e2e:real -- -Provider minimax
```

The static/fake-provider `npm test` suite covers the semantic drift cases,
including performance strategy, user-visible behavior, API contract, and
error-handling drift. Those cases fail if `design.md` only receives a marker or
completion note while stale facts still contradict the changed code.

Native OpenCode plugin check is also available under the explicit alias:

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

Observed on 2026-05-26 after the structured prompt wrapper change:

| Runtime | Provider | Scenario | Result |
| --- | --- | --- | --- |
| OpenCode native plugin | DeepSeek | `multi-code-cascade` focused regression | Passed: model saw structured SDD directive and no unresolved report remained |
| OpenCode native plugin | MiniMax | `multi-code-cascade` focused regression | Passed: model saw structured SDD directive and no unresolved report remained |
| Claude Code command hook | DeepSeek | `multi-code-cascade` focused regression | Passed: Stop/checkpoint language preserved original-task resumption |
| Claude Code command hook | MiniMax | `multi-code-cascade` focused regression | Passed: Stop/checkpoint language preserved original-task resumption |

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

Change the maximum number of model-visible code-review tool-result reminders.
The per-batch and per-session defaults are both `1`, so ordinary code changes
get one weak reminder and later code edits in the same session stay quiet:

```powershell
$env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = "1"
$env:SDD_DRIFT_CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS = "1"
opencode
```

Set either value to `0` to fully defer code review to `Stop` / question /
compaction checkpoints.

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

Disable OpenCode Stop continuation attempts and keep Stop report-only:

```powershell
$env:SDD_DRIFT_OPENCODE_STOP_MODE = "report-only"
opencode
```

Use this only if the post-idle Stop prompt is more distracting than useful in
your environment. In normal native OpenCode usage, keep `tool.execute.after`
enabled; it handles the reliable model-visible continuation path.

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
- OpenCode Stop-only continuation is best effort. It should not be treated as
  reliable cascade enforcement; use `PostToolUse` for model-visible reminders.
