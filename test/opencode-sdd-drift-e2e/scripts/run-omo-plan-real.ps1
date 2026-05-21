param(
  [ValidateSet("deepseek", "minimax")]
  [string]$Provider = "deepseek",
  [switch]$SeedPlan
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $root)
$runId = [guid]::NewGuid().ToString("N")
$workRoot = Join-Path $root ".real-workspaces\omo-plan-$Provider-$runId"
$opencodeHome = Join-Path $root ".real-homes\omo-plan-$Provider-$runId"
$logRoot = Join-Path $root ".real-logs\omo-plan-$Provider-$runId"
$outPlanLog = Join-Path $logRoot "omo-plan.out.log"
$errPlanLog = Join-Path $logRoot "omo-plan.err.log"
$outWorkLog = Join-Path $logRoot "omo-work.out.log"
$errWorkLog = Join-Path $logRoot "omo-work.err.log"
$opencodeBin = Join-Path $root "node_modules\.bin\opencode.cmd"
$configTemplate = Join-Path $root ".opencode\opencode.$Provider.jsonc.example"
$rootConfigPath = Join-Path $root ".opencode\opencode.jsonc"
$rootConfigBackupPath = Join-Path $logRoot "opencode.root-backup.tmp"
$rootOhmyConfigPath = Join-Path $root ".opencode\oh-my-openagent.jsonc"
$rootOhmyBackupPath = Join-Path $logRoot "oh-my-openagent.root-backup.tmp"
$rootSettingsPath = Join-Path $root ".claude\settings.json"
$rootSettingsBackupPath = Join-Path $logRoot "settings.root-backup.tmp"
$hookPath = (Join-Path $repoRoot "plugins\sdd-drift-check\sdd-drift-check-hook.js").Replace("\", "/")
$marker = "omo-plan-task-" + $runId.Substring(0, 8)
$planFile = Join-Path $workRoot ".sisyphus\plans\omo-sdd-delegated-code.md"
$modelName = if ($Provider -eq "deepseek") { "deepseek/deepseek-chat" } else { "minimax/MiniMax-M2.7" }
$keyName = if ($Provider -eq "deepseek") { "DEEPSEEK_API_KEY" } else { "MINIMAX_API_KEY" }

if (!(Test-Path -LiteralPath $opencodeBin)) {
  throw "missing opencode binary; run npm install in $root"
}
if (!(Test-Path -LiteralPath $configTemplate)) {
  throw "missing provider config template: $configTemplate"
}
$keyValue = [Environment]::GetEnvironmentVariable($keyName, "Process")
if (!$keyValue) {
  $keyValue = [Environment]::GetEnvironmentVariable($keyName, "User")
}
if (!$keyValue) {
  $keyValue = [Environment]::GetEnvironmentVariable($keyName, "Machine")
}
if (!$keyValue) {
  throw "$keyName is not set"
}
[Environment]::SetEnvironmentVariable($keyName, $keyValue, "Process")

$minimaxBaseUrl = $null
if ($Provider -eq "minimax") {
  $minimaxBaseUrl = [Environment]::GetEnvironmentVariable("MINIMAX_BASE_URL", "Process")
  if (!$minimaxBaseUrl) { $minimaxBaseUrl = [Environment]::GetEnvironmentVariable("MINIMAX_BASE_URL", "User") }
  if (!$minimaxBaseUrl) { $minimaxBaseUrl = [Environment]::GetEnvironmentVariable("MINIMAX_BASE_URL", "Machine") }
  if (!$minimaxBaseUrl) { $minimaxBaseUrl = "https://api.minimaxi.com/v1" }
}

New-Item -ItemType Directory -Force (Join-Path $workRoot ".opencode\plugin") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot ".claude") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $opencodeHome ".claude") | Out-Null
New-Item -ItemType Directory -Force $logRoot | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "src") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\omo-plan") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot ".sisyphus\plans") | Out-Null

$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if ($gitCommand) {
  & $gitCommand.Source -C $workRoot init -q
} else {
  New-Item -ItemType Directory -Force (Join-Path $workRoot ".git") | Out-Null
}

Set-Content -LiteralPath (Join-Path $workRoot "src\app.ts") -Value @"
export function existingFeature() {
  return "before-$marker"
}
"@ -NoNewline

Set-Content -LiteralPath (Join-Path $workRoot "sdd\changes\omo-plan\design.md") -Value @"
# Design

The current implementation only exposes existingFeature and has no OMO plan delegated feature.
"@ -NoNewline

Set-Content -LiteralPath (Join-Path $workRoot "sdd\changes\omo-plan\tasks.md") -Value @"
# Tasks

- [ ] Add the OMO plan delegated feature when implementation exists.
"@ -NoNewline

Set-Content -LiteralPath (Join-Path $workRoot ".opencode\plugin\oh-my-opencode.ts") -Value 'export { default } from "oh-my-opencode"' -NoNewline

$config = Get-Content -LiteralPath $configTemplate -Raw
if ($Provider -eq "minimax") {
  $config = $config -replace "https://api\.minimax(?:i)?\.com/v1", $minimaxBaseUrl.TrimEnd("/")
}

function Set-DefaultAgentInConfig {
  param(
    [string]$ConfigText,
    [string]$DefaultAgent
  )
  if ($ConfigText -match '"default_agent"\s*:') {
    return $ConfigText -replace '"default_agent"\s*:\s*"[^"]+"', ('"default_agent": "' + $DefaultAgent + '"')
  }
  return $ConfigText -replace '(\{\s*)', ('${1}"default_agent": "' + $DefaultAgent + '",')
}

$planConfig = Set-DefaultAgentInConfig -ConfigText $config -DefaultAgent "prometheus"
$workConfig = Set-DefaultAgentInConfig -ConfigText $config -DefaultAgent "sisyphus"
Set-Content -LiteralPath (Join-Path $workRoot ".opencode\opencode.jsonc") -Value $planConfig -NoNewline

$ohmyConfig = @"
{
  "`$schema": "../node_modules/oh-my-opencode/schema.json",
  "sisyphus_agent": {
    "disabled": false,
    "planner_enabled": true,
    "default_builder_enabled": true,
    "replace_plan": true
  },
  "experimental": {
    "disable_omo_env": true
  },
  "agents": {
    "sisyphus": { "model": "$modelName", "temperature": 0, "steps": 24 },
    "prometheus": {
      "model": "$modelName",
      "temperature": 0,
      "steps": 24,
      "tools": { "question": false },
      "prompt_append": "Automated E2E mode: high accuracy / Momus review is disabled. Do not call the question tool. Do not ask whether to run high accuracy review. After writing the requested plan file and a brief summary, finish."
    },
    "sisyphus-junior": { "model": "$modelName", "temperature": 0, "steps": 24 },
    "atlas": { "model": "$modelName", "temperature": 0, "steps": 24 },
    "hephaestus": { "model": "$modelName", "temperature": 0, "steps": 24 },
    "metis": {
      "model": "$modelName",
      "temperature": 0,
      "steps": 12,
      "tools": { "question": false },
      "prompt_append": "Automated E2E mode: do not call the question tool and do not ask clarifying questions. Treat the caller's requirements as complete and return concise findings only."
    },
    "plan": {
      "model": "$modelName",
      "temperature": 0,
      "steps": 24,
      "tools": { "question": false },
      "prompt_append": "Automated E2E mode: high accuracy / Momus review is disabled. Do not call the question tool. Do not ask whether to run high accuracy review. After writing the requested plan file and a brief summary, finish."
    }
  },
  "categories": {
    "quick": { "model": "$modelName" },
    "unspecified-low": { "model": "$modelName" },
    "unspecified-high": { "model": "$modelName" },
    "deep": { "model": "$modelName" }
  },
  "disabled_hooks": [
    "startup-toast",
    "auto-update-checker",
    "session-notification",
    "background-notification",
    "context-window-monitor",
    "preemptive-compaction",
    "tool-output-truncator",
    "question-label-truncator",
    "directory-agents-injector",
    "directory-readme-injector",
    "agent-usage-reminder",
    "category-skill-reminder",
    "interactive-bash-session",
    "runtime-fallback",
    "legacy-plugin-toast"
  ],
  "disabled_mcps": ["context7", "grep-app"],
  "claude_code": {
    "commands": false,
    "skills": false,
    "agents": false,
    "mcp": false,
    "plugins": false,
    "hooks": true
  }
}
"@
Set-Content -LiteralPath (Join-Path $workRoot ".opencode\oh-my-openagent.jsonc") -Value $ohmyConfig -NoNewline

$settings = @"
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node $hookPath" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit|read|edit|write|multiedit|multi_edit|Task|task|call_omo_agent|background_output|delegate_task",
        "hooks": [
          { "type": "command", "command": "node $hookPath" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node $hookPath" }
        ]
      }
    ]
  }
}
"@
Set-Content -LiteralPath (Join-Path $workRoot ".claude\settings.json") -Value $settings -NoNewline
Set-Content -LiteralPath (Join-Path $opencodeHome ".claude\settings.json") -Value $settings -NoNewline

$rootConfigHadFile = Test-Path -LiteralPath $rootConfigPath
$rootOhmyHadFile = Test-Path -LiteralPath $rootOhmyConfigPath
$rootSettingsHadFile = Test-Path -LiteralPath $rootSettingsPath
if ($rootConfigHadFile) { Copy-Item -LiteralPath $rootConfigPath -Destination $rootConfigBackupPath -Force }
if ($rootOhmyHadFile) { Copy-Item -LiteralPath $rootOhmyConfigPath -Destination $rootOhmyBackupPath -Force }
if ($rootSettingsHadFile) { Copy-Item -LiteralPath $rootSettingsPath -Destination $rootSettingsBackupPath -Force }
New-Item -ItemType Directory -Force (Split-Path -Parent $rootConfigPath) | Out-Null
New-Item -ItemType Directory -Force (Split-Path -Parent $rootOhmyConfigPath) | Out-Null
New-Item -ItemType Directory -Force (Split-Path -Parent $rootSettingsPath) | Out-Null
Set-Content -LiteralPath $rootConfigPath -Value $planConfig -NoNewline
Set-Content -LiteralPath $rootOhmyConfigPath -Value $ohmyConfig -NoNewline
Set-Content -LiteralPath $rootSettingsPath -Value $settings -NoNewline

$previousHome = $env:HOME
$previousUserProfile = $env:USERPROFILE
$previousPath = $env:PATH
$previousClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
$previousClaudeSettingsPath = $env:CLAUDE_SETTINGS_PATH
$previousOutputMode = $env:SDD_DRIFT_OUTPUT
$previousLogRetention = $env:SDD_DRIFT_LOG_RETENTION_DAYS
$previousReminderCount = $env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS
$env:HOME = $opencodeHome
$env:USERPROFILE = $opencodeHome
$env:CLAUDE_CONFIG_DIR = Join-Path $opencodeHome ".claude"
$env:CLAUDE_SETTINGS_PATH = Join-Path $opencodeHome ".claude\settings.json"
$rgCommand = Get-Command rg -ErrorAction SilentlyContinue
if ($rgCommand) {
  $rgDir = Split-Path -Parent $rgCommand.Source
  if ($env:PATH -notlike "*$rgDir*") {
    $env:PATH = "$rgDir;$env:PATH"
  }
}
$env:SDD_DRIFT_OUTPUT = "opencode"
$env:SDD_DRIFT_LOG_RETENTION_DAYS = "3"
$env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = "1"

$planPrompt = @"
Use the OMO Prometheus/plan workflow now. Requirements are complete; do not ask questions.
This is a non-interactive automated E2E run. Do not ask about high accuracy review or Momus review; skip that optional review and finish after the plan file is written.
Only inspect files under the current isolated worktree. Do not read parent directories, repository-level test logs, provider config, or plugin source.
Create exactly this plan file: .sisyphus/plans/omo-sdd-delegated-code.md
The plan must contain exactly one implementation task.
The task must instruct Sisyphus to delegate code writing through task(subagent_type="quick", run_in_background=false, load_skills=[], ...), not to edit code in the main session.
The delegated task must create src/omoPlanDelegated.ts exporting function omoPlanDelegated() that returns "$marker".
The task must not edit sdd/changes/omo-plan/design.md or tasks.md unless an SDD drift reminder explicitly asks for review or synchronization after code is changed.
Keep the plan concise and then finish.
"@

$workPrompt = @"
/start-work .sisyphus/plans/omo-sdd-delegated-code.md
"@

if ($SeedPlan) {
  Set-Content -LiteralPath $planFile -Value @"
# OMO SDD Delegated Code Plan

## Goal

Validate that OpenCode + oh-my-opencode `/start-work` can delegate code writing
through the `task` tool and that the SDD drift hook observes the child edit.

## TODOs

- [ ] 1. Delegate creation of `src/omoPlanDelegated.ts`

  **What to do**:
  - In the main Sisyphus session, call `task(subagent_type="quick", run_in_background=false, load_skills=[], ...)`.
  - The delegated quick subagent must create `src/omoPlanDelegated.ts`.
  - The file must export `function omoPlanDelegated()` returning `"$marker"`.
  - The delegated subagent final answer must include:
    ```text
    Files changed:
    - src/omoPlanDelegated.ts
    ```
  - Do not use Edit, Write, or MultiEdit in the main Sisyphus session for the code file.
  - After the task result returns, follow any SDD drift reminder by reading and synchronizing `sdd/changes/omo-plan/design.md` and `sdd/changes/omo-plan/tasks.md`.

  **Acceptance Criteria**:
  - `src/omoPlanDelegated.ts` exists.
  - It exports `omoPlanDelegated()`.
  - `omoPlanDelegated()` returns `"$marker"`.
  - `design.md` and `tasks.md` are synchronized if the hook asks for SDD review.
"@ -NoNewline
}

$planExit = 0
$workExit = 0
try {
  Push-Location $workRoot
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      if ($SeedPlan) {
        $planExit = 0
        Set-Content -LiteralPath $outPlanLog -Value "Seeded plan file: $planFile" -NoNewline
        Set-Content -LiteralPath $errPlanLog -Value "" -NoNewline
      } else {
        & $opencodeBin run --print-logs --log-level DEBUG --format json --dir $workRoot $planPrompt > $outPlanLog 2> $errPlanLog
        $planExit = $LASTEXITCODE
      }
      if ($planExit -eq 0) {
        Set-Content -LiteralPath (Join-Path $workRoot ".opencode\opencode.jsonc") -Value $workConfig -NoNewline
        Set-Content -LiteralPath $rootConfigPath -Value $workConfig -NoNewline
        & $opencodeBin run --print-logs --log-level DEBUG --format json --dir $workRoot $workPrompt > $outWorkLog 2> $errWorkLog
        $workExit = $LASTEXITCODE
      }
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
  } finally {
    Pop-Location
  }
} finally {
  $env:HOME = $previousHome
  $env:USERPROFILE = $previousUserProfile
  $env:PATH = $previousPath
  if ($null -eq $previousClaudeConfigDir) { Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:CLAUDE_CONFIG_DIR = $previousClaudeConfigDir }
  if ($null -eq $previousClaudeSettingsPath) { Remove-Item Env:\CLAUDE_SETTINGS_PATH -ErrorAction SilentlyContinue } else { $env:CLAUDE_SETTINGS_PATH = $previousClaudeSettingsPath }
  if ($null -eq $previousOutputMode) { Remove-Item Env:\SDD_DRIFT_OUTPUT -ErrorAction SilentlyContinue } else { $env:SDD_DRIFT_OUTPUT = $previousOutputMode }
  if ($null -eq $previousLogRetention) { Remove-Item Env:\SDD_DRIFT_LOG_RETENTION_DAYS -ErrorAction SilentlyContinue } else { $env:SDD_DRIFT_LOG_RETENTION_DAYS = $previousLogRetention }
  if ($null -eq $previousReminderCount) { Remove-Item Env:\SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS -ErrorAction SilentlyContinue } else { $env:SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS = $previousReminderCount }
  if ($rootConfigHadFile -and (Test-Path -LiteralPath $rootConfigBackupPath)) {
    Copy-Item -LiteralPath $rootConfigBackupPath -Destination $rootConfigPath -Force
  } elseif (!$rootConfigHadFile -and (Test-Path -LiteralPath $rootConfigPath)) {
    Remove-Item -LiteralPath $rootConfigPath -Force
  }
  if ($rootOhmyHadFile -and (Test-Path -LiteralPath $rootOhmyBackupPath)) {
    Copy-Item -LiteralPath $rootOhmyBackupPath -Destination $rootOhmyConfigPath -Force
  } elseif (!$rootOhmyHadFile -and (Test-Path -LiteralPath $rootOhmyConfigPath)) {
    Remove-Item -LiteralPath $rootOhmyConfigPath -Force
  }
  if ($rootSettingsHadFile -and (Test-Path -LiteralPath $rootSettingsBackupPath)) {
    Copy-Item -LiteralPath $rootSettingsBackupPath -Destination $rootSettingsPath -Force
  } elseif (!$rootSettingsHadFile -and (Test-Path -LiteralPath $rootSettingsPath)) {
    Remove-Item -LiteralPath $rootSettingsPath -Force
  }
}

function Get-DiagnosticLogPath {
  param([string]$Worktree)
  $gitLog = Join-Path $Worktree ".git\sdd-drift-hook-state\sdd-drift-check.log.jsonl"
  if (Test-Path -LiteralPath $gitLog) { return $gitLog }
  return Join-Path $Worktree ".sdd-drift-hook-state\sdd-drift-check.log.jsonl"
}

$diagLog = Get-DiagnosticLogPath -Worktree $workRoot
$createdCode = Join-Path $workRoot "src\omoPlanDelegated.ts"
$design = Join-Path $workRoot "sdd\changes\omo-plan\design.md"
$tasks = Join-Path $workRoot "sdd\changes\omo-plan\tasks.md"

$diagText = if (Test-Path -LiteralPath $diagLog) { Get-Content -LiteralPath $diagLog -Raw } else { "" }
$workOut = if (Test-Path -LiteralPath $outWorkLog) { Get-Content -LiteralPath $outWorkLog -Raw } else { "" }
$workErr = if (Test-Path -LiteralPath $errWorkLog) { Get-Content -LiteralPath $errWorkLog -Raw } else { "" }

$taskToolObserved = ($workOut + "`n" + $workErr + "`n" + $diagText) -match "(?i)(tool_name|tool).*?(task|call_omo_agent|delegate_task)|Task Result|call_omo_agent"
$hookTriggered = $diagText -match '"event":"hook_start"'
$childCodeEnforced = $diagText -match "emit_code_enforcement"
$subagentEnforced = $diagText -match "emit_subagent_checkpoint_enforcement"
$checkpointHydrated = $diagText -match "hydratedFromCheckpointOutput.{0,20}true"
$sddReminderVisible = $workOut -match "SDD drift" -or $workErr -match "SDD drift"
$designText = if (Test-Path -LiteralPath $design) { Get-Content -LiteralPath $design -Raw } else { "" }
$tasksText = if (Test-Path -LiteralPath $tasks) { Get-Content -LiteralPath $tasks -Raw } else { "" }
$sddDocsUpdated = $designText.Contains($marker) -and ($tasksText -match "\[x\]")

Write-Output "WORK_ROOT=$workRoot"
Write-Output "PLAN_EXIT=$planExit"
Write-Output "WORK_EXIT=$workExit"
Write-Output "PLAN_FILE_EXISTS=$(Test-Path -LiteralPath $planFile)"
Write-Output "CODE_FILE_EXISTS=$(Test-Path -LiteralPath $createdCode)"
Write-Output "TASK_TOOL_OBSERVED=$taskToolObserved"
Write-Output "HOOK_TRIGGERED=$hookTriggered"
Write-Output "CHILD_CODE_ENFORCED=$childCodeEnforced"
Write-Output "SUBAGENT_ENFORCED=$subagentEnforced"
Write-Output "CHECKPOINT_HYDRATED=$checkpointHydrated"
Write-Output "SDD_REMINDER_VISIBLE=$sddReminderVisible"
Write-Output "SDD_DOCS_UPDATED=$sddDocsUpdated"
Write-Output "DIAG_LOG=$diagLog"
Write-Output "--- design.md ---"
if (Test-Path -LiteralPath $design) { Get-Content -LiteralPath $design }
Write-Output "--- tasks.md ---"
if (Test-Path -LiteralPath $tasks) { Get-Content -LiteralPath $tasks }
Write-Output "--- diagnostic tail ---"
if (Test-Path -LiteralPath $diagLog) { Get-Content -LiteralPath $diagLog -Tail 20 }
Write-Output "--- work stderr tail ---"
if (Test-Path -LiteralPath $errWorkLog) { Get-Content -LiteralPath $errWorkLog -Tail 80 }

if ($planExit -ne 0) { exit $planExit }
if ($workExit -ne 0) { exit $workExit }
if (!(Test-Path -LiteralPath $createdCode)) { throw "expected delegated code file was not created: $createdCode" }
if (!$taskToolObserved) { throw "expected OMO task/call_omo_agent tool use was not observed" }
if (!$hookTriggered) { throw "expected SDD hook diagnostics were not recorded" }
if (!($subagentEnforced -or $childCodeEnforced)) { throw "expected SDD enforcement from child write or parent checkpoint" }
if (!$checkpointHydrated) { throw "expected checkpoint output/mtime hydration to record child code edit" }
if (!$sddDocsUpdated) { throw "expected design.md and tasks.md to be synchronized with the delegated code marker" }
