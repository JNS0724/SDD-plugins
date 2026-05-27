# OpenCode Turn Checkpoint

OpenCode native plugin that observes a stable idle checkpoint and calls external
CLI callbacks with a JSON payload.

This plugin is independent from `sdd-drift-check`. It does not inspect SDD
state, inject prompts, or call `session.prompt`.

## Install

Project-level install:

```powershell
New-Item -ItemType Directory -Force .opencode\plugins
Copy-Item E:\tool\MySkills\MySkills\plugins\opencode-turn-checkpoint\opencode-turn-checkpoint.js .opencode\plugins\opencode-turn-checkpoint.js -Force
Copy-Item E:\tool\MySkills\MySkills\plugins\opencode-turn-checkpoint\opencode-turn-checkpoint.json .opencode\plugins\opencode-turn-checkpoint.json -Force
```

Global install:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"
Copy-Item E:\tool\MySkills\MySkills\plugins\opencode-turn-checkpoint\opencode-turn-checkpoint.js "$env:USERPROFILE\.config\opencode\plugins\opencode-turn-checkpoint.js" -Force
Copy-Item E:\tool\MySkills\MySkills\plugins\opencode-turn-checkpoint\opencode-turn-checkpoint.json "$env:USERPROFILE\.config\opencode\plugins\opencode-turn-checkpoint.json" -Force
```

OpenCode loads local plugin files from `.opencode/plugins/` and
`~/.config/opencode/plugins/` when it starts. Restart OpenCode after changing
the plugin JS file. The JSON config is reloaded when an idle checkpoint is
observed.

## Config

By default the plugin reads `opencode-turn-checkpoint.json` from the same
directory as `opencode-turn-checkpoint.js`.

Use `OPENCODE_TURN_CHECKPOINT_CONFIG` to point to another file:

```powershell
$env:OPENCODE_TURN_CHECKPOINT_CONFIG = "E:\path\opencode-turn-checkpoint.json"
```

Example:

```json
{
  "version": 1,
  "stableIdleMs": 5000,
  "payloadRetentionDays": 3,
  "agentOutput": {
    "mode": "preview",
    "maxChars": 2000
  },
  "callbacks": [
    {
      "id": "notify",
      "enabled": true,
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "E:\\tools\\notify-turn.ps1",
        "-Payload",
        "{payloadFile}"
      ],
      "timeoutMs": 3000
    }
  ]
}
```

Callbacks run with `shell: false`. The `{payloadFile}` placeholder is replaced
with the generated JSON payload path.

### Node.js callback example

This repository includes a simple callback script:

```text
plugins/opencode-turn-checkpoint/examples/notify-console.js
```

It can be used directly with Node.js:

```json
{
  "version": 1,
  "stableIdleMs": 5000,
  "payloadRetentionDays": 3,
  "agentOutput": {
    "mode": "preview",
    "maxChars": 2000
  },
  "callbacks": [
    {
      "id": "console",
      "enabled": true,
      "command": "node",
      "args": [
        "E:\\tool\\MySkills\\MySkills\\plugins\\opencode-turn-checkpoint\\examples\\notify-console.js",
        "-Payload",
        "{payloadFile}"
      ],
      "timeoutMs": 3000
    }
  ]
}
```

The script reads `-Payload <payload.json>`, parses common fields, and prints a
human-readable summary. Replace its `console.log` section with your own Feishu,
DingTalk, WeCom, Slack, email, or database call.

Payload files are written under:

```text
%TEMP%\opencode-turn-checkpoint\
```

The plugin removes old payload JSON files from that directory when a new
payload is written. `payloadRetentionDays` defaults to `3`; set it to `0` to
remove existing payloads on the next callback run.

## Payload

The callback receives a payload similar to:

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-05-27T00:00:00.000Z",
  "runtime": "opencode",
  "event": "stable-idle",
  "cwd": "E:\\project",
  "sessionId": "session-id",
  "idleRawType": "session.idle",
  "stableIdleMs": 5000,
  "agentOutput": {
    "source": "message-cache",
    "messageId": "message-id",
    "preview": "assistant output preview",
    "truncated": false
  },
  "recentActivity": {
    "lastTool": "edit",
    "lastToolAt": "2026-05-27T00:00:00.000Z",
    "lastMessageAt": "2026-05-27T00:00:00.000Z",
    "lastTodoAt": null
  }
}
```

`agentOutput.mode` supports `none`, `preview`, and `full`. The default is
`preview`.
