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
| `plugins/sdd-review-ledger` | Active | Claude Code and OpenCode plugin that tracks changed SDD/code files by content hash and asks the model to review them through a local ledger/todo workflow. |
| `plugins/opencode-turn-checkpoint` | Active | OpenCode native plugin that observes stable session idle checkpoints and calls external CLI callbacks with a JSON payload. |

## Repository Layout

```text
plugins/
  opencode-turn-checkpoint/
    opencode-turn-checkpoint.js
    opencode-turn-checkpoint.json
    README.md
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
  sdd-review-ledger/
    src/
      adapters/
        claude-code/
          command-hook.js
        opencode/
          native-plugin.js
    docs/
    package.json
    sdd-review-ledger-hook.js
    sdd-review-ledger-opencode.js
    sdd-review-rules.md
docs/
  sdd-drift-check/
    sdd-drift-check.md
    sdd-drift-check.zh.md
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
editing code or SDD documents. It supports OpenCode and Claude Code.

```text
docs/sdd-drift-check/sdd-drift-check.md
docs/sdd-drift-check/sdd-drift-check.zh.md
docs/sdd-drift-check/getting-started.md
```

## OpenCode Turn Checkpoint

`opencode-turn-checkpoint` is an OpenCode-only companion plugin for turn-end
notifications and integrations. It is independent from `sdd-drift-check`.

```text
plugins/opencode-turn-checkpoint/README.md
```

## SDD Review Ledger

`sdd-review-ledger` is the newer ledger-based review orchestrator. It supports
Claude Code and OpenCode through separate adapters over the same core logic.

```text
plugins/sdd-review-ledger/README.md
plugins/sdd-review-ledger/docs/getting-started.md
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

`plugins/sdd-review-ledger` follows the same two-artifact pattern:

```powershell
cd plugins\sdd-review-ledger
npm install
npm run build
npm run build:check
```

Generated files:

- `sdd-review-ledger-hook.js`
- `sdd-review-ledger-opencode.js`

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
