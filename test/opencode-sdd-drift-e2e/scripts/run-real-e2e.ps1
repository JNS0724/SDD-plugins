param(
  [ValidateSet("deepseek", "minimax")]
  [string]$Provider = "deepseek",

  [ValidateSet("design-cascade", "code-cascade")]
  [string]$Scenario = "design-cascade"
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
$hookPath = (Join-Path $repoRoot "plugins\sdd-drift-check\sdd-drift-check-hook.cjs").Replace("\", "/")

if (!(Test-Path -LiteralPath $configTemplate)) {
  throw "missing provider config template: $configTemplate"
}
if (Test-Path -LiteralPath $configBackupPath) {
  throw "opencode real e2e config backup already exists; another run may be active: $configBackupPath"
}
if (Test-Path -LiteralPath $ohmyBackupPath) {
  throw "oh-my-opencode real e2e config backup already exists; another run may be active: $ohmyBackupPath"
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
New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\test-feat") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "src") | Out-Null

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

$settings = @"
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
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
  }
}
"@
Set-Content -LiteralPath (Join-Path $workRoot ".claude\settings.json") -Value $settings -NoNewline

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
Set-Content -LiteralPath $configBackupPath -Value $configBackup -NoNewline
Set-Content -LiteralPath $configPath -Value $config -NoNewline
Set-Content -LiteralPath $ohmyBackupPath -Value $ohmyBackup -NoNewline
Set-Content -LiteralPath $ohmyConfigPath -Value $ohmyConfig -NoNewline

if (Test-Path -LiteralPath $hookState) {
  Get-ChildItem -LiteralPath $hookState -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

$designPath = Join-Path $workRoot "sdd\changes\test-feat\design.md"
$tasksPath = Join-Path $workRoot "sdd\changes\test-feat\tasks.md"
$appPath = Join-Path $workRoot "src\app.ts"
Set-Content -LiteralPath $designPath -Value "# Design`n`nInitial design."
Set-Content -LiteralPath $tasksPath -Value "# Tasks`n`n- [ ] Keep this file unchanged until SDD drift enforcement asks for synchronization."
Set-Content -LiteralPath $appPath -Value "export function greet(name: string) {`n  return `"hello `" + name`n}"

$env:HOME = $opencodeHome
$env:USERPROFILE = $opencodeHome
$env:OMO_SEND_ANONYMOUS_TELEMETRY = "0"
$env:OMO_DISABLE_POSTHOG = "1"

$marker = if ($Scenario -eq "code-cascade") {
  "Real $Provider code drift verification $runId"
} else {
  "Real $Provider SDD drift verification $runId"
}
$taskMarker = if ($Scenario -eq "code-cascade") {
  "Synchronized after $Provider code drift design update $runId"
} else {
  "Synchronized after $Provider saw SDD drift tool result enforcement $runId"
}
$codeMarker = "hi-$Provider-$runId"
$prompt = if ($Scenario -eq "code-cascade") {
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
  if (Test-Path -LiteralPath $configBackupPath) {
    if ($configHadFile) {
      $restoreConfig = Get-Content -LiteralPath $configBackupPath -Raw
      Set-Content -LiteralPath $configPath -Value $restoreConfig -NoNewline
    } elseif (Test-Path -LiteralPath $configPath) {
      Remove-Item -LiteralPath $configPath -Force
    }
    Remove-Item -LiteralPath $configBackupPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $ohmyBackupPath) {
    if ($ohmyHadFile) {
      $restoreOhmyConfig = Get-Content -LiteralPath $ohmyBackupPath -Raw
      Set-Content -LiteralPath $ohmyConfigPath -Value $restoreOhmyConfig -NoNewline
    } elseif (Test-Path -LiteralPath $ohmyConfigPath) {
      Remove-Item -LiteralPath $ohmyConfigPath -Force
    }
    Remove-Item -LiteralPath $ohmyBackupPath -Force -ErrorAction SilentlyContinue
  }
}

Write-Output "OPENCODE_EXIT=$opencodeExit"
Write-Output "WORKROOT=$workRoot"
Write-Output "--- design.md ---"
Get-Content -LiteralPath $designPath
Write-Output "--- tasks.md ---"
Get-Content -LiteralPath $tasksPath
Write-Output "--- src/app.ts ---"
Get-Content -LiteralPath $appPath
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

$designText = Get-Content -LiteralPath $designPath -Raw
$tasksText = Get-Content -LiteralPath $tasksPath -Raw
$appText = Get-Content -LiteralPath $appPath -Raw
$outText = if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Raw } else { "" }
$errText = if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Raw } else { "" }
$reportText = if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report -Raw } else { "" }

if ($designText -notmatch [regex]::Escape($marker)) {
  throw "expected design.md to contain real model marker"
}
if ($Scenario -eq "code-cascade" -and $appText -notmatch [regex]::Escape($codeMarker)) {
  throw "expected src/app.ts to contain real model code marker"
}
if ($outText -notmatch "SDD drift tool result enforcement") {
  throw "expected OpenCode output to include SDD drift tool result enforcement"
}
if ($tasksText -notmatch [regex]::Escape($taskMarker)) {
  throw "expected tasks.md to contain real model synchronization marker"
}
if ($errText -match "\[sdd-drift-check\]") {
  throw "expected no hook stderr output by default"
}
if ($reportText.Trim().Length -gt 0) {
  throw "expected no drift report after successful real-model synchronization"
}
