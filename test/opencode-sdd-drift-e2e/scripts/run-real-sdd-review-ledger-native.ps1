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
$workRoot = Join-Path $root ".real-workspaces\ledger-$Provider-$runId"
$opencodeHome = Join-Path $root ".real-homes\ledger-$Provider-$runId"
$opencodeBin = Join-Path $root "node_modules\.bin\opencode.cmd"
$configTemplate = Join-Path $root ".opencode\opencode.$Provider.jsonc.example"
$pluginSource = Join-Path $repoRoot "plugins\sdd-review-ledger\sdd-review-ledger-opencode.js"
$rulesSource = Join-Path $repoRoot "plugins\sdd-review-ledger\sdd-review-rules.md"
$pluginTarget = Join-Path $workRoot ".opencode\plugins\sdd-review-ledger-opencode.js"
$rulesTarget = Join-Path $workRoot ".opencode\plugins\sdd-review-rules.md"
$pipelineModule = Join-Path $repoRoot "plugins\sdd-review-ledger\src\pipeline.js"
$outLog = Join-Path $workRoot "$Provider-ledger.out.log"
$errLog = Join-Path $workRoot "$Provider-ledger.err.log"
$verificationJson = Join-Path $workRoot "ledger-verification.json"
$todoPath = Join-Path $workRoot ".sdd-review-todo.md"

if (!(Test-Path -LiteralPath $opencodeBin)) {
  throw "missing opencode binary; run npm install in $root"
}
if (!(Test-Path -LiteralPath $configTemplate)) {
  throw "missing provider config template: $configTemplate"
}
if (!(Test-Path -LiteralPath $pluginSource)) {
  throw "missing built plugin artifact: $pluginSource"
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

New-Item -ItemType Directory -Force (Split-Path -Parent $pluginTarget) | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\ledger-test") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "src") | Out-Null
New-Item -ItemType Directory -Force $opencodeHome | Out-Null
Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Force
Copy-Item -LiteralPath $rulesSource -Destination $rulesTarget -Force

Push-Location $workRoot
try {
  & git init | Out-Null
} finally {
  Pop-Location
}

$config = Get-Content -LiteralPath $configTemplate -Raw -Encoding UTF8
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
      "steps": 30,
      "temperature": 0,
      "prompt": "You are a deterministic local file editing agent for sdd-review-ledger OpenCode validation. Execute the requested local read/write sequence directly. Never inspect .opencode, .git, logs, provider config, environment variables, or hook implementation files. If a write tool result contains [SDD-REVIEW: NEEDS-REVIEW], continue the same assistant turn: read .sdd-review-todo.md, read the changed code and candidate design/tasks documents, update SDD docs when the change is product-visible, then read .sdd-review-todo.md again and check every currently pending path@hash you reviewed with a short evidence-based rationale. Preserve each exact path@hash. Do not finish while .sdd-review-todo.md still has unchecked items you just reviewed."
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

$codeMarker = "ledger-real-$Provider-code-$runId"
$taskMarker = "ledger-real-$Provider-task-$runId"
$designPath = Join-Path $workRoot "sdd\changes\ledger-test\design.md"
$tasksPath = Join-Path $workRoot "sdd\changes\ledger-test\tasks.md"
$codePath = Join-Path $workRoot "src\greeting.ts"
Set-ContentWithRetry -LiteralPath $designPath -Value "# Design`n`nThe greeting module currently returns a plain greeting.`n" -NoNewline
Set-ContentWithRetry -LiteralPath $tasksPath -Value "# Tasks`n`n- [ ] Keep greeting behavior documented.`n" -NoNewline
Set-ContentWithRetry -LiteralPath $codePath -Value "export function greeting() {`n  return 'hello';`n}`n" -NoNewline

$baselineScript = @"
const { run } = require(process.argv[2]);
run({ repoRoot: process.argv[1], env: {}, actor: 'baseline', now: new Date().toISOString() });
"@
& node -e $baselineScript -- $workRoot $pipelineModule
if ($LASTEXITCODE -ne 0) {
  throw "failed to create sdd-review-ledger baseline"
}

$previousHome = $env:HOME
$previousUserProfile = $env:USERPROFILE
$env:HOME = $opencodeHome
$env:USERPROFILE = $opencodeHome

$prompt = @(
  "Execute this exact local file-editing validation task now."
  "Do not ask a question. Do not inspect .opencode, .git, logs, provider config, environment variables, shell output, or hook files."
  "Use only file read/write/edit tools."
  "1. Read src/greeting.ts."
  "2. Modify src/greeting.ts so greeting() returns the exact string '$codeMarker'."
  "3. After the write/edit tool result, if you see [SDD-REVIEW: NEEDS-REVIEW], continue the same assistant turn."
  "4. Read .sdd-review-todo.md, sdd/changes/ledger-test/design.md, sdd/changes/ledger-test/tasks.md, and src/greeting.ts."
  "5. Because this is a product-visible greeting behavior change, update sdd/changes/ledger-test/tasks.md while preserving the existing # Tasks heading and existing checklist item, and add this exact checked task line: - [x] $taskMarker."
  "6. Read .sdd-review-todo.md again after the tasks edit, because the task edit creates a new current hash."
  "7. In .sdd-review-todo.md, convert every current pending line you reviewed from '- [ ] path@hash' to '- [x] path@hash — verified: ...', preserving each exact path@hash."
  "Finish only after the code marker, task marker, and checked todo review are all present. Do not edit src/greeting.ts or tasks.md after the final todo checkoff."
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
}

$verifyScript = @"
const fs = require('fs');
const { run } = require(process.argv[2]);
const result = run({ repoRoot: process.argv[1], env: {}, actor: 'verification', now: new Date().toISOString() });
fs.writeFileSync(process.argv[3], JSON.stringify({ action: result.action, wrote: result.wrote, needs: result.needs || [], meta: result.meta || {} }, null, 2));
"@
& node -e $verifyScript -- $workRoot $pipelineModule $verificationJson
if ($LASTEXITCODE -ne 0) {
  throw "failed to run sdd-review-ledger verification pass"
}

Write-Output "PROVIDER=$Provider"
Write-Output "MODEL=$modelName"
Write-Output "OPENCODE_EXIT=$opencodeExit"
Write-Output "WORKROOT=$workRoot"
Write-Output "CODE_MARKER=$codeMarker"
Write-Output "TASK_MARKER=$taskMarker"
Write-Output "--- src/greeting.ts ---"
Get-Content -LiteralPath $codePath -Encoding UTF8
Write-Output "--- sdd/changes/ledger-test/design.md ---"
Get-Content -LiteralPath $designPath -Encoding UTF8
Write-Output "--- sdd/changes/ledger-test/tasks.md ---"
Get-Content -LiteralPath $tasksPath -Encoding UTF8
Write-Output "--- .sdd-review-todo.md ---"
if (Test-Path -LiteralPath $todoPath) {
  Get-Content -LiteralPath $todoPath -Encoding UTF8
} else {
  Write-Output "<missing>"
}
Write-Output "--- ledger verification ---"
Get-Content -LiteralPath $verificationJson -Encoding UTF8
Write-Output "--- opencode stdout tail ---"
if (Test-Path -LiteralPath $outLog) {
  Get-Content -LiteralPath $outLog -Tail 120 -Encoding UTF8
}
Write-Output "--- opencode stderr tail ---"
if (Test-Path -LiteralPath $errLog) {
  Get-Content -LiteralPath $errLog -Tail 160 -Encoding UTF8
}
Write-Output "--- state dir ---"
$stateDir = Join-Path $workRoot ".git\sdd-review-ledger-state"
if (Test-Path -LiteralPath $stateDir) {
  Get-ChildItem -LiteralPath $stateDir | Select-Object Name,Length,LastWriteTime
} else {
  Write-Output "<missing>"
}

if ($opencodeExit -ne 0) {
  exit $opencodeExit
}

$codeText = Get-Content -LiteralPath $codePath -Raw -Encoding UTF8
$tasksText = Get-Content -LiteralPath $tasksPath -Raw -Encoding UTF8
$todoText = if (Test-Path -LiteralPath $todoPath) { Get-Content -LiteralPath $todoPath -Raw -Encoding UTF8 } else { "" }
$outText = if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Raw -Encoding UTF8 } else { "" }
$errText = if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Raw -Encoding UTF8 } else { "" }
$verification = Get-Content -LiteralPath $verificationJson -Raw -Encoding UTF8 | ConvertFrom-Json

if ($codeText -notmatch [regex]::Escape($codeMarker)) {
  throw "expected src/greeting.ts to contain real-model code marker"
}
if ($tasksText -notmatch [regex]::Escape($taskMarker)) {
  throw "expected tasks.md to contain real-model SDD task marker"
}
if ($todoText -notmatch "\[x\]") {
  throw "expected .sdd-review-todo.md to contain checked review records"
}
if ($todoText -match "(?m)^- \[ \] ") {
  throw "expected .sdd-review-todo.md to have no unchecked pending items after verification"
}
if ($outText -notmatch "\[SDD-REVIEW: NEEDS-REVIEW\]") {
  throw "expected OpenCode stdout to include sdd-review-ledger reminder"
}
if ($errText -match "console\.error|\[sdd-review-ledger\]") {
  throw "expected no noisy hook stderr output"
}
if (@($verification.needs).Count -ne 0) {
  throw "expected ledger verification to have zero pending needs"
}
