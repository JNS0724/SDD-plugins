const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")

const PLUGIN_NAME = "sdd-drift-check-opencode"
const DEFAULT_HOOK_RELATIVE_PATH = path.join(
  ".opencode",
  "hooks",
  "sdd-drift-check",
  "sdd-drift-check-hook.js"
)
const FILE_TOOL_NAMES = new Set(["read", "edit", "write", "multiedit"])
const SUBAGENT_CHECKPOINT_TOOL_NAMES = new Set([
  "background_output",
  "call_omo_agent",
  "delegate_task",
  "task",
])

const ownDir = __dirname

const fileExists = (fp) => {
  try {
    return fs.statSync(fp).isFile()
  } catch {
    return false
  }
}

const normalizeCwd = (ctx) => path.resolve(ctx?.worktree || ctx?.directory || process.cwd())

const resolveHookScript = (ctx) => {
  const configured = process.env.SDD_DRIFT_HOOK_SCRIPT
  if (configured) {
    return path.resolve(normalizeCwd(ctx), configured)
  }

  const cwd = normalizeCwd(ctx)
  const candidates = [
    path.join(cwd, DEFAULT_HOOK_RELATIVE_PATH),
    path.join(ownDir, "sdd-drift-check-hook.js"),
    path.join(cwd, ".opencode", "plugins", "sdd-drift-check-hook.js"),
  ]
  return candidates.find(fileExists) || candidates[0]
}

const getToolFilePath = (args) =>
  args?.file_path || args?.filePath || args?.path || args?.file

const normalizeToolName = (tool) => {
  const name = String(tool || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s.]+/g, "_")
  if (name === "multi_edit" || name === "multi-edit") return "multiedit"
  return name
}

const isSupportedToolEvent = (tool, args) => {
  if (FILE_TOOL_NAMES.has(tool) && getToolFilePath(args || {})) return true
  if (tool === "background_task") return false
  if (tool === "call_omo_agent" && args?.run_in_background === true) return false
  return SUBAGENT_CHECKPOINT_TOOL_NAMES.has(tool)
}

const normalizeToolArgs = (args) => {
  const copy = { ...(args || {}) }
  const fp = getToolFilePath(copy)
  if (fp && !copy.file_path) copy.file_path = fp
  return copy
}

const compactText = (value, max = 1000) => {
  const text = String(value || "")
  return text.length > max ? `${text.slice(0, max)}...` : text
}

const logPluginIssue = async (client, level, message, extra = {}) => {
  try {
    await client?.app?.log?.({
      body: {
        service: PLUGIN_NAME,
        level,
        message,
        extra,
      },
    })
  } catch {
    // Keep the plugin silent if OpenCode logging is unavailable.
  }
}

const runCommandHook = (hookScript, hookInput, options = {}) =>
  new Promise((resolve) => {
    const node = process.env.SDD_DRIFT_NODE || "node"
    const env = {
      ...process.env,
      SDD_DRIFT_OUTPUT: process.env.SDD_DRIFT_OUTPUT || "opencode",
    }
    const child = spawn(node, [hookScript], {
      cwd: hookInput.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    const timeoutMs = Number.parseInt(process.env.SDD_DRIFT_NATIVE_TIMEOUT_MS || "10000", 10)
    const timeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return
            settled = true
            try {
              child.kill()
            } catch {}
            resolve({
              status: null,
              stdout,
              stderr,
              timedOut: true,
            })
          }, timeoutMs)
        : null

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolve({
        status: null,
        stdout,
        stderr,
        error,
      })
    })
    child.on("close", (status) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolve({
        status,
        stdout,
        stderr,
      })
    })
    child.stdin.end(JSON.stringify(hookInput))
  })

const appendToolOutput = (output, message) => {
  const text = String(message || "").trim()
  if (!text) return false

  const current = String(output.output || "")
  output.output = current ? `${current}\n\n${text}` : text
  output.metadata = {
    ...(output.metadata || {}),
    sddDriftCheck: {
      injected: true,
    },
  }
  return true
}

const buildPostToolUseInput = (ctx, input) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "PostToolUse",
  session_id: input.sessionID || "default",
  tool_use_id: input.callID || null,
  tool_name: normalizeToolName(input.tool),
  tool_input: normalizeToolArgs(input.args || {}),
  cwd: normalizeCwd(ctx),
})

const buildStopInput = (ctx, sessionID) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "Stop",
  session_id: sessionID || "default",
  cwd: normalizeCwd(ctx),
})

const partText = (parts) =>
  Array.isArray(parts)
    ? parts
        .map((part) =>
          typeof part === "string"
            ? part
            : part?.text || part?.content || part?.value || ""
        )
        .filter(Boolean)
        .join("\n")
    : ""

const buildChatMessageInput = (ctx, input, output) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "ChatMessage",
  session_id: input?.sessionID || "default",
  message_id: input?.messageID || null,
  agent: input?.agent || null,
  model: input?.model || null,
  message: output?.message || null,
  parts: output?.parts || [],
  message_text: partText(output?.parts),
  cwd: normalizeCwd(ctx),
})

exports.SddDriftCheckOpenCode = async (ctx) => {
  const hookScript = resolveHookScript(ctx)
  const hookRunner =
    typeof ctx?.__sddDriftRunCommandHook === "function"
      ? ctx.__sddDriftRunCommandHook
      : runCommandHook

  return {
    "chat.message": async (input, output) => {
      const result = await hookRunner(hookScript, buildChatMessageInput(ctx, input, output))
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "chat message context capture did not complete", {
          hookScript,
          sessionID: input?.sessionID,
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr),
        })
      }
    },

    "tool.execute.after": async (input, output) => {
      const tool = normalizeToolName(input.tool)
      if (!isSupportedToolEvent(tool, input.args || {})) return

      const result = await hookRunner(hookScript, buildPostToolUseInput(ctx, input))
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "command hook did not complete", {
          hookScript,
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr),
        })
        return
      }

      const message =
        result.stdout ||
        (process.env.SDD_DRIFT_NATIVE_APPEND_STDERR === "1" ? result.stderr : "")
      if (appendToolOutput(output, message)) {
        await logPluginIssue(ctx.client, "info", "injected SDD drift reminder", {
          tool,
          sessionID: input.sessionID,
          callID: input.callID,
        })
      }
    },

    event: async ({ event }) => {
      if (event?.type !== "session.idle") return
      const sessionID = event?.properties?.sessionID
      const result = await hookRunner(hookScript, buildStopInput(ctx, sessionID))
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "idle check did not complete", {
          hookScript,
          sessionID,
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr),
        })
      }
    },
  }
}

exports._private = {
  buildChatMessageInput,
  buildPostToolUseInput,
  buildStopInput,
  isSupportedToolEvent,
  normalizeToolName,
  normalizeToolArgs,
  partText,
  resolveHookScript,
  runCommandHook,
}
