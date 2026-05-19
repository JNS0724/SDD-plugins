param(
  [ValidateSet("deepseek", "minimax")]
  [string]$Provider = "deepseek",

  [ValidateSet("design-cascade", "code-cascade", "multi-code-cascade")]
  [string]$Scenario = "multi-code-cascade",

  [string]$ModelOverride = "",

  [int]$MaxTurns = 24
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Assert-RealValue {
  param(
    [string]$Name,
    [string]$Value
  )

  $trimmed = $Value.Trim()
  if (
    !$trimmed -or
    $trimmed -match "your|replace|placeholder|example|dummy|test-key|api-key|apikey|YOUR_|gateway\.example"
  ) {
    throw "$Name still looks like a placeholder; configure a real value before running Claude Code e2e"
  }
}

function Count-HookResponsesContaining {
  param(
    [string]$LogText,
    [string]$Needle
  )

  $count = 0
  foreach ($line in ($LogText -split "`r?`n")) {
    if (!$line.Trim()) {
      continue
    }

    try {
      $event = $line | ConvertFrom-Json -ErrorAction Stop
    } catch {
      continue
    }

    if ($event.type -ne "system" -or $event.subtype -ne "hook_response") {
      continue
    }

    $output = [string]$event.output
    $stdout = [string]$event.stdout
    if ($output.Contains($Needle) -or $stdout.Contains($Needle)) {
      $count += 1
    }
  }

  return $count
}

$root = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $root)
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (!$claude) {
  throw "Claude Code CLI was not found on PATH. Install/configure Claude Code, then run this script again."
}

$providerConfig = Join-Path $root ".claude\providers\$Provider.local.ps1"
if (!(Test-Path -LiteralPath $providerConfig)) {
  throw "Missing provider config: $providerConfig. Copy the matching .example file to .local.ps1 and fill it first."
}
. $providerConfig

if (!$env:ANTHROPIC_BASE_URL) {
  throw "ANTHROPIC_BASE_URL is not set by $providerConfig"
}
if (!$env:ANTHROPIC_AUTH_TOKEN -and !$env:ANTHROPIC_API_KEY) {
  throw "Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in $providerConfig"
}
if (!$env:ANTHROPIC_MODEL) {
  throw "ANTHROPIC_MODEL is not set by $providerConfig"
}
if ($ModelOverride.Trim()) {
  $env:ANTHROPIC_MODEL = $ModelOverride.Trim()
}

Assert-RealValue "ANTHROPIC_BASE_URL" $env:ANTHROPIC_BASE_URL
if ($env:ANTHROPIC_AUTH_TOKEN) {
  Assert-RealValue "ANTHROPIC_AUTH_TOKEN" $env:ANTHROPIC_AUTH_TOKEN
}
if ($env:ANTHROPIC_API_KEY) {
  Assert-RealValue "ANTHROPIC_API_KEY" $env:ANTHROPIC_API_KEY
}
Assert-RealValue "ANTHROPIC_MODEL" $env:ANTHROPIC_MODEL

if (!$env:ANTHROPIC_CUSTOM_MODEL_OPTION) {
  $env:ANTHROPIC_CUSTOM_MODEL_OPTION = $env:ANTHROPIC_MODEL
}
if (!$env:ANTHROPIC_CUSTOM_MODEL_OPTION_NAME) {
  $env:ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = "$Provider via gateway"
}

$runId = [guid]::NewGuid().ToString("N")
$workRoot = Join-Path $root ".real-workspaces\$Provider-$runId"
$outLog = Join-Path $workRoot "$Provider-claude-real.out.log"
$errLog = Join-Path $workRoot "$Provider-claude-real.err.log"
$report = Join-Path $workRoot ".sdd-drift-report.md"
$hookState = Join-Path $repoRoot ".git\sdd-drift-hook-state"
$hookScript = Join-Path $repoRoot "plugins\sdd-drift-check\sdd-drift-check-hook.js"

New-Item -ItemType Directory -Force (Join-Path $workRoot ".claude\hooks") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\test-feat") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "src") | Out-Null

Copy-Item -LiteralPath (Join-Path $root ".claude\hooks\sdd-drift-check.js") -Destination (Join-Path $workRoot ".claude\hooks\sdd-drift-check.js") -Force
Copy-Item -LiteralPath (Join-Path $root "CLAUDE.md") -Destination (Join-Path $workRoot "CLAUDE.md") -Force

$settingsObject = [ordered]@{
  env = [ordered]@{
    SDD_DRIFT_HOOK_SCRIPT = $hookScript
  }
  permissions = [ordered]@{
    defaultMode = "acceptEdits"
    allow = @("Read", "Write", "Edit", "MultiEdit")
    deny = @(
      "Bash",
      "Task",
      "WebFetch",
      "WebSearch",
      "Read(./.claude/providers/*.local.ps1)",
      "Read(./.claude/providers/*.local.env)",
      "Read(./.real-workspaces/**)"
    )
  }
  hooks = [ordered]@{
    UserPromptSubmit = @(
      [ordered]@{
        hooks = @(
          [ordered]@{
            type = "command"
            command = "node .claude/hooks/sdd-drift-check.js"
            timeout = 10
          }
        )
      }
    )
    PostToolUse = @(
      [ordered]@{
        matcher = "Read|Edit|Write|MultiEdit"
        hooks = @(
          [ordered]@{
            type = "command"
            command = "node .claude/hooks/sdd-drift-check.js"
            timeout = 10
          }
        )
      }
    )
    Stop = @(
      [ordered]@{
        hooks = @(
          [ordered]@{
            type = "command"
            command = "node .claude/hooks/sdd-drift-check.js"
            timeout = 10
          }
        )
      }
    )
  }
}
$settingsObject | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $workRoot ".claude\settings.json") -NoNewline

if (Test-Path -LiteralPath $hookState) {
  Get-ChildItem -LiteralPath $hookState -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

$designPath = Join-Path $workRoot "sdd\changes\test-feat\design.md"
$tasksPath = Join-Path $workRoot "sdd\changes\test-feat\tasks.md"
$appPath = Join-Path $workRoot "src\app.ts"
$helperPath = Join-Path $workRoot "src\helper.ts"
Set-Content -LiteralPath $designPath -Value "# Design`n`nInitial design."
Set-Content -LiteralPath $tasksPath -Value "# Tasks`n`n- [ ] Keep this file unchanged until SDD drift enforcement asks for synchronization."
Set-Content -LiteralPath $appPath -Value "export function greet(name: string) {`n  return `"hello `" + name`n}"
Set-Content -LiteralPath $helperPath -Value "export function helper() {`n  return `"helper`"`n}"

$isCodeScenario = $Scenario -eq "code-cascade" -or $Scenario -eq "multi-code-cascade"
$marker = if ($isCodeScenario) {
  "Real $Provider Claude code drift verification $runId"
} else {
  "Real $Provider Claude SDD drift verification $runId"
}
$taskMarker = if ($isCodeScenario) {
  "Synchronized after $Provider Claude code drift design update $runId"
} else {
  "Synchronized after $Provider Claude SDD drift hook feedback $runId"
}
$codeMarker = "claude-hi-$Provider-$runId"
$helperMarker = "claude-helper-$Provider-$runId"
$sddEditRules = @(
  "Use one file-editing tool call at a time and wait for its tool result before the next write/edit."
  "For existing SDD documents, preserve the top-level heading and template. design.md must keep '# Design'; tasks.md must keep '# Tasks'."
  "Do not replace an SDD document with a single marker line."
  "Do not edit design.md and tasks.md in the same parallel tool batch; update design.md, wait for hook feedback, then update tasks.md if requested."
) -join " "

$prompt = if ($Scenario -eq "multi-code-cascade") {
  @(
    "Execute this exact local file-editing validation task now."
    $sddEditRules
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Use this sequence exactly: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. If hook feedback says SDD reconciliation review is pending, keep coding and do not update SDD yet."
    "4. Read src/helper.ts."
    "5. Write src/helper.ts so it contains this exact string literal: `"$helperMarker`"."
    "6. Now the implementation batch is complete. Read sdd/changes/test-feat/design.md."
    "7. Update the existing design.md content so it contains this exact text: $marker."
    "8. If hook feedback asks you to synchronize peer documents, read sdd/changes/test-feat/tasks.md."
    "9. Update the existing tasks.md content so it contains this exact task line: - [x] $taskMarker."
    "Use only Read, Write, Edit, or MultiEdit tools. Finish only after app.ts, helper.ts, design.md, and tasks.md are synchronized."
  ) -join " "
} elseif ($Scenario -eq "code-cascade") {
  @(
    "Execute this exact local file-editing validation task now."
    $sddEditRules
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Use this sequence: 1. Read src/app.ts."
    "2. Write src/app.ts so it contains this exact string literal: `"$codeMarker`"."
    "3. If hook feedback says SDD reconciliation review is pending, read sdd/changes/test-feat/design.md."
    "4. Update the existing design.md content so it contains this exact text: $marker."
    "5. If hook feedback asks you to synchronize peer documents, read sdd/changes/test-feat/tasks.md."
    "6. Update the existing tasks.md content so it contains this exact task line: - [x] $taskMarker."
    "Use only Read, Write, Edit, or MultiEdit tools. Finish only after src/app.ts, design.md, and tasks.md are synchronized."
  ) -join " "
} else {
  @(
    "Execute this exact local file-editing validation task now."
    $sddEditRules
    "Do not ask a question, do not explore directories, and do not inspect logs or environment/config files."
    "Use this sequence: 1. Read sdd/changes/test-feat/design.md."
    "2. Update the existing design.md content so it contains this exact text: $marker."
    "3. Do not read or write sdd/changes/test-feat/tasks.md during the initial pass unless hook feedback asks you to synchronize peer documents."
    "4. If hook feedback asks you to synchronize peer documents, read sdd/changes/test-feat/tasks.md."
    "5. Update the existing tasks.md content so it contains this exact task line: - [x] $taskMarker."
    "Use only Read, Write, Edit, or MultiEdit tools. Finish only after design.md and tasks.md are synchronized."
  ) -join " "
}

$env:SDD_DRIFT_OUTPUT = "claude"

Push-Location $workRoot
try {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $claude.Source --print --output-format stream-json --include-hook-events --verbose --max-turns $MaxTurns --permission-mode acceptEdits --setting-sources project --model $env:ANTHROPIC_MODEL $prompt > $outLog 2> $errLog
  $claudeExit = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
} finally {
  Pop-Location
}

Write-Output "CLAUDE_EXIT=$claudeExit"
Write-Output "WORKROOT=$workRoot"
Write-Output "--- design.md ---"
Get-Content -LiteralPath $designPath
Write-Output "--- tasks.md ---"
Get-Content -LiteralPath $tasksPath
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
Write-Output "--- claude stdout tail ---"
if (Test-Path -LiteralPath $outLog) {
  Get-Content -LiteralPath $outLog -Tail 120
}
Write-Output "--- claude stderr tail ---"
if (Test-Path -LiteralPath $errLog) {
  Get-Content -LiteralPath $errLog -Tail 120
}

if ($claudeExit -ne 0) {
  exit $claudeExit
}

$designText = Get-Content -LiteralPath $designPath -Raw
$tasksText = Get-Content -LiteralPath $tasksPath -Raw
$appText = Get-Content -LiteralPath $appPath -Raw
$helperText = Get-Content -LiteralPath $helperPath -Raw
$outText = if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Raw } else { "" }
$errText = if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Raw } else { "" }
$reportText = if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report -Raw } else { "" }
$combinedText = "$outText`n$errText"

if ($designText -notmatch [regex]::Escape($marker)) {
  throw "expected design.md to contain real model marker"
}
if ($designText -notmatch "(?m)^#\s+Design\b") {
  throw "expected design.md to preserve the # Design heading"
}
if ($isCodeScenario -and $appText -notmatch [regex]::Escape($codeMarker)) {
  throw "expected src/app.ts to contain real model code marker"
}
if ($Scenario -eq "multi-code-cascade" -and $helperText -notmatch [regex]::Escape($helperMarker)) {
  throw "expected src/helper.ts to contain real model helper marker"
}
if ($combinedText -notmatch "SDD drift tool result enforcement") {
  throw "expected Claude Code hook stream to include SDD drift tool result enforcement"
}
if ($Scenario -eq "multi-code-cascade") {
  $codeEnforcementCount = Count-HookResponsesContaining `
    $outText `
    "SDD reconciliation review is now pending for this code-change batch"
  if ($codeEnforcementCount -ne 1) {
    throw "expected exactly one code drift enforcement for consecutive code edits, got $codeEnforcementCount"
  }
}
if ($tasksText -notmatch [regex]::Escape($taskMarker)) {
  throw "expected tasks.md to contain real model synchronization marker"
}
if ($tasksText -notmatch "(?m)^#\s+Tasks\b") {
  throw "expected tasks.md to preserve the # Tasks heading"
}
if ($errText -match "\[sdd-drift-check\]") {
  throw "expected no hook stderr output by default"
}
if ($reportText.Trim().Length -gt 0) {
  throw "expected no drift report after successful real-model synchronization"
}
