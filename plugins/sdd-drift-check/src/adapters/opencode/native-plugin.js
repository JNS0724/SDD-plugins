const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const {
  QUESTION_CHECKPOINT_TOOL_NAMES,
  isSupportedOpenCodeToolEvent,
  normalizeToolArgs,
  normalizeToolName,
} = require("../../core/tool-events")

const PLUGIN_NAME = "sdd-drift-check-opencode"
const TOOL_INPUT_CACHE_TTL_MS = 5 * 60 * 1000
const IDLE_DEDUP_WINDOW_MS = 500
const DEFAULT_HOOK_RELATIVE_PATH = path.join(
  ".opencode",
  "hooks",
  "sdd-drift-check",
  "sdd-drift-check-hook.js"
)
const isSupportedToolEvent = isSupportedOpenCodeToolEvent

const ownDir = __dirname

// Native OpenCode adapter source. Claude Code keeps using the command-hook adapter.

const fileExists = (fp) => {
  try {
    return fs.statSync(fp).isFile()
  } catch {
    return false
  }
}

const normalizeCwd = (ctx) => path.resolve(ctx?.worktree || ctx?.directory || process.cwd())

const getSessionID = (input) =>
  input?.sessionID || input?.sessionId || input?.session_id || "default"

const getToolCallID = (input) =>
  input?.callID ||
  input?.callId ||
  input?.toolCallID ||
  input?.toolCallId ||
  input?.tool_use_id ||
  input?.id ||
  null

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

const toolCacheKey = (input) => {
  const callID = getToolCallID(input)
  if (!callID) return null
  return `${getSessionID(input)}:${normalizeToolName(input?.tool)}:${callID}`
}

const pruneToolInputCache = (cache, now = Date.now()) => {
  for (const [key, item] of cache.entries()) {
    if (now - item.updatedAtMs > TOOL_INPUT_CACHE_TTL_MS) {
      cache.delete(key)
    }
  }
}

const cacheToolInput = (cache, input, args, now = Date.now()) => {
  const key = toolCacheKey(input)
  if (!key) return false
  pruneToolInputCache(cache, now)
  cache.set(key, {
    args: normalizeToolArgs(args),
    updatedAtMs: now,
  })
  return true
}

const takeCachedToolInput = (cache, input, now = Date.now()) => {
  const key = toolCacheKey(input)
  if (!key) return null
  pruneToolInputCache(cache, now)
  const item = cache.get(key)
  if (!item) return null
  cache.delete(key)
  return normalizeToolArgs(item.args)
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

const parseHookJson = (text) => {
  const trimmed = String(text || "").trim()
  if (!trimmed || !/^[{[]/.test(trimmed)) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

const getPreToolUseDenyReason = (result) => {
  const parsed = parseHookJson(result?.stdout)
  const specific = parsed?.hookSpecificOutput
  if (specific?.permissionDecision === "deny") {
    return specific.permissionDecisionReason || parsed.reason || "Tool use denied by SDD drift check."
  }
  if (parsed?.decision === "block" || parsed?.decision === "deny") {
    return parsed.reason || parsed.inject_prompt || "Tool use denied by SDD drift check."
  }
  if (result?.status === 2) {
    return String(result.stdout || result.stderr || "Tool use denied by SDD drift check.").trim()
  }
  return null
}

const getStopInjectPrompt = (result) => {
  const parsed = parseHookJson(result?.stdout)
  if (!parsed || parsed.decision !== "block") return null
  return String(parsed.inject_prompt || "").trim() || null
}

const buildToolOutputSummary = (output = {}) => ({
  title: compactText(output?.title || "", 1000),
  output: compactText(output?.output || "", 64 * 1024),
})

const buildPreToolUseInput = (ctx, input, args) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "PreToolUse",
  session_id: getSessionID(input),
  tool_use_id: getToolCallID(input),
  tool_name: normalizeToolName(input.tool),
  tool_input: normalizeToolArgs(args || {}),
  cwd: normalizeCwd(ctx),
})

const buildPostToolUseInput = (ctx, input, output, argsOverride = null) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "PostToolUse",
  session_id: getSessionID(input),
  tool_use_id: getToolCallID(input),
  tool_name: normalizeToolName(input.tool),
  tool_input: normalizeToolArgs(argsOverride || input.args || {}),
  tool_output: buildToolOutputSummary(output),
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
  session_id: getSessionID(input),
  message_id: input?.messageID || null,
  agent: input?.agent || null,
  model: input?.model || null,
  message: output?.message || null,
  parts: output?.parts || [],
  message_text: partText(output?.parts),
  cwd: normalizeCwd(ctx),
})

const normalizeIdleEvent = (event) => {
  if (event?.type === "session.idle") {
    return {
      sessionID: event?.properties?.sessionID || "default",
      rawType: event.type,
    }
  }

  if (event?.type === "session.status") {
    const status = event?.properties?.status
    if (status !== "idle" && status?.type !== "idle") return null
    return {
      sessionID: event?.properties?.sessionID || "default",
      rawType: event.type,
    }
  }

  return null
}

const shouldHandleIdle = (recentIdleBySession, sessionID, now = Date.now()) => {
  const id = sessionID || "default"
  for (const [key, lastAt] of recentIdleBySession.entries()) {
    if (now - lastAt > IDLE_DEDUP_WINDOW_MS * 10) {
      recentIdleBySession.delete(key)
    }
  }

  const lastAt = recentIdleBySession.get(id)
  if (lastAt && now - lastAt < IDLE_DEDUP_WINDOW_MS) {
    return false
  }

  recentIdleBySession.set(id, now)
  return true
}

const promptSession = async (ctx, sessionID, prompt) => {
  const session = ctx?.client?.session
  const fn =
    typeof session?.promptAsync === "function"
      ? session.promptAsync.bind(session)
      : typeof session?.prompt === "function"
        ? session.prompt.bind(session)
        : null
  if (!fn) return false

  await fn({
    path: { id: sessionID || "default" },
    body: {
      parts: [
        {
          type: "text",
          text: prompt,
        },
      ],
    },
    query: {
      directory: normalizeCwd(ctx),
    },
  })
  return true
}

exports.SddDriftCheckOpenCode = async (ctx) => {
  const hookScript = resolveHookScript(ctx)
  const hookRunner =
    typeof ctx?.__sddDriftRunCommandHook === "function"
      ? ctx.__sddDriftRunCommandHook
      : runCommandHook
  const toolInputCache = new Map()
  const recentIdleBySession = new Map()

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

    "tool.execute.before": async (input, output = {}) => {
      const tool = normalizeToolName(input.tool)
      const args = normalizeToolArgs(output?.args || input.args || {})
      cacheToolInput(toolInputCache, input, args)

      if (!QUESTION_CHECKPOINT_TOOL_NAMES.has(tool)) return

      const result = await hookRunner(hookScript, buildPreToolUseInput(ctx, input, args))
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "question checkpoint did not complete", {
          hookScript,
          tool,
          sessionID: getSessionID(input),
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr),
        })
        return
      }

      const denyReason = getPreToolUseDenyReason(result)
      if (!denyReason) return

      await logPluginIssue(ctx.client, "info", "blocked question tool for SDD drift checkpoint", {
        tool,
        sessionID: getSessionID(input),
        callID: getToolCallID(input),
      })
      throw new Error(denyReason)
    },

    "tool.execute.after": async (input, output) => {
      const tool = normalizeToolName(input.tool)
      const args = takeCachedToolInput(toolInputCache, input) || normalizeToolArgs(input.args || {})
      if (!isSupportedToolEvent(tool, args || {})) return

      const result = await hookRunner(hookScript, buildPostToolUseInput(ctx, input, output, args))
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
          sessionID: getSessionID(input),
          callID: getToolCallID(input),
        })
      }
    },

    event: async ({ event }) => {
      const idle = normalizeIdleEvent(event)
      if (!idle) return
      const sessionID = idle.sessionID
      if (!shouldHandleIdle(recentIdleBySession, sessionID)) return

      const result = await hookRunner(hookScript, buildStopInput(ctx, sessionID))
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "idle check did not complete", {
          hookScript,
          sessionID,
          rawType: idle.rawType,
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr),
        })
        return
      }

      const injectPrompt = getStopInjectPrompt(result)
      if (!injectPrompt) return

      try {
        const injected = await promptSession(ctx, sessionID, injectPrompt)
        await logPluginIssue(ctx.client, injected ? "info" : "warn", "processed Stop continuation", {
          hookScript,
          sessionID,
          rawType: idle.rawType,
          injected,
        })
      } catch (error) {
        await logPluginIssue(ctx.client, "warn", "Stop continuation prompt failed", {
          hookScript,
          sessionID,
          rawType: idle.rawType,
          error: compactText(error?.message || String(error)),
        })
      }
    },
  }
}

exports._private = {
  buildChatMessageInput,
  buildPreToolUseInput,
  buildPostToolUseInput,
  buildStopInput,
  cacheToolInput,
  getPreToolUseDenyReason,
  getStopInjectPrompt,
  isSupportedToolEvent,
  normalizeToolName,
  normalizeToolArgs,
  normalizeIdleEvent,
  partText,
  promptSession,
  shouldHandleIdle,
  takeCachedToolInput,
  resolveHookScript,
  runCommandHook,
}
