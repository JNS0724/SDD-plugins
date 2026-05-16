# SDD Plugins

This repository is a collection of plugins and hook integrations for SDD
(Spec-Driven Development) workflows.

The project is intentionally plugin-focused. Historical Codex skill packages
have been removed; reusable SDD automation now lives under `plugins/`, with
test harnesses under `test/`.

## Plugins

| Plugin | Status | Purpose |
| --- | --- | --- |
| `plugins/sdd-drift-check` | Active | OpenCode and Claude Code compatible hook that detects SDD drift and asks the model to reconcile related `proposal.md`, `design.md`, and `tasks.md` files. |

## Repository Layout

```text
plugins/
  sdd-drift-check/
    sdd-drift-check-hook.js
    sdd-drift-check.md
    package.json
test/
  opencode-sdd-drift-e2e/
  claude-code-sdd-drift-e2e/
  run-sdd-drift-real-matrix.ps1
```

## SDD Drift Check

`sdd-drift-check` helps keep SDD change documents synchronized while an agent is
editing code or SDD documents.

It supports:

- OpenCode through `oh-my-opencode` hook bridging.
- Claude Code compatible hook settings.
- `PostToolUse` model-visible reminders for reliable OpenCode cascades.
- `Stop` hook checks for Claude-compatible final review behavior.
- Session-level batching for code changes before SDD reconciliation.
- Diagnostic JSONL logs with default 3-day retention.

See the plugin documentation for installation and behavior details:

```text
plugins/sdd-drift-check/sdd-drift-check.md
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
