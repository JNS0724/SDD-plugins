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
$workRoot = Join-Path $root ".real-workspaces\snake-$Provider-$runId"
$opencodeHome = Join-Path $workRoot ".home"
$hookSource = Join-Path $repoRoot "plugins\sdd-drift-check\sdd-drift-check-hook.js"
$hookTarget = Join-Path $workRoot ".opencode\hooks\sdd-drift-check\sdd-drift-check-hook.js"
$opencodeBin = Join-Path $root "node_modules\.bin\opencode.cmd"
$configTemplate = Join-Path $root ".opencode\opencode.$Provider.jsonc.example"
$configPath = Join-Path $root ".opencode\opencode.jsonc"
$workConfigPath = Join-Path $workRoot ".opencode\opencode.jsonc"
$configBackupPath = Join-Path $root ".opencode\opencode.snake-backup.tmp"
$ohmyConfigPath = Join-Path $root ".opencode\oh-my-openagent.jsonc"
$ohmyBackupPath = Join-Path $root ".opencode\oh-my-openagent.snake-backup.tmp"
$settingsPath = Join-Path $root ".claude\settings.json"
$settingsBackupPath = Join-Path $root ".claude\settings.snake-backup.tmp"

if (!(Test-Path -LiteralPath $opencodeBin)) {
  throw "missing opencode binary; run npm install in $root"
}
if (!(Test-Path -LiteralPath $configTemplate)) {
  throw "missing provider config template: $configTemplate"
}
if (Test-Path -LiteralPath $configBackupPath) {
  throw "opencode snake config backup already exists; another run may be active: $configBackupPath"
}
if (Test-Path -LiteralPath $ohmyBackupPath) {
  throw "oh-my-opencode snake config backup already exists; another run may be active: $ohmyBackupPath"
}
if (Test-Path -LiteralPath $settingsBackupPath) {
  throw "Claude-compatible hook settings snake backup already exists; another run may be active: $settingsBackupPath"
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

New-Item -ItemType Directory -Force $workRoot | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot ".opencode\plugin") | Out-Null
New-Item -ItemType Directory -Force (Split-Path -Parent $hookTarget) | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot ".claude") | Out-Null
New-Item -ItemType Directory -Force $opencodeHome | Out-Null
New-Item -ItemType Directory -Force (Join-Path $workRoot "sdd\changes\snake-game") | Out-Null
Copy-Item -LiteralPath $hookSource -Destination $hookTarget -Force

Set-ContentWithRetry -LiteralPath (Join-Path $workRoot ".gitignore") -Value @"
.home/
.sdd-drift-hook-state/
.sdd-drift-report.md
*.log
"@ -NoNewline

Set-ContentWithRetry -LiteralPath (Join-Path $workRoot ".opencode\plugin\oh-my-opencode.ts") -Value 'export { default } from "oh-my-opencode"' -NoNewline

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
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot ".opencode\oh-my-openagent.jsonc") -Value $ohmyConfig -NoNewline

$settings = @"
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Question|question|AskUserQuestion|ask_user_question|askuserquestion|Confirm|confirm",
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Edit|Write|MultiEdit|read|edit|write|multiedit|multi_edit|Task|task|call_omo_agent|background_output|delegate_task|Question|question|AskUserQuestion|ask_user_question|askuserquestion|Confirm|confirm",
        "hooks": [
          {
            "type": "command",
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
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
            "command": "node .opencode/hooks/sdd-drift-check/sdd-drift-check-hook.js"
          }
        ]
      }
    ]
  }
}
"@
Set-ContentWithRetry -LiteralPath (Join-Path $workRoot ".claude\settings.json") -Value $settings -NoNewline

$config = Get-Content -LiteralPath $configTemplate -Raw
if ($Provider -eq "minimax") {
  $config = $config -replace "https://api\.minimax(?:i)?\.com/v1", $minimaxBaseUrl.TrimEnd("/")
}
$modelName = if ($Provider -eq "deepseek") { "deepseek/deepseek-chat" } else { "minimax/MiniMax-M2.7" }
$snakeAgent = @"
  "agent": {
    "snake-dev": {
      "model": "$modelName",
      "mode": "primary",
      "permission": "allow",
      "steps": 40,
      "temperature": 0,
      "prompt": "You are building a real no-dependency browser Snake project while validating an SDD drift hook. Work decisively in local files. Use Read, Write, Edit, or MultiEdit for all file creation and edits so hooks can observe the changes. Do not inspect .opencode, .claude, .git, logs, provider config, environment variables, or hook implementation files. Bash is allowed only for final verification commands such as node --check. If any tool result contains SDD drift enforcement or a compact SDD drift reminder, continue the same assistant turn and perform the requested SDD review or synchronization before giving a final answer. When editing SDD docs, preserve their existing headings and template; do not add new sections just to satisfy the hook."
    },
    "build": {
      "model": "$modelName",
      "permission": "allow",
      "steps": 8
    },
    "title": {
      "model": "$modelName",
      "permission": "allow",
      "steps": 1
    }
  }
"@
$config = $config -replace '"agent"\s*:\s*\{[\s\S]*\}\s*\n\}', ($snakeAgent + "`n}")
$config = $config -replace '"default_agent"\s*:\s*"[^"]+"', '"default_agent": "snake-dev"'
$config = $config -replace '"permission"\s*:\s*"allow"', '"permission": "allow"'

$configHadFile = Test-Path -LiteralPath $configPath
$configBackup = if ($configHadFile) { Get-Content -LiteralPath $configPath -Raw } else { $null }
$ohmyHadFile = Test-Path -LiteralPath $ohmyConfigPath
$ohmyBackup = if ($ohmyHadFile) { Get-Content -LiteralPath $ohmyConfigPath -Raw } else { $null }
$settingsHadFile = Test-Path -LiteralPath $settingsPath
$settingsBackup = if ($settingsHadFile) { Get-Content -LiteralPath $settingsPath -Raw } else { $null }

Set-ContentWithRetry -LiteralPath $configBackupPath -Value $configBackup -NoNewline
Set-ContentWithRetry -LiteralPath $configPath -Value $config -NoNewline
Set-ContentWithRetry -LiteralPath $workConfigPath -Value $config -NoNewline
Set-ContentWithRetry -LiteralPath $ohmyBackupPath -Value $ohmyBackup -NoNewline
Set-ContentWithRetry -LiteralPath $ohmyConfigPath -Value $ohmyConfig -NoNewline
Set-ContentWithRetry -LiteralPath $settingsBackupPath -Value $settingsBackup -NoNewline
Set-ContentWithRetry -LiteralPath $settingsPath -Value $settings -NoNewline

Push-Location $workRoot
try {
  & git init | Out-Null
} finally {
  Pop-Location
}

$previousHome = $env:HOME
$previousUserProfile = $env:USERPROFILE
$previousOmoTelemetry = $env:OMO_SEND_ANONYMOUS_TELEMETRY
$previousOmoPosthog = $env:OMO_DISABLE_POSTHOG
$previousOutputMode = $env:SDD_DRIFT_OUTPUT
$env:HOME = $opencodeHome
$env:USERPROFILE = $opencodeHome
$env:OMO_SEND_ANONYMOUS_TELEMETRY = "0"
$env:OMO_DISABLE_POSTHOG = "1"
$env:SDD_DRIFT_OUTPUT = "opencode"

$phasePrompts = @(
  @"
Stage 1 of a real Snake project. Create the SDD change package only; do not implement app code yet.

Use the already-created sdd/changes/snake-game directory exactly. Do not create .sdd or numbered change directories.
Create sdd/changes/snake-game/proposal.md, sdd/changes/snake-game/design.md, and sdd/changes/snake-game/tasks.md in that order.
Use concise stable templates:
- proposal.md headings: # Proposal, ## Objective, ## Scope, ## Acceptance Criteria.
- design.md headings: # Design, ## Gameplay, ## Architecture, ## UX, ## Risks.
- tasks.md headings: # Tasks, ## Plan.

Plan a no-dependency browser Snake game using index.html, src/game.js, src/styles.css, and README.md. Include keyboard controls, pause/resume, restart, score, high score persistence, responsive layout, and touch controls. Do not inspect config or hook files. Finish after the SDD docs are written.
"@,
  @"
Stage 2 of the same Snake project. Implement the playable core.

Read sdd/changes/snake-game/design.md and sdd/changes/snake-game/tasks.md first, then create index.html, src/game.js, src/styles.css, and README.md. Use only browser-native HTML/CSS/JS. Keep application JavaScript in src/game.js and styling in src/styles.css; index.html should link those files. The game must render on canvas, move the snake with Arrow keys and WASD, spawn food, grow, detect wall/self collision, update score, and restart cleanly.

After code edits, obey any SDD drift reminder by reviewing design.md and tasks.md. Update tasks.md only where existing task lines should be checked or clarified; preserve the existing headings. Run node --check src/game.js before finishing.
"@,
  @"
Stage 3 of the same Snake project. Polish and finish.

Add or verify pause/resume, high score via localStorage, mobile/touch direction controls, responsive sizing, start/restart UI, and clear game-over feedback. Then review sdd/changes/snake-game/design.md and sdd/changes/snake-game/tasks.md after the final code edits; update only existing relevant lines if the docs are stale. Do not create extra SDD sections.

Run node --check src/game.js and finish with a concise completion summary.
"@,
  @"
Stage 4 final delivery check.

Create README.md if it is missing. The README must explain how to open index.html, controls, implemented features, and where the SDD documents live. Do not inspect .opencode, .claude, .git, logs, provider config, environment variables, or hook files. Do not modify game code or SDD docs unless an SDD drift reminder explicitly requires it.

Finish with a concise completion summary.
"@
)

$opencodeExit = 0
try {
  for ($i = 0; $i -lt $phasePrompts.Count; $i++) {
    $phase = $i + 1
    $outLog = Join-Path $workRoot "opencode-phase-$phase.out.log"
    $errLog = Join-Path $workRoot "opencode-phase-$phase.err.log"
    $args = @("run", "--print-logs", "--log-level", "DEBUG", "--agent", "snake-dev", "--format", "json", "--dir", $workRoot)
    if ($phase -gt 1) {
      $args += "--continue"
    }
    $args += $phasePrompts[$i]

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

    Write-Output "PHASE_$phase`_EXIT=$opencodeExit"
    Write-Output "PHASE_$phase`_OUT=$outLog"
    Write-Output "PHASE_$phase`_ERR=$errLog"
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

  if (Test-Path -LiteralPath $configBackupPath) {
    if ($configHadFile) {
      Set-ContentWithRetry -LiteralPath $configPath -Value (Get-Content -LiteralPath $configBackupPath -Raw) -NoNewline
    } elseif (Test-Path -LiteralPath $configPath) {
      Remove-Item -LiteralPath $configPath -Force
    }
    Remove-Item -LiteralPath $configBackupPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $ohmyBackupPath) {
    if ($ohmyHadFile) {
      Set-ContentWithRetry -LiteralPath $ohmyConfigPath -Value (Get-Content -LiteralPath $ohmyBackupPath -Raw) -NoNewline
    } elseif (Test-Path -LiteralPath $ohmyConfigPath) {
      Remove-Item -LiteralPath $ohmyConfigPath -Force
    }
    Remove-Item -LiteralPath $ohmyBackupPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $settingsBackupPath) {
    if ($settingsHadFile) {
      Set-ContentWithRetry -LiteralPath $settingsPath -Value (Get-Content -LiteralPath $settingsBackupPath -Raw) -NoNewline
    } elseif (Test-Path -LiteralPath $settingsPath) {
      Remove-Item -LiteralPath $settingsPath -Force
    }
    Remove-Item -LiteralPath $settingsBackupPath -Force -ErrorAction SilentlyContinue
  }
}

Write-Output "WORKROOT=$workRoot"
if ($opencodeExit -ne 0) {
  exit $opencodeExit
}

$requiredFiles = @(
  "sdd\changes\snake-game\proposal.md",
  "sdd\changes\snake-game\design.md",
  "sdd\changes\snake-game\tasks.md",
  "index.html",
  "README.md"
)
foreach ($file in $requiredFiles) {
  $path = Join-Path $workRoot $file
  if (!(Test-Path -LiteralPath $path)) {
    throw "expected generated file missing: $file"
  }
}

Push-Location $workRoot
try {
  if (Test-Path -LiteralPath "src\game.js") {
    & node --check "src\game.js"
    if ($LASTEXITCODE -ne 0) {
      throw "node --check src/game.js failed"
    }
  } else {
    & node -e "const fs=require('fs'); const html=fs.readFileSync('index.html','utf8'); const m=html.match(/<script[^>]*>([\s\S]*?)<\/script>/i); if(!m) throw new Error('missing src/game.js and inline script'); new Function(m[1]);"
    if ($LASTEXITCODE -ne 0) {
      throw "inline index.html script syntax check failed"
    }
  }
} finally {
  Pop-Location
}

$reportPath = Join-Path $workRoot ".sdd-drift-report.md"
$hookLog = Join-Path $workRoot ".git\sdd-drift-hook-state\sdd-drift-check.log.jsonl"
$logEvents = @()
if (Test-Path -LiteralPath $hookLog) {
  $logEvents = Get-Content -LiteralPath $hookLog -ErrorAction SilentlyContinue |
    ForEach-Object {
      try { (ConvertFrom-Json $_).event } catch { $null }
    } |
    Where-Object { $_ } |
    Group-Object |
    Sort-Object Name
}

Write-Output "NODE_CHECK=passed"
Write-Output "REPORT_EXISTS=$(Test-Path -LiteralPath $reportPath)"
Write-Output "HOOK_LOG=$hookLog"
Write-Output "--- hook event counts ---"
foreach ($event in $logEvents) {
  Write-Output "$($event.Name)=$($event.Count)"
}
