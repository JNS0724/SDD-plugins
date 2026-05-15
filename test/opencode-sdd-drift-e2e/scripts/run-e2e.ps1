param(
  [ValidateSet("sdd-design", "sdd-cascade", "code")]
  [string]$Scenario = "sdd-design"
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Get-FreeTcpPort {
  for ($i = 0; $i -lt 50; $i++) {
    $port = Get-Random -Minimum 20000 -Maximum 48000
    $listener = $null
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $port)
      $listener.Start()
      return $port
    } catch {
    } finally {
      if ($listener) {
        $listener.Stop()
      }
    }
  }
  throw "could not find a free localhost TCP port"
}

$root = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $root)
$runId = [guid]::NewGuid().ToString("N")
$opencodeHome = Join-Path $root ".home-e2e"
$serverOut = Join-Path $root "fake-openai.$runId.out.log"
$serverErr = Join-Path $root "fake-openai.$runId.err.log"
$runOut = Join-Path $root "opencode-run.$runId.out.log"
$runErr = Join-Path $root "opencode-run.$runId.err.log"
$ready = Join-Path $root "fake-openai.$runId.ready"
$fakeLog = Join-Path $root "fake-openai.$runId.log"
$report = Join-Path $root ".sdd-drift-report.md"
$hookState = Join-Path $repoRoot ".git\sdd-drift-hook-state"
$legacyHookState = Join-Path $root ".sdd-drift-hook-state"
$configPath = Join-Path $root ".opencode\opencode.jsonc"
$configBackupPath = Join-Path $root ".opencode\opencode.e2e-backup.tmp"
$ohmyConfigPath = Join-Path $root ".opencode\oh-my-openagent.jsonc"
$ohmyBackupPath = Join-Path $root ".opencode\oh-my-openagent.e2e-backup.tmp"
$fakePort = Get-FreeTcpPort
if (Test-Path -LiteralPath $configBackupPath) {
  throw "opencode e2e config backup already exists; another e2e run may be active: $configBackupPath"
}
if (Test-Path -LiteralPath $ohmyBackupPath) {
  throw "oh-my-opencode e2e config backup already exists; another e2e run may be active: $ohmyBackupPath"
}
$configHadFile = Test-Path -LiteralPath $configPath
$configBackup = if ($configHadFile) {
  Get-Content -LiteralPath $configPath -Raw
} else {
  $null
}
$ohmyHadFile = Test-Path -LiteralPath $ohmyConfigPath
$ohmyBackup = if ($ohmyHadFile) {
  Get-Content -LiteralPath $ohmyConfigPath -Raw
} else {
  $null
}
$fakeConfig = @'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "fake/fake-model",
  "small_model": "fake/fake-model",
  "enabled_providers": ["fake"],
  "default_agent": "sddtest",
  "autoupdate": false,
  "share": "disabled",
  "snapshot": false,
  "permission": "allow",
  "provider": {
    "fake": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Fake OpenAI-compatible provider",
      "options": {
        "baseURL": "__FAKE_BASE_URL__",
        "apiKey": "test-key"
      },
      "models": {
        "fake-model": {
          "name": "Fake Tool Model",
          "tool_call": true,
          "temperature": true,
          "limit": {
            "context": 200000,
            "output": 4096
          }
        }
      }
    }
  },
  "agent": {
    "sddtest": {
      "model": "fake/fake-model",
      "mode": "primary",
      "permission": "allow",
      "steps": 12,
      "temperature": 0,
      "prompt": "You are a deterministic local file editing agent for SDD drift validation. Execute the user's requested read/write sequence directly. Never ask clarifying questions. After any write tool result that contains SDD drift tool result enforcement, continue the same assistant turn by reading and writing the required peer document before giving a final answer."
    },
    "build": {
      "model": "fake/fake-model",
      "permission": "allow",
      "steps": 3
    },
    "title": {
      "model": "fake/fake-model",
      "permission": "allow",
      "steps": 1
    }
  }
}
'@
$fakeConfig = $fakeConfig -replace "__FAKE_BASE_URL__", "http://127.0.0.1:$fakePort/v1"
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

if (Test-Path -LiteralPath $report) {
  Clear-Content -LiteralPath $report -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $hookState) {
  Get-ChildItem -LiteralPath $hookState -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $legacyHookState) {
  Get-ChildItem -LiteralPath $legacyHookState -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Set-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\design.md") -Value "# Design`n`nInitial design."
Set-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\tasks.md") -Value "# Tasks`n`n- [ ] Keep this file unchanged during the first drift test."
Set-Content -LiteralPath (Join-Path $root "src\app.ts") -Value "export function greet(name: string) {`n  return `"hello `" + name`n}"

$env:FAKE_SCENARIO = $Scenario
$env:FAKE_LOG_PATH = $fakeLog
$env:FAKE_READY_PATH = $ready
$env:FAKE_OPENAI_PORT = "$fakePort"
$env:OMO_SEND_ANONYMOUS_TELEMETRY = "0"
$env:OMO_DISABLE_POSTHOG = "1"
Set-Content -LiteralPath $configBackupPath -Value $configBackup -NoNewline
Set-Content -LiteralPath $configPath -Value $fakeConfig -NoNewline
Set-Content -LiteralPath $ohmyBackupPath -Value $ohmyBackup -NoNewline
Set-Content -LiteralPath $ohmyConfigPath -Value $ohmyConfig -NoNewline
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

  $runArgs = @("opencode", "run", "--print-logs", "--log-level", "DEBUG", "--agent", "sddtest", "--format", "json", $prompt)

  $opencode = Start-Process npx.cmd `
    -ArgumentList $runArgs `
    -WorkingDirectory $root `
    -RedirectStandardOutput $runOut `
    -RedirectStandardError $runErr `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  $opencodeExit = $opencode.ExitCode

  if ($Scenario -eq "sdd-cascade" -or $Scenario -eq "code") {
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
  if (Test-Path -LiteralPath $configBackupPath) {
    if ($configHadFile) {
      $restoreConfig = Get-Content -LiteralPath $configBackupPath -Raw
      Set-Content -LiteralPath $configPath -Value $restoreConfig -NoNewline
    } elseif (Test-Path -LiteralPath $configPath) {
      Remove-Item -LiteralPath $configPath -Force
    }
    Remove-Item -LiteralPath $configBackupPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $ohmyBackupPath) {
    if ($ohmyHadFile) {
      $restoreOhmy = Get-Content -LiteralPath $ohmyBackupPath -Raw
      Set-Content -LiteralPath $ohmyConfigPath -Value $restoreOhmy -NoNewline
    } elseif (Test-Path -LiteralPath $ohmyConfigPath) {
      Remove-Item -LiteralPath $ohmyConfigPath -Force
    }
    Remove-Item -LiteralPath $ohmyBackupPath -Force -ErrorAction SilentlyContinue
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
} elseif ($Scenario -eq "sdd-design") {
  $fakeLogText = if (Test-Path -LiteralPath $fakeLog) {
    $content = Get-Content -LiteralPath $fakeLog -Raw
    if ($null -eq $content) { "" } else { $content }
  } else {
    ""
  }
  if ($fakeLogText -notmatch '"hasToolEnforcement":true') {
    throw "expected plugin to inject SDD drift tool result enforcement"
  }
  $reportText = if (Test-Path -LiteralPath $report) {
    $content = Get-Content -LiteralPath $report -Raw
    if ($null -eq $content) { "" } else { $content }
  } else {
    ""
  }
  if ($reportText -notmatch "missing \[tasks.md\]") {
    throw "expected unresolved SDD drift report for unsynchronized tasks.md"
  }
} elseif ($Scenario -eq "code") {
  $fakeLogText = if (Test-Path -LiteralPath $fakeLog) {
    $content = Get-Content -LiteralPath $fakeLog -Raw
    if ($null -eq $content) { "" } else { $content }
  } else {
    ""
  }
  if ($fakeLogText -notmatch '"hasToolEnforcement":true') {
    throw "expected code edit to inject SDD drift tool result enforcement"
  }
  if ($fakeLogText -notmatch '"hasCodeEnforcement":true') {
    throw "expected code edit to inject code drift design enforcement"
  }
  $designText = Get-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\design.md") -Raw
  if ($designText -notmatch "Synced by fake opencode model after code drift enforcement") {
    throw "expected code drift enforcement to trigger design.md synchronization"
  }
  $tasksText = Get-Content -LiteralPath (Join-Path $root "sdd\changes\test-feat\tasks.md") -Raw
  if ($tasksText -notmatch "Synced by fake opencode model") {
    throw "expected design synchronization to cascade into tasks.md synchronization"
  }
  $reportText = if (Test-Path -LiteralPath $report) {
    $content = Get-Content -LiteralPath $report -Raw
    if ($null -eq $content) { "" } else { $content }
  } else {
    ""
  }
  if ($reportText.Trim().Length -gt 0) {
    throw "expected no drift report after successful code to design to tasks synchronization"
  }
}
