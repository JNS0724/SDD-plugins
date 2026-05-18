param(
  [ValidateSet("deepseek", "minimax", "all")]
  [string]$Provider = "deepseek",

  [ValidateSet("design-cascade", "code-cascade", "multi-code-cascade", "design-no-peer", "proposal-no-peer", "dts-code", "no-sdd-code")]
  [string]$Scenario = "multi-code-cascade",

  [ValidateSet("opencode", "claude", "both")]
  [string]$Target = "both",

  [ValidateSet("stop-only", "posttooluse-and-stop")]
  [string]$OpenCodeHookMode = "posttooluse-and-stop"
)

$ErrorActionPreference = "Stop"
$testRoot = $PSScriptRoot
$providers = if ($Provider -eq "all") { @("deepseek", "minimax") } else { @($Provider) }

foreach ($providerName in $providers) {
  if ($Target -eq "opencode" -or $Target -eq "both") {
    Push-Location (Join-Path $testRoot "opencode-sdd-drift-e2e")
    try {
      & npm.cmd run e2e:real -- -Provider $providerName -Scenario $Scenario -HookMode $OpenCodeHookMode
      if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
      }
    } finally {
      Pop-Location
    }
  }

  if ($Target -eq "claude" -or $Target -eq "both") {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $testRoot "claude-code-sdd-drift-e2e\scripts\run-real-e2e.ps1") -Provider $providerName -Scenario $Scenario
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
}
