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
      adapters/
        claude-code/
          command-hook.js
        opencode/
          native-plugin.js
      core/
        output.js
        runtime-config.js
        sdd-rules.js
        tool-events.js
      handlers/
      build.mjs
    package.json
    sdd-drift-check-hook.js
    sdd-drift-check-opencode.js
docs/
  sdd-drift-check/
    sdd-drift-check.md
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

The two runtime faces are peers in source:

- `src/adapters/claude-code/command-hook.js` builds the Claude Code command
  hook artifact `sdd-drift-check-hook.js`.
- `src/adapters/opencode/native-plugin.js` builds the native OpenCode plugin
  artifact `sdd-drift-check-opencode.js`.

The OpenCode adapter still invokes the shared command hook artifact for the core
drift rules in this phase; the source layout now separates the runtime adapter
boundary so a later core extraction can happen without changing user-facing
install paths. Shared logic that is already runtime-neutral lives under
`src/core/`, including tool event classification, runtime config parsing, output
protocol helpers, and SDD rule text/constants.

It supports:

- OpenCode native plugin hooks through `tool.execute.after` and `session.idle`.
- Claude Code compatible hook settings.
- `UserPromptSubmit` context capture for Claude Code issue-ticket detection.
- `PostToolUse` model-visible reminders for reliable OpenCode cascades.
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

## Build And Package

`plugins/sdd-drift-check/src/adapters/` contains the runtime adapter sources.
The committed distributable files are:

```text
plugins/sdd-drift-check/sdd-drift-check-hook.js
plugins/sdd-drift-check/sdd-drift-check-opencode.js
```

After changing files under `plugins/sdd-drift-check/src/`, rebuild the
distributable artifacts before testing or committing:

```powershell
cd plugins\sdd-drift-check
npm install
npm run build
npm run build:check
```

`npm run build` updates both distributable files. `npm run build:check`
generates temporary artifacts and compares them with the committed files; a
non-zero exit means a package artifact is stale.

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
