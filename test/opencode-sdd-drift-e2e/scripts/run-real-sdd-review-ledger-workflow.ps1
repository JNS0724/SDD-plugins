param(
  [ValidateSet("deepseek", "minimax")]
  [string]$Provider = "deepseek",

  [ValidateSet("single-session", "split-at-04", "split-multi")]
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

function Get-TodoEntries {
  param([string]$Text)
  $entries = @()
  foreach ($line in (([string]$Text) -split "`r?`n")) {
    $m = [regex]::Match($line, "^- \[( |x)\] ([^\s]+@[0-9a-f]+)(.*)$")
    if ($m.Success) {
      $tail = $m.Groups[3].Value.Trim()
      $candidate = ""
      $cm = [regex]::Match($tail, "\((?:candidate|[^:()]+):\s*([^)]+)\)")
      if ($cm.Success) {
        $candidate = $cm.Groups[1].Value.Trim()
      }
      $rationale = ""
      $dash = $tail.IndexOf(" - ")
      if ($dash -lt 0) {
        $dash = $tail.IndexOf(" -- ")
      }
      if ($dash -ge 0) {
        $rationale = $tail.Substring($dash).Trim(" ", "-")
      }
      $entries += [pscustomobject]@{
        checked = ($m.Groups[1].Value -eq "x")
        key = $m.Groups[2].Value
        candidate = $candidate
        rationale = $rationale
        line = $line
      }
    }
  }
  return $entries
}

function Get-PendingKeys {
  param([string]$Text)
  return @((Get-TodoEntries $Text) | Where-Object { !$_.checked } | ForEach-Object { $_.key })
}

function Get-CheckedKeys {
  param([string]$Text)
  return @((Get-TodoEntries $Text) | Where-Object { $_.checked } | ForEach-Object { $_.key })
}

function Compare-StringSets {
  param([string[]]$Before, [string[]]$After)
  $beforeSet = @{}
  foreach ($item in @($Before)) {
    if ($item) { $beforeSet[$item] = $true }
  }
  $afterSet = @{}
  foreach ($item in @($After)) {
    if ($item) { $afterSet[$item] = $true }
  }
  $added = @()
  foreach ($item in $afterSet.Keys) {
    if (!$beforeSet.ContainsKey($item)) { $added += $item }
  }
  $cleared = @()
  foreach ($item in $beforeSet.Keys) {
    if (!$afterSet.ContainsKey($item)) { $cleared += $item }
  }
  return [pscustomobject]@{
    added = @($added | Sort-Object)
    cleared = @($cleared | Sort-Object)
  }
}

function Get-JsonlEvents {
  param([string]$LiteralPath)
  $events = @()
  if (!(Test-Path -LiteralPath $LiteralPath)) {
    return $events
  }
  foreach ($line in (Get-Content -LiteralPath $LiteralPath -Encoding UTF8)) {
    if (!$line.Trim()) {
      continue
    }
    try {
      $events += ($line | ConvertFrom-Json -Depth 100)
    } catch {
      # Keep the workflow runner tolerant of provider/debug lines that are not JSON.
    }
  }
  return $events
}

function Convert-ToRelativePath {
  param([string]$Root, [string]$PathValue)
  if (!$PathValue) {
    return ""
  }
  $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
  $fullPath = [System.IO.Path]::GetFullPath($PathValue)
  if ($fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return ($fullPath.Substring($fullRoot.Length).TrimStart("\", "/") -replace "\\", "/")
  }
  return ($PathValue -replace "\\", "/")
}

function Get-ReadEvidence {
  param([string]$Text, [string]$Root)
  $afterInjection = $false
  $paths = @()
  foreach ($line in (([string]$Text) -split "`r?`n")) {
    if (!$line.Trim()) {
      continue
    }
    if ($line -match "\[SDD-REVIEW: NEEDS-REVIEW\]" -or $line -match '"sddReviewLedger"\s*:\s*\{"injected"\s*:\s*true') {
      $afterInjection = $true
    }
    if (!$afterInjection) {
      continue
    }
    if ($line -match '"tool"\s*:\s*"read"') {
      $m = [regex]::Match($line, '"filePath"\s*:\s*"((?:\\.|[^"\\])*)"')
      if ($m.Success) {
        $fp = $m.Groups[1].Value
        try {
          $fp = [regex]::Unescape($fp)
        } catch {
          $fp = $fp -replace "\\\\", "\"
        }
        $paths += (Convert-ToRelativePath $Root $fp)
      }
    }
  }

  $unique = @($paths | Where-Object { $_ } | Select-Object -Unique)
  return [pscustomobject]@{
    paths = $unique
    design = [bool](@($unique | Where-Object { $_ -match "(^|/)design\.md$" }).Count)
    tasks = [bool](@($unique | Where-Object { $_ -match "(^|/)tasks\.md$" }).Count)
    code = [bool](@($unique | Where-Object { $_ -match "^src/.+\.ts$" }).Count)
    todo = [bool](@($unique | Where-Object { $_ -eq ".sdd-review-todo.md" }).Count)
  }
}

function Get-InjectionStats {
  param([string]$Text)
  $metadataCount = Count-Matches $Text '"sddReviewLedger"\s*:\s*\{"injected"\s*:\s*true'
  $needsReviewCount = Count-Matches $Text "\[SDD-REVIEW: NEEDS-REVIEW\]"
  $leftoverCount = Count-Matches $Text "(?i)leftover|review-after-edit|after review"
  $carryCount = Count-Matches $Text "(?i)\bcarry\b|previous turn|previous session"
  $fullCount = $metadataCount
  $compactCount = 0
  if ($needsReviewCount -gt $metadataCount) {
    $compactCount = $needsReviewCount - $metadataCount
  }
  $types = @()
  if ($fullCount -gt 0) { $types += "full:$fullCount" }
  if ($compactCount -gt 0) { $types += "compact:$compactCount" }
  if ($leftoverCount -gt 0) { $types += "leftover-short:$leftoverCount" }
  if ($carryCount -gt 0) { $types += "carry:$carryCount" }
  if ($types.Count -eq 0) { $types += "none" }
  return [pscustomobject]@{
    metadataCount = $metadataCount
    needsReviewCount = $needsReviewCount
    fullCount = $fullCount
    compactCount = $compactCount
    leftoverShortCount = $leftoverCount
    carryCount = $carryCount
    summary = ($types -join ", ")
  }
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
    "sdd\changes\vip-tiers\design.md",
    "sdd\changes\vip-tiers\tasks.md",
    "sdd\changes\i18n-locale\design.md",
    "sdd\changes\i18n-locale\tasks.md",
    "sdd\changes\audit-log\design.md",
    "sdd\changes\audit-log\tasks.md",
    "src\badgeGreeting.ts",
    "src\badgeFormatter.ts",
    "src\tiers.ts",
    "src\locale.ts",
    "src\auditLog.ts",
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
New-Item -ItemType Directory -Force (Join-Path $workRoot "scripts") | Out-Null
New-Item -ItemType Directory -Force $opencodeHome | Out-Null
Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Force
Copy-Item -LiteralPath $rulesSource -Destination $rulesTarget -Force
$packageJson = @"
{
  "type": "module",
  "scripts": {
    "check": "node ./scripts/check.mjs"
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
$checkScript = @'
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const src = join(root, 'src');
if (!existsSync(src)) {
  throw new Error('missing src directory');
}

const files = [];
const visit = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) visit(abs);
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(abs);
  }
};
visit(src);
if (files.length === 0) {
  throw new Error('no TypeScript files under src');
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('SYNTAX_ERROR_SENTINEL')) {
    throw new Error(`synthetic check failed for ${file}`);
  }
}

console.log(`checked ${files.length} TypeScript files`);
'@
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot "package.json") -Value $packageJson -NoNewline
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot "tsconfig.json") -Value $tsconfigJson -NoNewline
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot "scripts\check.mjs") -Value $checkScript -NoNewline

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
    id = "P01-design-only"
    title = "create design.md"
    prompt = "Create the SDD design document only. Create sdd/changes/badge-greeting/design.md with heading '# Design'. The design is for a TypeScript badge greeting utility identified by workflow marker $marker. It should describe an exported getBadgeGreeting(name, level) function that returns a user-facing greeting badge from a user name and numeric level. Do not create tasks or code yet."
  },
  [pscustomobject]@{
    id = "P02-tasks-only"
    title = "create tasks.md"
    prompt = "Based on sdd/changes/badge-greeting/design.md, create sdd/changes/badge-greeting/tasks.md with heading '# Tasks'. Add a short checklist for implementing the badge greeting utility. Do not create code yet."
  },
  [pscustomobject]@{
    id = "P03-code-from-tasks"
    title = "implement code from tasks"
    prompt = "Read sdd/changes/badge-greeting/tasks.md and implement the code it asks for. Create src/badgeGreeting.ts and src/index.ts. The exported greeting result must include the marker '$marker'."
  },
  [pscustomobject]@{
    id = "P04-multi-code"
    title = "modify code multiple times"
    prompt = "Make two follow-up code changes in this same turn: first update src/badgeGreeting.ts to handle an empty user name as 'guest-$marker'; second create or update src/badgeFormatter.ts and use it from src/badgeGreeting.ts. Preserve the public API."
  },
  [pscustomobject]@{
    id = "P05-design-change"
    title = "revise design.md after code"
    prompt = "Revise sdd/changes/badge-greeting/design.md. Preserve the '# Design' heading and existing style. Add that users at level 5 or higher should get a VIP badge prefix. This phase is design planning only: do not update code unless an SDD review reminder explicitly requires it."
  },
  [pscustomobject]@{
    id = "P06-code-after-design-then-tasks"
    title = "modify code after design change"
    prompt = "Read the updated sdd/changes/badge-greeting/design.md, then modify code to support the VIP badge prefix for level 5 or higher. Keep the marker '$marker' in returned strings. After any SDD review caused by the code edit is complete, update sdd/changes/badge-greeting/tasks.md in the same assistant turn to mention the completed VIP support, preserving the '# Tasks' heading and checklist style."
  },
  [pscustomobject]@{
    id = "P07-benign-refactor"
    title = "benign code refactor"
    prompt = "Make a behavior-preserving cleanup in src/badgeFormatter.ts only: rename one local helper or adjust formatting without changing the exported behavior, marker '$marker', empty-name handling, or VIP behavior. If SDD review is requested, record a concise evidence-based no-doc-change rationale."
  },
  [pscustomobject]@{
    id = "P08-vip-design-new-session"
    title = "create vip-tiers design.md"
    prompt = "Create a second SDD design document only. Create sdd/changes/vip-tiers/design.md with heading '# Design'. It should define tier labels for numeric levels and explain how tier labels relate to badge greeting output. Use workflow marker $marker. Do not create tasks or code yet."
  },
  [pscustomobject]@{
    id = "P09-vip-code-shared-file"
    title = "implement vip tiers and shared code"
    prompt = "Create sdd/changes/vip-tiers/tasks.md with heading '# Tasks' based on vip-tiers/design.md, then implement the tier rules by creating src/tiers.ts and updating the shared src/badgeGreeting.ts to use those tier labels. The output must still include marker '$marker'."
  },
  [pscustomobject]@{
    id = "P10-cross-cutting-refactor"
    title = "cross-cutting code refactor"
    prompt = "Do a cross-cutting behavior-preserving refactor across src/badgeGreeting.ts, src/tiers.ts, and src/badgeFormatter.ts. Keep the public API and visible strings compatible, keep marker '$marker', and do not edit SDD documents unless SDD review finds a real mismatch."
  },
  [pscustomobject]@{
    id = "P11-i18n-docs-only"
    title = "create i18n design and tasks"
    prompt = "Create a third SDD change directory for i18n. Create sdd/changes/i18n-locale/design.md with heading '# Design' and sdd/changes/i18n-locale/tasks.md with heading '# Tasks'. The feature should describe locale-aware greeting labels for English and Simplified Chinese. This phase is docs only; do not create or update code."
  },
  [pscustomobject]@{
    id = "P12-i18n-code"
    title = "implement i18n locale module"
    prompt = "Read sdd/changes/i18n-locale/design.md and tasks.md, then implement the i18n feature by creating src/locale.ts and updating src/badgeGreeting.ts only as needed. Preserve existing badge behavior and marker '$marker'. If SDD review is requested, read the relevant design/tasks/code before checking todo items."
  },
  [pscustomobject]@{
    id = "P13-review-then-edit-design"
    title = "review then edit i18n design"
    prompt = "Make a small code adjustment in src/locale.ts, complete any SDD review it triggers, and then before the final response revise sdd/changes/i18n-locale/design.md to clarify fallback locale behavior. This intentionally leaves a review-after-edit situation for the next checkpoint."
  },
  [pscustomobject]@{
    id = "P14-audit-log-long-task"
    title = "long audit-log feature with check"
    prompt = "Create sdd/changes/audit-log/design.md and tasks.md, then implement src/auditLog.ts and wire audit logging calls into badge/tier/locale related code where appropriate. Run npm run check before finishing. Keep marker '$marker' visible in at least one audit event or output path."
  },
  [pscustomobject]@{
    id = "P15-delete-i18n-module"
    title = "delete code module"
    prompt = "Simulate removing the i18n implementation: delete src/locale.ts if it exists and remove any imports or exports that reference it. Do not delete the i18n SDD documents. This should leave docs leading code, not force implementation."
  },
  [pscustomobject]@{
    id = "P16-code-leading-bugfix"
    title = "code-leading bug fix"
    prompt = "Apply a bug fix directly in src/tiers.ts: level 10 or higher should use a stronger top-tier label than normal VIP. Do not edit design/tasks first. If SDD review is requested, decide whether sdd/changes/vip-tiers/design.md or tasks.md must be synchronized to this code behavior."
  },
  [pscustomobject]@{
    id = "P17-review-disabled-change"
    title = "escape hatch disabled"
    env = @{ SDD_REVIEW = "off" }
    prompt = "With SDD_REVIEW disabled for this phase, make one small code-only change in src/auditLog.ts or src/badgeFormatter.ts that preserves behavior and marker '$marker'. Do not perform SDD review in this phase."
  },
  [pscustomobject]@{
    id = "P18-final-leftover-and-wrap"
    title = "final review-after-edit wrap"
    prompt = "Make a final small code change touching src/badgeGreeting.ts, complete any SDD review it triggers with evidence, then update the most relevant tasks.md to record the final implementation detail. After that read .sdd-review-todo.md and report whether any pending entries remain, naming exact path@hash values if present."
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
    if ($Scenario -eq "split-at-04" -and $phase.id -eq "P04-multi-code") {
      $activeSessionId = $null
    }
    if ($Scenario -eq "split-multi" -and @("P08-vip-design-new-session", "P14-audit-log-long-task") -contains $phase.id) {
      $activeSessionId = $null
    }

    $beforeTodoText = Read-Text $todoPath
    $beforePendingKeys = Get-PendingKeys $beforeTodoText
    $beforeCheckedKeys = Get-CheckedKeys $beforeTodoText
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
      $previousSddReview = $env:SDD_REVIEW
      if ($phase.PSObject.Properties.Name -contains "env" -and $phase.env) {
        foreach ($key in $phase.env.Keys) {
          Set-Item "Env:\$key" $phase.env[$key]
        }
      }
      $ErrorActionPreference = "Continue"
      & $opencodeBin @args > $outLog 2> $errLog
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
      if ($null -eq $previousSddReview) {
        Remove-Item Env:\SDD_REVIEW -ErrorAction SilentlyContinue
      } else {
        $env:SDD_REVIEW = $previousSddReview
      }
      Pop-Location
    }

    $outText = Read-Text $outLog
    $errText = Read-Text $errLog
    if (!$activeSessionId) {
      $activeSessionId = Extract-SessionId $outText
    }

    $todoText = Read-Text $todoPath
    $afterPendingKeys = Get-PendingKeys $todoText
    $afterCheckedKeys = Get-CheckedKeys $todoText
    $pendingDelta = Compare-StringSets $beforePendingKeys $afterPendingKeys
    $checkedDelta = Compare-StringSets $beforeCheckedKeys $afterCheckedKeys
    $injectionStats = Get-InjectionStats $outText
    $readEvidence = Get-ReadEvidence -Text $outText -Root $workRoot
    $phaseResults += [pscustomobject]@{
      id = $phase.id
      title = $phase.title
      exitCode = $exitCode
      sessionId = $activeSessionId
      reminderCount = $injectionStats.needsReviewCount
      injectedMetadataCount = $injectionStats.metadataCount
      injectionTypes = $injectionStats.summary
      pendingTodoCount = @($afterPendingKeys).Count
      checkedTodoCount = @($afterCheckedKeys).Count
      pendingAdded = @($pendingDelta.added)
      pendingCleared = @($pendingDelta.cleared)
      checkedAdded = @($checkedDelta.added)
      readEvidence = $readEvidence
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

Set-ContentWithRetry -LiteralPath $summaryJson -Value ($summary | ConvertTo-Json -Depth 12) -NoNewline

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
$report += "| Phase | Session | Exit | Injection Types | Reminders | Pending Todo | Checked Todo | Pending Added | Pending Cleared | Read Evidence | Error Words |"
$report += "| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | ---: |"
foreach ($r in $phaseResults) {
  $readSummary = "design=$($r.readEvidence.design); tasks=$($r.readEvidence.tasks); code=$($r.readEvidence.code); todo=$($r.readEvidence.todo)"
  $report += "| $($r.id) $($r.title) | $($r.sessionId) | $($r.exitCode) | $($r.injectionTypes) | $($r.reminderCount) | $($r.pendingTodoCount) | $($r.checkedTodoCount) | $((@($r.pendingAdded) -join '<br>')) | $((@($r.pendingCleared) -join '<br>')) | $readSummary | $($r.opencodeErrorCount) |"
}
$report += ""
$report += "## Read Evidence Details"
$report += ""
foreach ($r in $phaseResults) {
  $report += "### $($r.id)"
  $report += ""
  if (@($r.readEvidence.paths).Count -eq 0) {
    $report += "- No read tool calls after first SDD injection were captured."
  } else {
    foreach ($p in @($r.readEvidence.paths)) {
      $report += "- $p"
    }
  }
  $report += ""
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
$phaseResults | Select-Object id,title,sessionId,exitCode,injectionTypes,reminderCount,pendingTodoCount,checkedTodoCount,opencodeErrorCount | Format-Table -AutoSize
Write-Output "--- Final Todo ---"
if (Test-Path -LiteralPath $todoPath) {
  Get-Content -LiteralPath $todoPath -Encoding UTF8
} else {
  Write-Output "<missing>"
}
