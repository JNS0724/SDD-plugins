# SDD Plugins

This repository is a collection of plugins and hook integrations for SDD
(Spec-Driven Development) workflows.

The project is intentionally plugin-focused. Historical Codex skill packages
have been removed; reusable SDD automation now lives under `plugins/`, with
test harnesses under `test/`.

## Plugins

| Plugin | Status | Purpose |
| --- | --- | --- |
| `plugins/sdd-drift-check` | Active | OpenCode native plugin and Claude Code compatible hook that detects SDD drift and asks the model to reconcile related `proposal.md`, `design.md`, and `tasks.md` files. |

## Repository Layout

```text
plugins/
  sdd-drift-check/
    src/
      index.js
      stdin.js
    build.mjs
    package.json
    sdd-drift-check-hook.js
    sdd-drift-check-opencode.js
docs/
  sdd-drift-check/
    sdd-drift-check.md
    opencode-omo-getting-started.md
test/
  opencode-sdd-drift-e2e/
  claude-code-sdd-drift-e2e/
  run-sdd-drift-real-matrix.ps1
```

## SDD Drift Check

`sdd-drift-check` helps keep SDD change documents synchronized while an agent is
editing code or SDD documents.

### Runtime Environment

Use this plugin in one of these hook-capable runtimes:

- Claude Code with its native hook configuration.
- OpenCode with the native OpenCode plugin entrypoint.
- OpenCode with `oh-my-opencode` installed and Claude Code hook bridging
  enabled.

The shared hook implementation is `sdd-drift-check-hook.js`. Claude Code and
`oh-my-opencode` call it as a command hook. Native OpenCode uses
`sdd-drift-check-opencode.js`, which adapts OpenCode plugin events to the shared
hook implementation.

It supports:

- OpenCode native plugin hooks through `tool.execute.after` and `session.idle`.
- OpenCode through `oh-my-opencode` hook bridging.
- Claude Code compatible hook settings.
- `UserPromptSubmit` context capture for Claude Code issue-ticket detection.
- `PostToolUse` model-visible reminders for reliable OpenCode cascades.
- Subagent result checkpoints for OpenCode + `oh-my-opencode`.
- Question/tool handoff checkpoints before commit-or-continue prompts.
- `Stop` hook checks for Claude-compatible final review behavior.
- Session-level batching for code changes before SDD reconciliation.
- Project-level `project.json` state for cross-session active change-dir drift,
  review timestamps, linked code, and aligned baselines.
- Issue-ticket/DTS context suppression for code-ahead-of-doc reminders.
- Bounded code-review reminders to avoid repeated tool-result injection loops.
- Diagnostic JSONL logs with default 3-day retention.

See the plugin documentation for installation and behavior details:

```text
docs/sdd-drift-check/sdd-drift-check.md
```

## Testing

Static and fake-provider tests:

```powershell
cd test\opencode-sdd-drift-e2e
npm test
npm run e2e -- -Scenario code -HookMode posttooluse-and-stop
```

Real provider matrix, after local provider keys are configured:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File test\run-sdd-drift-real-matrix.ps1 -Provider all -Scenario multi-code-cascade -Target both
```

The real matrix runs both OpenCode and Claude Code harnesses against DeepSeek
and MiniMax when those providers are configured locally.

OpenCode real-workflow validation:

```powershell
cd test\opencode-sdd-drift-e2e
npm run e2e:real:snake -- -Provider deepseek
npm run e2e:real:silent -- -Provider deepseek
```

The silent check reuses the latest generated Snake workroot and verifies that
unrelated scratch-file reads/writes do not emit model-visible SDD reminders and
do not rewrite an unchanged `.sdd-drift-report.md`.

## Local Secrets

Provider keys and generated real-model workspaces are local-only. The test
harnesses ignore files such as:

- `.claude/providers/*.local.ps1`
- `.claude/providers/*.local.env`
- `.real-workspaces/`
- `.sdd-drift-report.md`
- `.sdd-drift-hook-state/`

Do not commit API keys or real-model run artifacts.

## Adding Plugins

Add new SDD plugins under `plugins/<plugin-name>/` with:

- implementation files,
- a plugin-level README or markdown guide,
- installation instructions,
- focused fake-provider tests when possible,
- real-provider validation scripts only when they do not require committed
  secrets.
