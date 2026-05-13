param(
  [ValidateSet("sdd-design", "code")]
  [string]$Scenario = "sdd-design"
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$opencodeHome = Join-Path $root ".home-e2e"
$serverOut = Join-Path $root "fake-openai.out.log"
$serverErr = Join-Path $root "fake-openai.err.log"
$runOut = Join-Path $root "opencode-run.out.log"
$runErr = Join-Path $root "opencode-run.err.log"
$ready = Join-Path $root "fake-openai.ready"
$report = Join-Path $root ".sdd-drift-report.md"
$serverPidFile = Join-Path $root "fake-openai.pid"

if (Test-Path -LiteralPath $serverPidFile) {
  $stalePid = Get-Content -LiteralPath $serverPidFile -ErrorAction SilentlyContinue
  if ($stalePid) {
    Stop-Process -Id ([int]$stalePid) -Force -ErrorAction SilentlyContinue
  }
}

foreach ($file in @($serverOut, $serverErr, $runOut, $runErr, $ready, $report, $serverPidFile, (Join-Path $root "fake-openai.log"))) {
  if (Test-Path -LiteralPath $file) {
    Remove-Item -LiteralPath $file -Force
  }
}

Set-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\design.md") -Value "# Design`n`nInitial design."
Set-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\tasks.md") -Value "# Tasks`n`n- [ ] Keep this file unchanged during the first drift test."
Set-Content -LiteralPath (Join-Path $root "src\app.ts") -Value "export function greet(name: string) {`n  return `"hello `" + name`n}"

$env:FAKE_SCENARIO = $Scenario
$server = Start-Process node `
  -ArgumentList ".\fake-openai-server.mjs" `
  -WorkingDirectory $root `
  -RedirectStandardOutput $serverOut `
  -RedirectStandardError $serverErr `
  -WindowStyle Hidden `
  -PassThru
Set-Content -LiteralPath $serverPidFile -Value $server.Id

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
  $opencode = Start-Process npx.cmd `
    -ArgumentList "opencode", "run", "--print-logs", "--log-level", "DEBUG", "--format", "json", $prompt `
    -WorkingDirectory $root `
    -RedirectStandardOutput $runOut `
    -RedirectStandardError $runErr `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  $opencodeExit = $opencode.ExitCode

  Write-Output "OPENCODE_EXIT=$opencodeExit"
} finally {
  if ($server -and !$server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
  if (Test-Path -LiteralPath $serverPidFile) {
    Remove-Item -LiteralPath $serverPidFile -Force
  }
}

Write-Output "--- fake-openai.log ---"
if (Test-Path -LiteralPath (Join-Path $root "fake-openai.log")) {
  Get-Content -LiteralPath (Join-Path $root "fake-openai.log")
}

Write-Output "--- design.md ---"
Get-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\design.md")

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
