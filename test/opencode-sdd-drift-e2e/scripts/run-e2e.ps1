param(
  [ValidateSet("sdd-design", "sdd-cascade", "code")]
  [string]$Scenario = "sdd-design"
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$runId = [guid]::NewGuid().ToString("N")
$opencodeHome = Join-Path $root ".home-e2e"
$serverOut = Join-Path $root "fake-openai.$runId.out.log"
$serverErr = Join-Path $root "fake-openai.$runId.err.log"
$runOut = Join-Path $root "opencode-run.$runId.out.log"
$runErr = Join-Path $root "opencode-run.$runId.err.log"
$ready = Join-Path $root "fake-openai.$runId.ready"
$fakeLog = Join-Path $root "fake-openai.$runId.log"
$report = Join-Path $root ".sdd-drift-report.md"

if (Test-Path -LiteralPath $report) {
  Clear-Content -LiteralPath $report -ErrorAction SilentlyContinue
}

Set-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\design.md") -Value "# Design`n`nInitial design."
Set-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\tasks.md") -Value "# Tasks`n`n- [ ] Keep this file unchanged during the first drift test."
Set-Content -LiteralPath (Join-Path $root "src\app.ts") -Value "export function greet(name: string) {`n  return `"hello `" + name`n}"

$env:FAKE_SCENARIO = $Scenario
$env:FAKE_LOG_PATH = $fakeLog
$env:FAKE_READY_PATH = $ready
$server = Start-Process node `
  -ArgumentList ".\fake-openai-server.mjs" `
  -WorkingDirectory $root `
  -RedirectStandardOutput $serverOut `
  -RedirectStandardError $serverErr `
  -WindowStyle Hidden `
  -PassThru

try {
  $deadline = (Get-Date).AddSeconds(10)
  while (!(Test-Path -LiteralPath $ready)) {
    if ((Get-Date) -gt $deadline) {
      throw "fake provider did not become ready"
    }
    Start-Sleep -Milliseconds 200
  }

  $env:HOME = $opencodeHome
  $env:USERPROFILE = $opencodeHome
  $prompt = if ($Scenario -eq "code") {
    "Use the read tool, then the write tool, to update src/app.ts only."
  } else {
    "Use the read tool, then the write tool, to update sdd/changes/test-feat/design.md only."
  }

  $runArgs = @("opencode", "run", "--print-logs", "--log-level", "DEBUG", "--format", "json", $prompt)

  $opencode = Start-Process npx.cmd `
    -ArgumentList $runArgs `
    -WorkingDirectory $root `
    -RedirectStandardOutput $runOut `
    -RedirectStandardError $runErr `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  $opencodeExit = $opencode.ExitCode

  if ($Scenario -eq "sdd-cascade") {
    $syncDeadline = (Get-Date).AddSeconds(20)
    do {
      $tasksText = Get-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\tasks.md") -Raw
      if ($tasksText -match "Synced by fake opencode model") {
        break
      }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $syncDeadline)
  }

  Write-Output "OPENCODE_EXIT=$opencodeExit"
} finally {
  if ($server -and !$server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
}

Write-Output "--- fake-openai.log ---"
if (Test-Path -LiteralPath $fakeLog) {
  Get-Content -LiteralPath $fakeLog
}

Write-Output "--- design.md ---"
Get-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\design.md")

Write-Output "--- tasks.md ---"
Get-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\tasks.md")

Write-Output "--- src/app.ts ---"
Get-Content -LiteralPath (Join-Path $root "src\app.ts")

Write-Output "--- .sdd-drift-report.md ---"
if (Test-Path -LiteralPath $report) {
  Get-Content -LiteralPath $report
} else {
  Write-Output "<missing>"
}

Write-Output "--- opencode-run.out.log tail ---"
if (Test-Path -LiteralPath $runOut) {
  Get-Content -LiteralPath $runOut -Tail 80
}

Write-Output "--- opencode-run.err.log tail ---"
if (Test-Path -LiteralPath $runErr) {
  Get-Content -LiteralPath $runErr -Tail 120
}

if ($opencodeExit -ne 0) {
  exit $opencodeExit
}

$visibleOutput = if (Test-Path -LiteralPath $runOut) {
  $content = Get-Content -LiteralPath $runOut -Raw
  if ($null -eq $content) { "" } else { $content }
} else {
  ""
}
if ($env:SDD_DRIFT_SHOW_WARNINGS -ne "1" -and $visibleOutput -match "SDD DRIFT:") {
  throw "expected no legacy SDD DRIFT warning in tool output by default"
}

if ($Scenario -eq "sdd-cascade") {
  $tasksText = Get-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\tasks.md") -Raw
  if ($tasksText -notmatch "Synced by fake opencode model") {
    throw "expected tool result enforcement to trigger tasks.md synchronization"
  }
  $errText = if (Test-Path -LiteralPath $runErr) {
    $content = Get-Content -LiteralPath $runErr -Raw
    if ($null -eq $content) { "" } else { $content }
  } else {
    ""
  }
  if ($errText -match "\[sdd-drift-check\]") {
    throw "expected no plugin stderr output by default"
  }
  $fakeLogText = if (Test-Path -LiteralPath $fakeLog) {
    $content = Get-Content -LiteralPath $fakeLog -Raw
    if ($null -eq $content) { "" } else { $content }
  } else {
    ""
  }
  if ($fakeLogText -notmatch '"hasToolEnforcement":true') {
    throw "expected plugin to inject SDD drift tool result enforcement"
  }
  if ($errText -match "path=/session/\{id\}/message") {
    throw "expected plugin not to call session.prompt"
  }
  $reportText = if (Test-Path -LiteralPath $report) {
    $content = Get-Content -LiteralPath $report -Raw
    if ($null -eq $content) { "" } else { $content }
  } else {
    ""
  }
  if ($reportText.Trim().Length -gt 0) {
    throw "expected no drift report after successful cascade synchronization"
  }
}
