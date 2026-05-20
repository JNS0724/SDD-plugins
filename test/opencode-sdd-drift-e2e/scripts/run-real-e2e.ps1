param(
  [ValidateSet("deepseek", "minimax")]
  [string]$Provider = "deepseek",

  [ValidateSet("design-cascade", "code-cascade", "multi-code-cascade", "multi-change-review", "code-no-doc-change", "design-no-peer", "proposal-no-peer", "dts-code", "no-sdd-code")]
  [string]$Scenario = "design-cascade",

  [ValidateSet("stop-only", "posttooluse-and-stop")]
  [string]$HookMode = "stop-only"
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $root)
$runId = [guid]::NewGuid().ToString("N")
$workRoot = Join-Path $root ".real-workspaces\$Provider-$runId"
$opencodeHome = Join-Path $workRoot ".home"
$outLog = Join-Path $workRoot "$Provider-real.out.log"
$errLog = Join-Path $workRoot "$Provider-real.err.log"
$report = Join-Path $workRoot ".sdd-drift-report.md"
$hookState = Join-Path $repoRoot ".git\sdd-drift-hook-state"
$configPath = Join-Path $root ".opencode\opencode.jsonc"
$configBackupPath = Join-Path $root ".opencode\opencode.real-backup.tmp"
$configTemplate = Join-Path $root ".opencode\opencode.$Provider.jsonc.example"
$ohmyConfigPath = Join-Path $root ".opencode\oh-my-openagent.jsonc"
$ohmyBackupPath = Join-Path $root ".opencode\oh-my-openagent.real-backup.tmp"
$settingsPath = Join-Path $root ".claude\settings.json"
$settingsBackupPath = Join-Path $root ".claude\settings.real-backup.tmp"
$hookPath = (Join-Path $repoRoot "plugins\sdd-drift-check\sdd-drift-check-hook.js").Replace("\", "/")

if (!(Test-Path -LiteralPath $configTemplate)) {
  throw "missing provider config template: $configTemplate"
}
if (Test-Path -LiteralPath $configBackupPath) {
  throw "opencode real e2e config backup already exists; another run may be active: $configBackupPath"
}
if (Test-Path -LiteralPath $ohmyBackupPath) {
  throw "oh-my-opencode real e2e config backup already exists; another run may be active: $ohmyBackupPath"
}
if (Test-Path -LiteralPath $settingsBackupPath) {
  throw "Claude-compatible hook settings real e2e backup already exists; another run may be active: $settingsBackupPath"
}

if ($Provider -eq "deepseek" -and !$env:DEEPSEEK_API_KEY) {
  $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
  if (!$env:DEEPSEEK_API_KEY) {
    $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "Machine")
  }
}
if ($Provider -eq "minimax" -and !$env:MINIMAX_API_KEY) {
  $env:MINIMAX_API_KEY = [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "User")
  if (!$env:MINIMAX_API_KEY) {
    $env:MINIMAX_API_KEY = [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "Machine")
  }
}

$keyName = if ($Provider -eq "deepseek") { "DEEPSEEK_API_KEY" } else { "MINIMAX_API_KEY" }
$keyValue = [Environment]::GetEnvironmentVariable($keyName, "Process")
if (!$keyValue) {
  throw "$keyName is not set in process or User environment"
}
$trimmedKey = $keyValue.Trim()
if (
  !$trimmedKey -or
  $trimmedKey -match "your|replace|placeholder|example|dummy|test-key|api-key|apikey|你的|密钥|示例|占位"
) {
  throw "$keyName still looks like a placeholder; configure a real provider key before running real e2e"
}

function Set-ContentWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,

    [AllowNull()]
    [string]$Value,

    [switch]$NoNewline,

    [int]$Retries = 20
  )

  for ($attempt = 0; $attempt -le $Retries; $attempt++) {
    try {
      if ($NoNewline) {
        Set-Content -LiteralPath $LiteralPath -Value $Value -NoNewline
      } else {
        Set-Content -LiteralPath $LiteralPath -Value $Value
      }
      return
    } catch [System.IO.IOException] {
      if ($attempt -eq $Retries) {
        throw
      }
      Start-Sleep -Milliseconds 250
    }
  }
}

$minimaxBaseUrl = $null
if ($Provider -eq "minimax") {
  $minimaxBaseUrl = [Environment]::GetEnvironmentVariable("MINIMAX_BASE_URL", "Process")
  if (!$minimaxBaseUrl) {
    $minimaxBaseUrl = [Environment]::GetEnvironmentVariable("MINIMAX_BASE_URL", "User")
  }
  if (!$minimaxBaseUrl) {
    $minimaxBaseUrl = [Environment]::GetEnvironmentVariable("MINIMAX_BASE_URL", "Machine")
  }
  if (!$minimaxBaseUrl) {
    $minimaxBaseUrl = "https://api.minimaxi.com/v1"
  }
}

New-Item -ItemType Directory -Force (Join-Path $workRoot ".opencode\plugin") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot ".claude") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $opencodeHome ".claude") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "src") | Out-Null
$hasSddWorkspace = $Scenario -ne "no-sdd-code"
if ($hasSddWorkspace) {
  New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\test-feat") | Out-Null
  if ($Scenario -eq "multi-change-review") {
    New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\parallel-feat") | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\archived-feat") | Out-Null
  }
}

Set-Content -LiteralPath (Join-Path $workRoot ".opencode\plugin\oh-my-opencode.ts") -Value 'export { default } from "oh-my-opencode"'

$ohmyConfig = @'
{
  "$schema": "../node_modules/oh-my-opencode/schema.json",
  "sisyphus_agent": {
    "disabled": true
  },
  "experimental": {
    "disable_omo_env": true
  },
  "disabled_agents": [
    "sisyphus",
    "hephaestus",
    "prometheus",
    "atlas",
    "sisyphus-junior"
  ],
  "disabled_hooks": [
    "atlas",
    "ralph-loop",
    "start-work",
    "todo-continuation-enforcer",
    "context-window-monitor",
    "session-recovery",
    "session-notification",
    "comment-checker",
    "tool-output-truncator",
    "question-label-truncator",
    "directory-agents-injector",
    "directory-readme-injector",
    "empty-task-response-detector",
    "think-mode",
    "model-fallback",
    "anthropic-context-window-limit-recovery",
    "preemptive-compaction",
    "rules-injector",
    "background-notification",
    "auto-update-checker",
    "startup-toast",
    "keyword-detector",
    "agent-usage-reminder",
    "non-interactive-env",
    "interactive-bash-session",
    "thinking-block-validator",
    "tool-pair-validator",
    "category-skill-reminder",
    "compaction-context-injector",
    "compaction-todo-preserver",
    "auto-slash-command",
    "edit-error-recovery",
    "json-error-recovery",
    "delegate-task-retry",
    "prometheus-md-only",
    "sisyphus-junior-notepad",
    "no-sisyphus-gpt",
    "no-hephaestus-non-gpt",
    "unstable-agent-babysitter",
    "task-resume-info",
    "stop-continuation-guard",
    "tasks-todowrite-disabler",
    "runtime-fallback",
    "write-existing-file-guard",
    "bash-file-read-guard",
    "anthropic-effort",
    "hashline-read-enhancer",
    "read-image-resizer",
    "todo-description-override",
    "webfetch-redirect-guard",
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
'@
Set-Content -LiteralPath (Join-Path $workRoot ".opencode\oh-my-openagent.jsonc") -Value $ohmyConfig -NoNewline

$hooksJson = if ($HookMode -eq "posttooluse-and-stop") {
  @"
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit|read|edit|write|multiedit|multi_edit|Task|task|call_omo_agent|background_output|delegate_task",
        "hooks": [
          {
            "type": "command",
            "command": "node $hookPath"
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
            "command": "node $hookPath"
          }
        ]
      }
    ]
"@
} else {
  @"
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node $hookPath"
          }
        ]
      }
    ]
"@
}

$settings = @"
{
  "hooks": {
$hooksJson
  }
}
"@
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot ".claude\settings.json") -Value $settings -NoNewline

$config = Get-Content -LiteralPath $configTemplate -Raw
if ($Provider -eq "minimax") {
  $config = $config -replace "https://api\.minimax(?:i)?\.com/v1", $minimaxBaseUrl.TrimEnd("/")
}
$restrictedPermission = @'
"permission": {
  "read": "allow",
  "edit": "allow",
  "bash": "deny",
  "glob": "deny",
  "grep": "deny",
  "task": "deny",
  "question": "deny",
  "webfetch": "deny",
  "websearch": "deny",
  "todowrite": "deny",
  "todoread": "deny",
  "external_directory": "deny"
}
'@
$config = $config -replace '"permission"\s*:\s*"allow"', $restrictedPermission

$configHadFile = Test-Path -LiteralPath $configPath
$configBackup = if ($configHadFile) {
  Get-Content -LiteralPath $configPath -Raw
} else {
  $null
}
$ohmyHadFile = Test-Path -LiteralPath $ohmyConfigPath
$ohmyBackup = if ($ohmyHadFile) {
  Get-Content -LiteralPath $ohmyConfigPath -Raw
} else {
  $null
}
$settingsHadFile = Test-Path -LiteralPath $settingsPath
$settingsBackup = if ($settingsHadFile) {
  Get-Content -LiteralPath $settingsPath -Raw
} else {
  $null
}
Set-ContentWithRetry -LiteralPath $configBackupPath -Value $configBackup -NoNewline
Set-ContentWithRetry -LiteralPath $configPath -Value $config -NoNewline
Set-ContentWithRetry -LiteralPath $ohmyBackupPath -Value $ohmyBackup -NoNewline
Set-ContentWithRetry -LiteralPath $ohmyConfigPath -Value $ohmyConfig -NoNewline
Set-ContentWithRetry -LiteralPath $settingsBackupPath -Value $settingsBackup -NoNewline
Set-ContentWithRetry -LiteralPath $settingsPath -Value $settings -NoNewline

if (Test-Path -LiteralPath $hookState) {
  Get-ChildItem -LiteralPath $hookState -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

$proposalPath = Join-Path $workRoot "sdd\changes\test-feat\proposal.md"
$designPath = Join-Path $workRoot "sdd\changes\test-feat\design.md"
$tasksPath = Join-Path $workRoot "sdd\changes\test-feat\tasks.md"
$parallelProposalPath = Join-Path $workRoot "sdd\changes\parallel-feat\proposal.md"
$parallelDesignPath = Join-Path $workRoot "sdd\changes\parallel-feat\design.md"
$parallelTasksPath = Join-Path $workRoot "sdd\changes\parallel-feat\tasks.md"
$archivedProposalPath = Join-Path $workRoot "sdd\changes\archived-feat\proposal.md"
$archivedDesignPath = Join-Path $workRoot "sdd\changes\archived-feat\design.md"
$archivedTasksPath = Join-Path $workRoot "sdd\changes\archived-feat\tasks.md"
$archivedMarkerPath = Join-Path $workRoot "sdd\changes\archived-feat\.archived"
$appPath = Join-Path $workRoot "src\app.ts"
$helperPath = Join-Path $workRoot "src\helper.ts"
if ($hasSddWorkspace) {
  Set-Content -LiteralPath $proposalPath -Value "# Proposal`n`nInitial proposal."
  if ($Scenario -ne "proposal-no-peer") {
    Set-Content -LiteralPath $designPath -Value "# Design`n`nInitial design."
  }
  if ($Scenario -ne "proposal-no-peer" -and $Scenario -ne "design-no-peer") {
    Set-Content -LiteralPath $tasksPath -Value "# Tasks`n`n- [ ] Keep this file unchanged until SDD drift enforcement asks for synchronization."
  }
  if ($Scenario -eq "multi-change-review") {
    Set-Content -LiteralPath $parallelProposalPath -Value "# Proposal`n`nParallel proposal."
    Set-Content -LiteralPath $parallelDesignPath -Value "# Design`n`nParallel design."
    Set-Content -LiteralPath $parallelTasksPath -Value "# Tasks`n`n- [ ] Keep this parallel file unchanged until SDD drift enforcement asks for synchronization."
    Set-Content -LiteralPath $archivedProposalPath -Value "# Proposal`n`nArchived proposal."
    Set-Content -LiteralPath $archivedDesignPath -Value "# Design`n`nArchived design should stay unchanged."
    Set-Content -LiteralPath $archivedTasksPath -Value "# Tasks`n`n- [ ] Archived tasks should stay unchanged."
    Set-Content -LiteralPath $archivedMarkerPath -Value ""
  }
}
Set-Content -LiteralPath $appPath -Value "export function greet(name: string) {`n  return `"hello `" + name`n}"
Set-Content -LiteralPath $helperPath -Value "export function helper() {`n  return `"helper`"`n}"

$env:HOME = $opencodeHome
$env:USERPROFILE = $opencodeHome
$env:OMO_SEND_ANONYMOUS_TELEMETRY = "0"
$env:OMO_DISABLE_POSTHOG = "1"
$previousDtsContextExists = Test-Path Env:\SDD_DRIFT_DTS_CONTEXT
$previousDtsContext = $env:SDD_DRIFT_DTS_CONTEXT
if ($Scenario -eq "dts-code") {
  $env:SDD_DRIFT_DTS_CONTEXT = "1"
} else {
  Remove-Item Env:\SDD_DRIFT_DTS_CONTEXT -ErrorAction SilentlyContinue
}

$isCodeScenario = $Scenario -eq "code-cascade" -or $Scenario -eq "multi-code-cascade" -or $Scenario -eq "multi-change-review" -or $Scenario -eq "code-no-doc-change" -or $Scenario -eq "dts-code" -or $Scenario -eq "no-sdd-code"
$isCodeNoDocScenario = $Scenario -eq "dts-code" -or $Scenario -eq "no-sdd-code"
$isCodeReviewNoEditScenario = $Scenario -eq "code-no-doc-change"
$isNoPeerScenario = $Scenario -eq "design-no-peer" -or $Scenario -eq "proposal-no-peer"
$marker = if ($isCodeScenario) {
  "Real $Provider code drift verification $runId"
} elseif ($Scenario -eq "proposal-no-peer") {
  "Real $Provider proposal no peer verification $runId"
} elseif ($Scenario -eq "design-no-peer") {
  "Real $Provider design no peer verification $runId"
} else {
  "Real $Provider SDD drift verification $runId"
}
$isStopOnly = $HookMode -eq "stop-only"
$taskMarker = if ($isCodeScenario) {
  if ($isStopOnly) {
    "Synchronized after $Provider stop enforcement completed code design sync $runId"
  } else {
    "Synchronized after $Provider code drift design update $runId"
  }
} else {
  if ($isStopOnly) {
    "Synchronized after $Provider saw SDD drift stop enforcement $runId"
  } else {
    "Synchronized after $Provider saw SDD drift tool result enforcement $runId"
  }
}
$codeMarker = "hi-$Provider-$runId"
$helperMarker = "helper-$Provider-$runId"
$parallelMarker = "Real $Provider parallel SDD review $runId"
$parallelTaskMarker = "Synchronized parallel change after $Provider code drift review $runId"
$prompt = if ($isStopOnly -and $Scenario -eq "multi-change-review") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Initial pass: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. Then stop immediately with a brief final answer. Do not read or write any SDD document during the initial pass."
    "If a later hook continuation containing `"SDD drift stop enforcement`" asks you to review SDD documents, read sdd/changes/test-feat/design.md, sdd/changes/test-feat/tasks.md, sdd/changes/parallel-feat/design.md, and sdd/changes/parallel-feat/tasks.md."
    "When writing design.md files, preserve all existing non-empty body text such as Initial design. and Parallel design.; append the requested heading after the existing body."
    "Then write sdd/changes/test-feat/design.md so it contains this exact section heading: ## $marker."
    "Then write sdd/changes/test-feat/tasks.md so it contains this exact task line: - [x] $taskMarker."
    "Then write sdd/changes/parallel-feat/design.md so it contains this exact section heading: ## $parallelMarker."
    "Then write sdd/changes/parallel-feat/tasks.md so it contains this exact task line: - [x] $parallelTaskMarker."
    "Do not read or write any file under sdd/changes/archived-feat."
    "Use only read and write tools."
  ) -join " "
} elseif ($isStopOnly -and $isCodeScenario) {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Initial pass: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. Then stop immediately with a brief final answer. Do not read or write any SDD document during the initial pass."
    "If a later hook continuation containing `"SDD drift stop enforcement`" asks you to synchronize design.md, read sdd/changes/test-feat/design.md and write it so it contains this exact section heading: ## $marker."
    "If a later hook continuation asks you to synchronize tasks.md, read sdd/changes/test-feat/tasks.md and write it so it contains this exact task line: - [x] $taskMarker."
    "Use only read and write tools."
  ) -join " "
} elseif ($isStopOnly) {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Initial pass: 1. Read sdd/changes/test-feat/design.md."
    "2. Write sdd/changes/test-feat/design.md so it contains this exact section heading: ## $marker."
    "3. Then stop immediately with a brief final answer. Do not read or write sdd/changes/test-feat/tasks.md during the initial pass."
    "If a later hook continuation containing `"SDD drift stop enforcement`" asks you to synchronize peer documents, read sdd/changes/test-feat/tasks.md and write it so it contains this exact task line: - [x] $taskMarker."
    "Use only read and write tools."
  ) -join " "
} elseif ($Scenario -eq "proposal-no-peer") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Use this sequence: 1. Read sdd/changes/test-feat/proposal.md."
    "2. Write sdd/changes/test-feat/proposal.md so it contains this exact section heading: ## $marker."
    "3. Do not create, read, or write sdd/changes/test-feat/design.md."
    "4. Do not create, read, or write sdd/changes/test-feat/tasks.md."
    "Use only read and write tools. Finish after proposal.md is updated."
  ) -join " "
} elseif ($Scenario -eq "design-no-peer") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Use this sequence: 1. Read sdd/changes/test-feat/design.md."
    "2. Write sdd/changes/test-feat/design.md so it contains this exact section heading: ## $marker."
    "3. Do not create, read, or write sdd/changes/test-feat/tasks.md."
    "Use only read and write tools. Finish after design.md is updated."
  ) -join " "
} elseif ($Scenario -eq "no-sdd-code") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "This workspace intentionally has no sdd or .sdd directory."
    "Use this sequence: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. Do not create, read, or write any sdd or .sdd path."
    "Use only read and write tools. Finish after src/app.ts is updated."
  ) -join " "
} elseif ($Scenario -eq "dts-code") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "This is a DTS问题单 / DTS issue fix. For this validation, only code should change and SDD documents should not be updated."
    "Use this sequence: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. Do not read or write sdd/changes/test-feat/design.md."
    "4. Do not read or write sdd/changes/test-feat/tasks.md."
    "Use only read and write tools. Finish after src/app.ts is updated."
  ) -join " "
} elseif ($Scenario -eq "multi-change-review") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "This workspace has two active SDD changes and one archived SDD change."
    "Use this sequence exactly: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. Wait for the src/app.ts write tool result and inspect that tool result text."
    "4. If the src/app.ts write tool result contains `"SDD drift tool result enforcement`" or `"SDD reconciliation review`", read sdd/changes/test-feat/design.md."
    "5. Read sdd/changes/test-feat/tasks.md."
    "6. Read sdd/changes/parallel-feat/design.md."
    "7. Read sdd/changes/parallel-feat/tasks.md."
    "Before writing design.md files, preserve all existing non-empty body text such as Initial design. and Parallel design.; append the requested heading after the existing body."
    "8. Write sdd/changes/test-feat/design.md so it contains this exact section heading: ## $marker."
    "9. Write sdd/changes/test-feat/tasks.md so it contains this exact task line: - [x] $taskMarker."
    "10. Write sdd/changes/parallel-feat/design.md so it contains this exact section heading: ## $parallelMarker."
    "11. Write sdd/changes/parallel-feat/tasks.md so it contains this exact task line: - [x] $parallelTaskMarker."
    "12. Do not read or write any file under sdd/changes/archived-feat."
    "Use only read and write tools. Finish only after src/app.ts and all active design.md/tasks.md documents are synchronized."
  ) -join " "
} elseif ($Scenario -eq "code-no-doc-change") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Simulate a real development pass with multiple code-tool rounds before SDD review."
    "Use this sequence exactly: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker-phase-1`"."
    "3. Wait for the src/app.ts write tool result and inspect that tool result text, but do not review or edit SDD yet."
    "4. Read src/helper.ts."
    "5. Write src/helper.ts so it contains this exact string literal: `"$helperMarker`"."
    "6. Wait for the src/helper.ts write tool result and inspect that tool result text, but still do not review or edit SDD yet."
    "7. Read src/app.ts again."
    "8. Write src/app.ts so it contains this exact string literal: `"$codeMarker-final`"."
    "9. Wait for the final src/app.ts write tool result and inspect that tool result text."
    "10. If any code write tool result contains `"SDD drift tool result enforcement`" or `"SDD drift reminder`", read sdd/changes/test-feat/design.md."
    "11. Then read sdd/changes/test-feat/tasks.md."
    "12. After reviewing both SDD files, do not edit any SDD document because this validation intentionally needs no document change."
    "13. Finish with this exact sentence: SDD docs reviewed; no document edit needed."
    "Use only read and write tools. Do not write proposal.md, design.md, or tasks.md."
  ) -join " "
} elseif ($Scenario -eq "multi-code-cascade") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Use this sequence exactly: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. Wait for the src/app.ts write tool result, notice whether it contains `"SDD drift tool result enforcement`", but do not update any SDD document yet."
    "4. Read src/helper.ts."
    "5. Write src/helper.ts so it contains this exact string literal: `"$helperMarker`"."
    "6. Wait for the src/helper.ts write tool result and inspect it."
    "7. Now read sdd/changes/test-feat/design.md."
    "8. Write sdd/changes/test-feat/design.md so it contains this exact section heading: ## $marker."
    "9. Wait for the design.md write tool result and inspect that tool result text."
    "10. If the design.md write tool result contains `"SDD drift tool result enforcement`", read sdd/changes/test-feat/tasks.md."
    "11. Write sdd/changes/test-feat/tasks.md so it contains this exact task line: - [x] $taskMarker."
    "Use only read and write tools. Finish only after app.ts, helper.ts, design.md, and tasks.md are synchronized."
  ) -join " "
} elseif ($Scenario -eq "code-cascade") {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Use this sequence: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. Wait for the src/app.ts write tool result and inspect that tool result text."
    "4. If the src/app.ts write tool result contains `"SDD drift tool result enforcement`", read sdd/changes/test-feat/design.md."
    "5. Write sdd/changes/test-feat/design.md so it contains this exact section heading: ## $marker."
    "6. Wait for the design.md write tool result and inspect that tool result text."
    "7. If the design.md write tool result contains `"SDD drift tool result enforcement`", read sdd/changes/test-feat/tasks.md."
    "8. Write sdd/changes/test-feat/tasks.md so it contains this exact task line: - [x] $taskMarker."
    "Use only read and write tools. Finish only after src/app.ts, design.md, and tasks.md are synchronized."
  ) -join " "
} else {
  @(
    "Execute this exact local file-editing validation task now."
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Use this sequence: 1. Read sdd/changes/test-feat/design.md."
    "2. Write sdd/changes/test-feat/design.md so it contains this exact section heading: ## $marker."
    "3. Wait for the design.md write tool result and inspect that tool result text."
    "4. If the design.md write tool result contains `"SDD drift tool result enforcement`", read sdd/changes/test-feat/tasks.md."
    "5. Write sdd/changes/test-feat/tasks.md so it contains this exact task line: - [x] $taskMarker."
    "Use only read and write tools. Finish only after design.md and tasks.md are synchronized."
  ) -join " "
}

try {
  $runArgs = @("opencode", "run", "--print-logs", "--log-level", "DEBUG", "--agent", "sddtest", "--format", "json", "--dir", $workRoot, $prompt)
  Push-Location $root
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & npx.cmd @runArgs > $outLog 2> $errLog
    $opencodeExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
} finally {
  if ($previousDtsContextExists) {
    $env:SDD_DRIFT_DTS_CONTEXT = $previousDtsContext
  } else {
    Remove-Item Env:\SDD_DRIFT_DTS_CONTEXT -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $configBackupPath) {
    if ($configHadFile) {
      $restoreConfig = Get-Content -LiteralPath $configBackupPath -Raw
      Set-ContentWithRetry -LiteralPath $configPath -Value $restoreConfig -NoNewline
    } elseif (Test-Path -LiteralPath $configPath) {
      Remove-Item -LiteralPath $configPath -Force
    }
    Remove-Item -LiteralPath $configBackupPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $ohmyBackupPath) {
    if ($ohmyHadFile) {
      $restoreOhmyConfig = Get-Content -LiteralPath $ohmyBackupPath -Raw
      Set-ContentWithRetry -LiteralPath $ohmyConfigPath -Value $restoreOhmyConfig -NoNewline
    } elseif (Test-Path -LiteralPath $ohmyConfigPath) {
      Remove-Item -LiteralPath $ohmyConfigPath -Force
    }
    Remove-Item -LiteralPath $ohmyBackupPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $settingsBackupPath) {
    if ($settingsHadFile) {
      $restoreSettings = Get-Content -LiteralPath $settingsBackupPath -Raw
      Set-ContentWithRetry -LiteralPath $settingsPath -Value $restoreSettings -NoNewline
    } elseif (Test-Path -LiteralPath $settingsPath) {
      Remove-Item -LiteralPath $settingsPath -Force
    }
    Remove-Item -LiteralPath $settingsBackupPath -Force -ErrorAction SilentlyContinue
  }
}

Write-Output "OPENCODE_EXIT=$opencodeExit"
Write-Output "HOOK_MODE=$HookMode"
Write-Output "WORKROOT=$workRoot"
Write-Output "--- proposal.md ---"
if (Test-Path -LiteralPath $proposalPath) {
  Get-Content -LiteralPath $proposalPath
} else {
  Write-Output "<missing>"
}
Write-Output "--- design.md ---"
if (Test-Path -LiteralPath $designPath) {
  Get-Content -LiteralPath $designPath
} else {
  Write-Output "<missing>"
}
Write-Output "--- tasks.md ---"
if (Test-Path -LiteralPath $tasksPath) {
  Get-Content -LiteralPath $tasksPath
} else {
  Write-Output "<missing>"
}
if ($Scenario -eq "multi-change-review") {
  Write-Output "--- parallel design.md ---"
  Get-Content -LiteralPath $parallelDesignPath
  Write-Output "--- parallel tasks.md ---"
  Get-Content -LiteralPath $parallelTasksPath
  Write-Output "--- archived design.md ---"
  Get-Content -LiteralPath $archivedDesignPath
  Write-Output "--- archived tasks.md ---"
  Get-Content -LiteralPath $archivedTasksPath
}
Write-Output "--- src/app.ts ---"
Get-Content -LiteralPath $appPath
Write-Output "--- src/helper.ts ---"
Get-Content -LiteralPath $helperPath
Write-Output "--- .sdd-drift-report.md ---"
if (Test-Path -LiteralPath $report) {
  Get-Content -LiteralPath $report
} else {
  Write-Output "<missing>"
}
Write-Output "--- opencode stdout tail ---"
if (Test-Path -LiteralPath $outLog) {
  Get-Content -LiteralPath $outLog -Tail 80
}
Write-Output "--- opencode stderr tail ---"
if (Test-Path -LiteralPath $errLog) {
  Get-Content -LiteralPath $errLog -Tail 120
}

if ($opencodeExit -ne 0) {
  exit $opencodeExit
}

$proposalText = if (Test-Path -LiteralPath $proposalPath) { Get-Content -LiteralPath $proposalPath -Raw } else { "" }
$designText = if (Test-Path -LiteralPath $designPath) { Get-Content -LiteralPath $designPath -Raw } else { "" }
$tasksText = if (Test-Path -LiteralPath $tasksPath) { Get-Content -LiteralPath $tasksPath -Raw } else { "" }
$parallelDesignText = if (Test-Path -LiteralPath $parallelDesignPath) { Get-Content -LiteralPath $parallelDesignPath -Raw } else { "" }
$parallelTasksText = if (Test-Path -LiteralPath $parallelTasksPath) { Get-Content -LiteralPath $parallelTasksPath -Raw } else { "" }
$archivedDesignText = if (Test-Path -LiteralPath $archivedDesignPath) { Get-Content -LiteralPath $archivedDesignPath -Raw } else { "" }
$archivedTasksText = if (Test-Path -LiteralPath $archivedTasksPath) { Get-Content -LiteralPath $archivedTasksPath -Raw } else { "" }
$appText = Get-Content -LiteralPath $appPath -Raw
$helperText = Get-Content -LiteralPath $helperPath -Raw
$outText = if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Raw } else { "" }
$errText = if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Raw } else { "" }
$reportText = if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report -Raw } else { "" }

if ($Scenario -eq "proposal-no-peer") {
  if ($proposalText -notmatch [regex]::Escape($marker)) {
    throw "expected proposal.md to contain real model marker"
  }
  if (Test-Path -LiteralPath $designPath) {
    throw "expected design.md not to be created when proposal peer is absent"
  }
  if (Test-Path -LiteralPath $tasksPath) {
    throw "expected tasks.md not to be created when proposal peer is absent"
  }
} elseif (!$isCodeNoDocScenario -and !$isCodeReviewNoEditScenario -and $designText -notmatch [regex]::Escape($marker)) {
  throw "expected design.md to contain real model marker"
}
if ($isCodeScenario -and $appText -notmatch [regex]::Escape($codeMarker)) {
  throw "expected src/app.ts to contain real model code marker"
}
if (($Scenario -eq "multi-code-cascade" -or $Scenario -eq "code-no-doc-change") -and $helperText -notmatch [regex]::Escape($helperMarker)) {
  throw "expected src/helper.ts to contain real model helper marker"
}
if ($isNoPeerScenario) {
  if ($outText -match "SDD drift tool result enforcement") {
    throw "expected no peer enforcement when peer document is absent"
  }
  if ($outText -match "SDD proposal stage reminder") {
    throw "expected no proposal stage reminder when design.md is absent"
  }
  if ($Scenario -eq "design-no-peer" -and (Test-Path -LiteralPath $tasksPath)) {
    throw "expected tasks.md not to be created when it is absent"
  }
} elseif ($isCodeNoDocScenario) {
  if ($outText -match "SDD drift tool result enforcement") {
    throw "expected no SDD drift enforcement for $Scenario"
  }
  if ($outText -match "SDD reconciliation review is now pending") {
    throw "expected no code-ahead-of-doc review for $Scenario"
  }
  if ($Scenario -eq "no-sdd-code" -and (Test-Path -LiteralPath (Join-Path $workRoot "sdd"))) {
    throw "expected no sdd directory to be created"
  }
  if ($Scenario -eq "dts-code") {
    if ($designText -match [regex]::Escape($marker)) {
      throw "expected design.md not to be updated for DTS context"
    }
    if ($tasksText -match [regex]::Escape($taskMarker)) {
      throw "expected tasks.md not to be updated for DTS context"
    }
  }
} elseif ($HookMode -eq "stop-only") {
  if ($errText -notmatch "Stop hook returned block with inject_prompt") {
    throw "expected Stop hook to block and inject a continuation prompt"
  }
} elseif ($outText -notmatch "SDD drift tool result enforcement") {
  throw "expected OpenCode output to include SDD drift tool result enforcement"
}
if ($Scenario -eq "multi-code-cascade") {
  $codeEnforcementCount = [regex]::Matches(
    $outText,
    [regex]::Escape("SDD reconciliation review is now pending for this code-change batch")
  ).Count
  if ($codeEnforcementCount -ne 1) {
    throw "expected exactly one code drift enforcement for consecutive code edits, got $codeEnforcementCount"
  }
}
if ($Scenario -eq "multi-change-review") {
  if ($designText -notmatch "Initial design\.") {
    throw "expected test-feat/design.md to preserve existing design body text"
  }
  if ($parallelDesignText -notmatch "Parallel design\.") {
    throw "expected parallel-feat/design.md to preserve existing design body text"
  }
  if ($parallelDesignText -notmatch [regex]::Escape($parallelMarker)) {
    throw "expected parallel-feat/design.md to contain real model review marker"
  }
  if ($parallelTasksText -notmatch [regex]::Escape($parallelTaskMarker)) {
    throw "expected parallel-feat/tasks.md to contain real model review marker"
  }
  if ($archivedDesignText -notmatch "Archived design should stay unchanged") {
    throw "expected archived-feat/design.md to remain unchanged"
  }
  if ($archivedTasksText -notmatch "Archived tasks should stay unchanged") {
    throw "expected archived-feat/tasks.md to remain unchanged"
  }
  if ($archivedDesignText -match [regex]::Escape($marker) -or $archivedDesignText -match [regex]::Escape($parallelMarker)) {
    throw "expected archived-feat/design.md not to receive active review markers"
  }
  if ($archivedTasksText -match [regex]::Escape($taskMarker) -or $archivedTasksText -match [regex]::Escape($parallelTaskMarker)) {
    throw "expected archived-feat/tasks.md not to receive active review markers"
  }
}
if ($Scenario -eq "code-no-doc-change") {
  $codeEnforcementCount = [regex]::Matches(
    $outText,
    [regex]::Escape("SDD reconciliation review is now pending for this code-change batch")
  ).Count
  if ($codeEnforcementCount -ne 1) {
    throw "expected exactly one full code drift enforcement for no-doc-change, got $codeEnforcementCount"
  }
  $compactCodeReminderCount = [regex]::Matches(
    $outText,
    [regex]::Escape("implementation code still has pending SDD review for this code-change batch")
  ).Count
  if ($compactCodeReminderCount -ne 0) {
    throw "expected no compact code drift reminder with default single-reminder cap, got $compactCodeReminderCount"
  }
  if ($designText -match [regex]::Escape($marker)) {
    throw "expected design.md not to be updated when SDD review finds no document change is needed"
  }
  if ($tasksText -match [regex]::Escape($taskMarker)) {
    throw "expected tasks.md not to be updated when SDD review finds no document change is needed"
  }
  if ($reportText -notmatch "User confirmation recommended") {
    throw "expected no-edit SDD review to leave a human confirmation report"
  }
  if ($reportText -notmatch "src/app\.ts" -or $reportText -notmatch "src/helper\.ts") {
    throw "expected no-edit confirmation report to include all changed code files"
  }
}
if (!$isNoPeerScenario -and !$isCodeNoDocScenario -and !$isCodeReviewNoEditScenario -and $tasksText -notmatch [regex]::Escape($taskMarker)) {
  throw "expected tasks.md to contain real model synchronization marker"
}
if ($errText -match "\[sdd-drift-check\]") {
  throw "expected no hook stderr output by default"
}
if ($Scenario -ne "code-no-doc-change" -and $reportText.Trim().Length -gt 0) {
  throw "expected no drift report after successful real-model synchronization"
}
