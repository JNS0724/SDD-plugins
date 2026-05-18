param(
  [ValidateSet("deepseek", "minimax")]
  [string]$Provider = "deepseek",

  [string]$WorkRoot = ""
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $root)
$opencodeBin = Join-Path $root "node_modules\.bin\opencode.cmd"
$hookSource = Join-Path $repoRoot "plugins\sdd-drift-check\sdd-drift-check-hook.js"
$runId = [guid]::NewGuid().ToString("N")

if (!(Test-Path -LiteralPath $opencodeBin)) {
  throw "missing opencode binary; run npm install in $root"
}

if (!$WorkRoot) {
  $workspaceRoot = Join-Path $root ".real-workspaces"
  $candidate = Get-ChildItem -LiteralPath $workspaceRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -like "snake-$Provider-*" -and
      (Test-Path -LiteralPath (Join-Path $_.FullName ".opencode\opencode.jsonc")) -and
      (Test-Path -LiteralPath (Join-Path $_.FullName ".home")) -and
      (Test-Path -LiteralPath (Join-Path $_.FullName "sdd"))
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (!$candidate) {
    throw "no existing snake-$Provider workroot found; run scripts\run-snake-real.ps1 first or pass -WorkRoot"
  }
  $WorkRoot = $candidate.FullName
}

$WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
if (!(Test-Path -LiteralPath $WorkRoot)) {
  throw "workroot does not exist: $WorkRoot"
}

$hookTarget = Join-Path $WorkRoot ".opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js"
if (!(Test-Path -LiteralPath (Split-Path -Parent $hookTarget))) {
  throw "workroot does not look configured for sdd-drift-check hooks: $WorkRoot"
}
Copy-Item -LiteralPath $hookSource -Destination $hookTarget -Force

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

$hookLog = Join-Path $WorkRoot ".git\sdd-drift-hook-state\sdd-drift-check.log.jsonl"
$reportPath = Join-Path $WorkRoot ".sdd-drift-report.md"
$emitEvents = @(
  "emit_code_enforcement",
  "emit_code_reminder_compact",
  "emit_peer_enforcement",
  "emit_peer_stage_reminder",
  "stop_block_emit",
  "stop_review_confirmation_requested"
)

function Get-HookEventCounts {
  param([string]$LogPath)

  $counts = @{}
  if (!(Test-Path -LiteralPath $LogPath)) {
    return $counts
  }

  Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue |
    ForEach-Object {
      try {
        $event = (ConvertFrom-Json $_).event
        if ($event) {
          if (!$counts.ContainsKey($event)) {
            $counts[$event] = 0
          }
          $counts[$event] += 1
        }
      } catch {}
    }
  return $counts
}

function Get-Count {
  param(
    [hashtable]$Counts,
    [string]$Name
  )

  if ($Counts.ContainsKey($Name)) {
    return [int]$Counts[$Name]
  }
  return 0
}

function Get-OptionalHash {
  param([string]$LiteralPath)

  if (!(Test-Path -LiteralPath $LiteralPath)) {
    return $null
  }
  return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash
}

$beforeCounts = Get-HookEventCounts -LogPath $hookLog
$beforeReportHash = Get-OptionalHash -LiteralPath $reportPath

$previousHome = $env:HOME
$previousUserProfile = $env:USERPROFILE
$previousOmoTelemetry = $env:OMO_SEND_ANONYMOUS_TELEMETRY
$previousOmoPosthog = $env:OMO_DISABLE_POSTHOG
$previousOutputMode = $env:SDD_DRIFT_OUTPUT
$env:HOME = Join-Path $WorkRoot ".home"
$env:USERPROFILE = $env:HOME
$env:OMO_SEND_ANONYMOUS_TELEMETRY = "0"
$env:OMO_DISABLE_POSTHOG = "1"
$env:SDD_DRIFT_OUTPUT = "opencode"

$prompts = @(
  "Silent SDD hook regression $runId round 1. Do not inspect .opencode, .claude, .git, logs, provider config, environment variables, SDD docs, or code files. Create scratch/silent-$runId-round-1.txt with two short neutral lines. Read scratch/silent-$runId-round-1.txt back. Do not read or write index.html, README.md, src paths, sdd paths, or .sdd paths. Finish briefly.",
  "Silent SDD hook regression $runId round 2. Continue from the same project. Do not inspect .opencode, .claude, .git, logs, provider config, environment variables, SDD docs, or code files. Read scratch/silent-$runId-round-1.txt. Create notes/silent-$runId-round-2.txt with two short neutral lines. Read notes/silent-$runId-round-2.txt back. Do not read or write index.html, README.md, src paths, sdd paths, or .sdd paths. Finish briefly.",
  "Silent SDD hook regression $runId round 3. Continue from the same project. Do not inspect .opencode, .claude, .git, logs, provider config, environment variables, SDD docs, or code files. Read notes/silent-$runId-round-2.txt. Append one sentence to scratch/silent-$runId-round-1.txt using an edit. Read scratch/silent-$runId-round-1.txt back. Do not read or write index.html, README.md, src paths, sdd paths, or .sdd paths. Finish briefly."
)

$opencodeExit = 0
try {
  for ($i = 0; $i -lt $prompts.Count; $i++) {
    $phase = "silent-$($i + 1)-$runId"
    $outLog = Join-Path $WorkRoot "opencode-$phase.out.log"
    $errLog = Join-Path $WorkRoot "opencode-$phase.err.log"
    $args = @(
      "run",
      "--print-logs",
      "--log-level",
      "DEBUG",
      "--agent",
      "snake-dev",
      "--format",
      "json",
      "--dir",
      $WorkRoot,
      "--continue",
      $prompts[$i]
    )

    Push-Location $root
    try {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      & $opencodeBin @args > $outLog 2> $errLog
      $opencodeExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
      Pop-Location
    }

    Write-Output "SILENT_PHASE_$($i + 1)_EXIT=$opencodeExit"
    Write-Output "SILENT_PHASE_$($i + 1)_OUT=$outLog"
    Write-Output "SILENT_PHASE_$($i + 1)_ERR=$errLog"
    if ($opencodeExit -ne 0) {
      break
    }
  }
} finally {
  $env:HOME = $previousHome
  $env:USERPROFILE = $previousUserProfile
  $env:OMO_SEND_ANONYMOUS_TELEMETRY = $previousOmoTelemetry
  $env:OMO_DISABLE_POSTHOG = $previousOmoPosthog
  $env:SDD_DRIFT_OUTPUT = $previousOutputMode
}

if ($opencodeExit -ne 0) {
  exit $opencodeExit
}

$afterCounts = Get-HookEventCounts -LogPath $hookLog
$afterReportHash = Get-OptionalHash -LiteralPath $reportPath

foreach ($event in $emitEvents) {
  $delta = (Get-Count -Counts $afterCounts -Name $event) - (Get-Count -Counts $beforeCounts -Name $event)
  Write-Output "$event`_DELTA=$delta"
  if ($delta -ne 0) {
    throw "expected $event delta to be 0, got $delta"
  }
}

$allowedEvents = @("hook_start", "posttooluse_no_output", "stop_allow_no_pending")
$newEventNames = @()
foreach ($name in $afterCounts.Keys) {
  $delta = (Get-Count -Counts $afterCounts -Name $name) - (Get-Count -Counts $beforeCounts -Name $name)
  if ($delta -gt 0 -and $allowedEvents -notcontains $name) {
    $newEventNames += "$name=$delta"
  }
}
if ($newEventNames.Count -gt 0) {
  throw "unexpected new hook events during silent regression: $($newEventNames -join ', ')"
}

if ($beforeReportHash -ne $afterReportHash) {
  throw "expected .sdd-drift-report.md hash to stay unchanged; before=$beforeReportHash after=$afterReportHash"
}

Write-Output "WORKROOT=$WorkRoot"
Write-Output "REPORT_HASH_BEFORE=$beforeReportHash"
Write-Output "REPORT_HASH_AFTER=$afterReportHash"
Write-Output "--- hook event deltas ---"
foreach ($name in $allowedEvents) {
  $delta = (Get-Count -Counts $afterCounts -Name $name) - (Get-Count -Counts $beforeCounts -Name $name)
  Write-Output "$name=$delta"
}
