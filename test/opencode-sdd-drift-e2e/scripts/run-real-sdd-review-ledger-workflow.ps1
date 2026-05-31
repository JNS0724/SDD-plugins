param(
  [ValidateSet("deepseek", "minimax")]
  [string]$Provider = "deepseek",

  [ValidateSet("single-session", "split-at-04")]
  [string]$Scenario = "single-session"
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $root)
$runId = [guid]::NewGuid().ToString("N")
$scenarioSlug = $Scenario -replace "[^A-Za-z0-9_-]", "-"
$workRoot = Join-Path $root ".real-workspaces\ledger-workflow-$Provider-$scenarioSlug-$runId"
$opencodeHome = Join-Path $root ".real-homes\ledger-workflow-$Provider-$scenarioSlug-$runId"
$opencodeBin = Join-Path $root "node_modules\.bin\opencode.cmd"
$configTemplate = Join-Path $root ".opencode\opencode.$Provider.jsonc.example"
$pluginSource = Join-Path $repoRoot "plugins\sdd-review-ledger\sdd-review-ledger-opencode.js"
$rulesSource = Join-Path $repoRoot "plugins\sdd-review-ledger\sdd-review-rules.md"
$pluginTarget = Join-Path $workRoot ".opencode\plugins\sdd-review-ledger-opencode.js"
$rulesTarget = Join-Path $workRoot ".opencode\plugins\sdd-review-rules.md"
$summaryJson = Join-Path $workRoot "workflow-summary.json"
$summaryMd = Join-Path $workRoot "workflow-report.md"
$todoPath = Join-Path $workRoot ".sdd-review-todo.md"
$ledgerPath = Join-Path $workRoot ".git\sdd-review-ledger-state\ledger.json"

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

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $text = if ($null -eq $Value) { "" } else { [string]$Value }
  if (!$NoNewline) {
    $text = $text + [Environment]::NewLine
  }

  for ($attempt = 0; $attempt -le $Retries; $attempt++) {
    try {
      [System.IO.File]::WriteAllText($LiteralPath, $text, $utf8NoBom)
      return
    } catch [System.IO.IOException] {
      if ($attempt -eq $Retries) {
        throw
      }
      Start-Sleep -Milliseconds 250
    }
  }
}

function Read-Text {
  param([string]$LiteralPath)
  if (!(Test-Path -LiteralPath $LiteralPath)) {
    return ""
  }
  return [string](Get-Content -LiteralPath $LiteralPath -Raw -Encoding UTF8)
}

function Count-Matches {
  param([string]$Text, [string]$Pattern)
  return ([regex]::Matches([string]$Text, $Pattern)).Count
}

function Extract-SessionId {
  param([string]$Text)
  $m = [regex]::Match([string]$Text, '"sessionID"\s*:\s*"([^"]+)"')
  if ($m.Success) {
    return $m.Groups[1].Value
  }
  return $null
}

function Snapshot-Tree {
  param([string]$Root)
  $paths = @(
    "sdd\changes\badge-greeting\design.md",
    "sdd\changes\badge-greeting\tasks.md",
    "src\badgeGreeting.ts",
    "src\badgeFormatter.ts",
    "src\index.ts",
    ".sdd-review-todo.md"
  )
  $items = @()
  foreach ($p in $paths) {
    $abs = Join-Path $Root $p
    if (Test-Path -LiteralPath $abs) {
      $items += [pscustomobject]@{
        path = ($p -replace "\\", "/")
        size = (Get-Item -LiteralPath $abs).Length
        content = (Read-Text $abs)
      }
    }
  }
  return $items
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
New-Item -ItemType Directory -Force (Join-Path $workRoot "src") | Out-Null
New-Item -ItemType Directory -Force $opencodeHome | Out-Null
Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Force
Copy-Item -LiteralPath $rulesSource -Destination $rulesTarget -Force
$packageJson = @"
{
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
"@
$tsconfigJson = @"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
"@
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot "package.json") -Value $packageJson -NoNewline
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot "tsconfig.json") -Value $tsconfigJson -NoNewline

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
    "sddflow": {
      "model": "$modelName",
      "mode": "primary",
      "permission": "allow",
      "steps": 40,
      "temperature": 0,
      "prompt": "You are running an OpenCode behavior observation for sdd-review-ledger. Execute the user's requested local file edits directly and preserve existing document headings/templates. Do not inspect .opencode, .git, logs, provider config, environment variables, or hook implementation files. If a tool result contains [SDD-REVIEW: NEEDS-REVIEW], continue the same assistant turn: read .sdd-review-todo.md, read the changed file and candidate design/tasks/code files, decide whether docs or code need sync, then read .sdd-review-todo.md again and check every currently pending path@hash you reviewed with a short evidence-based rationale. Preserve each exact path@hash. After review, return to the user's original task."
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

$marker = $runId.Substring(0, 8)
$phases = @(
  [pscustomobject]@{
    id = "01-design"
    title = "create design.md"
    prompt = "Create the SDD design document only. Create sdd/changes/badge-greeting/design.md with heading '# Design'. The design is for a TypeScript badge greeting utility identified by workflow marker $marker. It should describe an exported function that returns a user-facing greeting badge from a user name and numeric level. Do not create tasks or code yet."
  },
  [pscustomobject]@{
    id = "02-tasks"
    title = "create tasks.md"
    prompt = "Based on sdd/changes/badge-greeting/design.md, create sdd/changes/badge-greeting/tasks.md with heading '# Tasks'. Add a short checklist for implementing the badge greeting utility. Do not create code yet."
  },
  [pscustomobject]@{
    id = "03-code-from-tasks"
    title = "implement code from tasks"
    prompt = "Read sdd/changes/badge-greeting/tasks.md and implement the code it asks for. Create src/badgeGreeting.ts and src/index.ts. The exported greeting result must include the marker '$marker'."
  },
  [pscustomobject]@{
    id = "04-multi-code"
    title = "modify code multiple times"
    prompt = "Make two follow-up code changes in this same turn: first update src/badgeGreeting.ts to handle an empty user name as 'guest-$marker'; second create or update src/badgeFormatter.ts and use it from src/badgeGreeting.ts. Preserve the public API."
  },
  [pscustomobject]@{
    id = "05-design-change"
    title = "revise design.md after code"
    prompt = "Revise sdd/changes/badge-greeting/design.md. Preserve the '# Design' heading and existing style. Add that premium users at level 5 or higher should get a VIP badge prefix. Do not update code in this phase unless the SDD review reminder explicitly requires it."
  },
  [pscustomobject]@{
    id = "06-code-after-design"
    title = "modify code after design change"
    prompt = "Read the updated sdd/changes/badge-greeting/design.md, then modify code to support the VIP badge prefix for level 5 or higher. Keep the marker '$marker' in returned strings."
  },
  [pscustomobject]@{
    id = "07-tasks-change"
    title = "revise tasks.md after code"
    prompt = "Revise sdd/changes/badge-greeting/tasks.md. Preserve the '# Tasks' heading and existing checklist style. Mark completed implementation items as checked and add one checked item mentioning VIP badge support and marker $marker."
  }
)

$previousHome = $env:HOME
$previousUserProfile = $env:USERPROFILE
$env:HOME = $opencodeHome
$env:USERPROFILE = $opencodeHome

$activeSessionId = $null
$phaseResults = @()
try {
  for ($phaseIndex = 0; $phaseIndex -lt $phases.Count; $phaseIndex++) {
    $phase = $phases[$phaseIndex]
    if ($Scenario -eq "split-at-04" -and $phase.id -eq "04-multi-code") {
      $activeSessionId = $null
    }

    $outLog = Join-Path $workRoot "$($phase.id).out.jsonl"
    $errLog = Join-Path $workRoot "$($phase.id).err.log"
    $args = @("run", "--print-logs", "--log-level", "DEBUG", "--agent", "sddflow", "--format", "json", "--dir", $workRoot)
    if ($activeSessionId) {
      $args += @("--session", $activeSessionId)
    }
    $args += $phase.prompt

    Push-Location $workRoot
    try {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      & $opencodeBin @args > $outLog 2> $errLog
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
      Pop-Location
    }

    $outText = Read-Text $outLog
    $errText = Read-Text $errLog
    if (!$activeSessionId) {
      $activeSessionId = Extract-SessionId $outText
    }

    $todoText = Read-Text $todoPath
    $injectedCount = Count-Matches $outText '"sddReviewLedger"\s*:\s*\{"injected"\s*:\s*true'
    $phaseResults += [pscustomobject]@{
      id = $phase.id
      title = $phase.title
      exitCode = $exitCode
      sessionId = $activeSessionId
      reminderCount = $injectedCount
      injectedMetadataCount = $injectedCount
      pendingTodoCount = Count-Matches $todoText "(?m)^- \[ \] "
      checkedTodoCount = Count-Matches $todoText "(?m)^- \[x\] "
      opencodeErrorCount = Count-Matches $errText "(?i)\b(error|exception|failed)\b"
      stdout = $outLog
      stderr = $errLog
      files = Snapshot-Tree $workRoot
    }

    if ($exitCode -ne 0) {
      break
    }
  }
} finally {
  $env:HOME = $previousHome
  $env:USERPROFILE = $previousUserProfile
}

$summary = [pscustomobject]@{
  provider = $Provider
  model = $modelName
  scenario = $Scenario
  runId = $runId
  marker = $marker
  workRoot = $workRoot
  sessionIds = @($phaseResults | Select-Object -ExpandProperty sessionId -Unique)
  phases = $phaseResults
  ledgerExists = (Test-Path -LiteralPath $ledgerPath)
  todoExists = (Test-Path -LiteralPath $todoPath)
}

Set-ContentWithRetry -LiteralPath $summaryJson -Value ($summary | ConvertTo-Json -Depth 8) -NoNewline

$report = @()
$report += "# SDD Review Ledger Workflow Observation"
$report += ""
$report += "- Provider: $Provider"
$report += "- Model: $modelName"
$report += "- Scenario: $Scenario"
$report += "- RunId: $runId"
$report += "- Marker: $marker"
$report += "- WorkRoot: $workRoot"
$report += "- SessionIds: $((@($phaseResults | Select-Object -ExpandProperty sessionId -Unique) -join ', '))"
$report += ""
$report += "## Phase Summary"
$report += ""
$report += "| Phase | Session | Exit | Reminders | Injected Metadata | Pending Todo | Checked Todo | Error Words |"
$report += "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"
foreach ($r in $phaseResults) {
  $report += "| $($r.id) $($r.title) | $($r.sessionId) | $($r.exitCode) | $($r.reminderCount) | $($r.injectedMetadataCount) | $($r.pendingTodoCount) | $($r.checkedTodoCount) | $($r.opencodeErrorCount) |"
}
$report += ""
$report += "## Final Todo"
$report += ""
$report += '```markdown'
$report += (Read-Text $todoPath)
$report += '```'
$report += ""
$report += "## Final Files"
foreach ($file in (Snapshot-Tree $workRoot)) {
  if ($file.path -eq ".sdd-review-todo.md") {
    continue
  }
  $report += ""
  $report += "### $($file.path)"
  $report += ""
  $report += '```'
  $report += $file.content
  $report += '```'
}
Set-ContentWithRetry -LiteralPath $summaryMd -Value ($report -join "`n") -NoNewline

Write-Output "PROVIDER=$Provider"
Write-Output "MODEL=$modelName"
Write-Output "SCENARIO=$Scenario"
Write-Output "RUN_ID=$runId"
Write-Output "MARKER=$marker"
Write-Output "WORKROOT=$workRoot"
Write-Output "SESSION_IDS=$((@($phaseResults | Select-Object -ExpandProperty sessionId -Unique) -join ', '))"
Write-Output "SUMMARY_JSON=$summaryJson"
Write-Output "SUMMARY_MD=$summaryMd"
Write-Output "--- Phase Summary ---"
$phaseResults | Select-Object id,title,sessionId,exitCode,reminderCount,injectedMetadataCount,pendingTodoCount,checkedTodoCount,opencodeErrorCount | Format-Table -AutoSize
Write-Output "--- Final Todo ---"
if (Test-Path -LiteralPath $todoPath) {
  Get-Content -LiteralPath $todoPath -Encoding UTF8
} else {
  Write-Output "<missing>"
}
