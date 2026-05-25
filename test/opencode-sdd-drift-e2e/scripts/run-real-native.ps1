param(
  [ValidateSet("deepseek", "minimax")]
  [string]$Provider = "deepseek"
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $root)
$runId = [guid]::NewGuid().ToString("N")
$workRoot = Join-Path $root ".real-workspaces\native-$Provider-$runId"
$opencodeHome = Join-Path $workRoot ".home"
$opencodeBin = Join-Path $root "node_modules\.bin\opencode.cmd"
$configTemplate = Join-Path $root ".opencode\opencode.$Provider.jsonc.example"
$nativeSource = Join-Path $repoRoot "plugins\sdd-drift-check\sdd-drift-check-opencode.js"
$hookSource = Join-Path $repoRoot "plugins\sdd-drift-check\sdd-drift-check-hook.js"
$nativeTarget = Join-Path $workRoot ".opencode\plugins\sdd-drift-check-opencode.js"
$hookTarget = Join-Path $workRoot ".opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js"
$outLog = Join-Path $workRoot "$Provider-native.out.log"
$errLog = Join-Path $workRoot "$Provider-native.err.log"
$report = Join-Path $workRoot ".sdd-drift-report.md"

if (!(Test-Path -LiteralPath $opencodeBin)) {
  throw "missing opencode binary; run npm install in $root"
}
if (!(Test-Path -LiteralPath $configTemplate)) {
  throw "missing provider config template: $configTemplate"
}

$keyName = if ($Provider -eq "deepseek") { "DEEPSEEK_API_KEY" } else { "MINIMAX_API_KEY" }
if (!(Test-Path "Env:\$keyName")) {
  $envValue = [Environment]::GetEnvironmentVariable($keyName, "User")
  if (!$envValue) {
    $envValue = [Environment]::GetEnvironmentVariable($keyName, "Machine")
  }
  if ($envValue) {
    Set-Item "Env:\$keyName" $envValue
  }
}
$keyValue = [Environment]::GetEnvironmentVariable($keyName, "Process")
if (!$keyValue -or !$keyValue.Trim()) {
  throw "$keyName is not set in process or User environment"
}
if ($keyValue.Trim() -match "your|replace|placeholder|example|dummy|test-key|api-key|apikey") {
  throw "$keyName still looks like a placeholder"
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

New-Item -ItemType Directory -Force (Split-Path -Parent $nativeTarget) | Out-Null
New-Item -ItemType Directory -Force (Split-Path -Parent $hookTarget) | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\native-test") | Out-Null
New-Item -ItemType Directory -Force $opencodeHome | Out-Null
Copy-Item -LiteralPath $nativeSource -Destination $nativeTarget -Force
Copy-Item -LiteralPath $hookSource -Destination $hookTarget -Force

Push-Location $workRoot
try {
  & git init | Out-Null
} finally {
  Pop-Location
}

$config = Get-Content -LiteralPath $configTemplate -Raw
if ($Provider -eq "minimax") {
  $config = $config -replace "https://api\.minimax(?:i)?\.com/v1", $minimaxBaseUrl.TrimEnd("/")
}
$modelName = if ($Provider -eq "deepseek") { "deepseek/deepseek-chat" } else { "minimax/MiniMax-M2.7" }
$agentConfig = @"
  "agent": {
    "sddtest": {
      "model": "$modelName",
      "mode": "primary",
      "permission": "allow",
      "steps": 12,
      "temperature": 0,
      "prompt": "You are a deterministic local file editing agent for native OpenCode SDD drift validation. Execute the requested read/write sequence directly. Never inspect .opencode, .git, logs, provider config, environment variables, or hook implementation files. If any tool result contains SDD drift enforcement or SDD drift reminder, continue the same assistant turn by reading and writing the requested SDD peer document before giving a final answer."
    },
    "build": {
      "model": "$modelName",
      "permission": "allow",
      "steps": 4
    },
    "title": {
      "model": "$modelName",
      "permission": "allow",
      "steps": 1
    }
  }
"@
$config = $config -replace '"agent"\s*:\s*\{[\s\S]*\}\s*\n\}', ($agentConfig + "`n}")
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot ".opencode\opencode.jsonc") -Value $config -NoNewline

$marker = "Native OpenCode real $Provider design marker $runId"
$taskMarker = "Native OpenCode real $Provider task sync $runId"
$designPath = Join-Path $workRoot "sdd\changes\native-test\design.md"
$tasksPath = Join-Path $workRoot "sdd\changes\native-test\tasks.md"
Set-ContentWithRetry -LiteralPath $designPath -Value "# Design`n`nInitial design.`n" -NoNewline
Set-ContentWithRetry -LiteralPath $tasksPath -Value "# Tasks`n`n- [ ] Initial task.`n" -NoNewline

$previousHome = $env:HOME
$previousUserProfile = $env:USERPROFILE
$previousOutputMode = $env:SDD_DRIFT_OUTPUT
$env:HOME = $opencodeHome
$env:USERPROFILE = $opencodeHome
$env:SDD_DRIFT_OUTPUT = "opencode"

$prompt = @(
  "Execute this exact local file-editing validation task now."
  "Do not ask a question, do not inspect .opencode, .git, logs, provider config, environment variables, or hook files."
  "Use only read and write tools."
  "1. Read sdd/changes/native-test/design.md."
  "2. Write sdd/changes/native-test/design.md while preserving the existing # Design heading and all existing body text, and make it also contain this exact heading: ## $marker."
  "3. Wait for the design.md write tool result and inspect that tool result text."
  "4. If the tool result contains SDD drift enforcement or SDD drift reminder, read sdd/changes/native-test/tasks.md."
  "5. Write sdd/changes/native-test/tasks.md while preserving the existing # Tasks heading and all existing checklist items, and make it also contain this exact task line: - [x] $taskMarker."
  "Finish only after design.md and tasks.md are synchronized."
) -join " "

try {
  Push-Location $workRoot
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $opencodeBin run --print-logs --log-level DEBUG --agent sddtest --format json --dir $workRoot $prompt > $outLog 2> $errLog
    $opencodeExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
} finally {
  $env:HOME = $previousHome
  $env:USERPROFILE = $previousUserProfile
  $env:SDD_DRIFT_OUTPUT = $previousOutputMode
}

Write-Output "OPENCODE_EXIT=$opencodeExit"
Write-Output "WORKROOT=$workRoot"
Write-Output "--- design.md ---"
Get-Content -LiteralPath $designPath
Write-Output "--- tasks.md ---"
Get-Content -LiteralPath $tasksPath
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
$outText = if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Raw } else { "" }
$errText = if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Raw } else { "" }
$reportText = if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report -Raw } else { "" }

if ($designText -notmatch [regex]::Escape($marker)) {
  throw "expected design.md to contain native real model marker"
}
if ($designText -notmatch "(?m)^# Design\s*$") {
  throw "expected design.md to preserve the top-level # Design heading"
}
if ($designText -notmatch "Initial design") {
  throw "expected design.md to preserve existing body text"
}
if ($tasksText -notmatch [regex]::Escape($taskMarker)) {
  throw "expected tasks.md to contain native real model synchronization marker"
}
if ($tasksText -notmatch [regex]::Escape("- [ ] Initial task.")) {
  throw "expected tasks.md to preserve existing checklist item"
}
if ($outText -notmatch "SDD drift") {
  throw "expected OpenCode output to include native SDD drift reminder"
}
if ($errText -match "\[sdd-drift-check\]") {
  throw "expected no hook stderr output by default"
}
if ($reportText.Trim().Length -gt 0) {
  throw "expected no drift report after successful native real-model synchronization"
}

$hookLog = Join-Path $workRoot ".git\sdd-drift-hook-state\sdd-drift-check.log.jsonl"
Write-Output "HOOK_LOG=$hookLog"
if (Test-Path -LiteralPath $hookLog) {
  Write-Output "--- hook event counts ---"
  Get-Content -LiteralPath $hookLog |
    ForEach-Object {
      try { (ConvertFrom-Json $_).event } catch { $null }
    } |
    Where-Object { $_ } |
    Group-Object |
    Sort-Object Name |
    ForEach-Object { Write-Output "$($_.Name)=$($_.Count)" }
}
