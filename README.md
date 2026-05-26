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
    sdd-drift-check-rules.md
docs/
  sdd-drift-check/
    sdd-drift-check.md
    getting-started.md
    sdd-drift-check-core-refactor-plan.zh.md
    sdd-drift-check-hook.prd.zh.md
    sdd-drift-check-hook.design.zh.md
    sdd-drift-check-hook.refactor.zh.md
    sdd-drift-check-hook.review.zh.md
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

Both JavaScript artifacts are self-contained at runtime. OpenCode users install
`sdd-drift-check-opencode.js` under project `.opencode/plugins/` or global
`~/.config/opencode/plugins/`; Claude Code users install
`sdd-drift-check-hook.js`. Users may also place `sdd-drift-check-rules.md` in
the same directory as the installed JS file to customize SDD review principles
without rebuilding or restarting for wording-only changes. Shared logic lives under `src/core/`, including tool event
classification, runtime config parsing, output protocol helpers, and SDD rule
text/constants.

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
- Structured model-visible reminders wrapped as `<system-reminder>` with a
  `[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - ...]` header, so Claude Code and
  OpenCode receive the same high-priority SDD review language.

See the plugin documentation for installation and behavior details:

```text
docs/sdd-drift-check/sdd-drift-check.md
```

For a quick installation and first-use guide:

```text
docs/sdd-drift-check/getting-started.md
```

## Build And Package

`plugins/sdd-drift-check/src/adapters/` contains the runtime adapter sources.
The committed distributable files are:

```text
plugins/sdd-drift-check/sdd-drift-check-hook.js
plugins/sdd-drift-check/sdd-drift-check-opencode.js
plugins/sdd-drift-check/sdd-drift-check-rules.md
```

After changing files under `plugins/sdd-drift-check/src/`, rebuild the
distributable artifacts before testing or committing:

```powershell
cd plugins\sdd-drift-check
npm install
npm run build
npm run build:check
```

`npm run build` updates both JS distributable files:

- `sdd-drift-check-hook.js`
- `sdd-drift-check-opencode.js`

`sdd-drift-check-rules.md` is a user-editable runtime rules file. The plugin
loads it dynamically from the same directory as the installed JS artifact, or
from `SDD_DRIFT_RULES_FILE` when that environment variable is set.

`npm run build:check` generates temporary JS artifacts and compares them with
the committed JS files; a non-zero exit means a package artifact is stale.
Prompt-code changes still need this check because the generated hook artifact
embeds `src/core/prompts.js`. Runtime edits to `sdd-drift-check-rules.md` do not
require rebuilding.

## Testing

Static and fake-provider tests:

```powershell
cd test\opencode-sdd-drift-e2e
npm test
```

Real provider matrix, after local provider keys are configured:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File test\run-sdd-drift-real-matrix.ps1 -Provider all -Scenario multi-code-cascade -Target both
```

The real matrix runs both OpenCode and Claude Code harnesses against DeepSeek
and MiniMax when those providers are configured locally.

The current structured-prompt implementation was regression-checked on
2026-05-26 with:

- OpenCode native plugin + DeepSeek
- OpenCode native plugin + MiniMax
- Claude Code command hook + DeepSeek
- Claude Code command hook + MiniMax

OpenCode native real-provider validation:

```powershell
cd test\opencode-sdd-drift-e2e
npm run e2e:real -- -Provider deepseek
npm run e2e:real -- -Provider minimax
```

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
