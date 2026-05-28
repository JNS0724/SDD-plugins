const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")

const PLUGIN_NAME = "opencode-turn-checkpoint"
const DEFAULT_STABLE_IDLE_MS = 2000
const DEFAULT_CALLBACK_TIMEOUT_MS = 3000
const DEFAULT_AGENT_OUTPUT_MODE = "preview"
const DEFAULT_AGENT_OUTPUT_MAX_CHARS = 2000
const DEFAULT_PAYLOAD_RETENTION_DAYS = 3

const compact = (value, max = 2000) => {
  const text = String(value || "")
  return text.length > max ? `${text.slice(0, max)}...` : text
}

const sanitize = (value) => String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_")

const hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12)

const nowIso = () => new Date().toISOString()

const normalizeCwd = (ctx) => path.resolve(ctx?.worktree || ctx?.directory || process.cwd())

const pluginDir = () => __dirname

const configPath = () =>
  process.env.OPENCODE_TURN_CHECKPOINT_CONFIG ||
  path.join(pluginDir(), "opencode-turn-checkpoint.json")

const logPath = () =>
  process.env.OPENCODE_TURN_CHECKPOINT_LOG ||
  path.join(pluginDir(), "opencode-turn-checkpoint.log.jsonl")

const writeJsonAtomic = (target, value) => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, target)
}

const appendLog = (event) => {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true })
    fs.appendFileSync(logPath(), `${JSON.stringify({ ts: nowIso(), service: PLUGIN_NAME, ...event })}\n`)
  } catch {}
}

const logPluginIssue = async (client, level, message, extra = {}) => {
  appendLog({ level, message, extra })
  try {
    await client?.app?.log?.({
      body: {
        service: PLUGIN_NAME,
        level,
        message,
        extra,
      },
    })
  } catch {}
}

const normalizeAgentOutput = (value = {}) => {
  const mode = ["none", "preview", "full"].includes(value.mode) ? value.mode : DEFAULT_AGENT_OUTPUT_MODE
  const maxChars = Number.isFinite(value.maxChars)
    ? Math.max(0, Math.floor(value.maxChars))
    : DEFAULT_AGENT_OUTPUT_MAX_CHARS
  return { mode, maxChars }
}

const normalizeCallback = (callback) => {
  if (!callback || callback.enabled === false) return null
  if (typeof callback.command !== "string" || !callback.command.trim()) return null
  return {
    id: typeof callback.id === "string" && callback.id.trim() ? callback.id.trim() : hash(callback.command),
    command: callback.command,
    args: Array.isArray(callback.args) ? callback.args.map((item) => String(item)) : [],
    timeoutMs: Number.isFinite(callback.timeoutMs)
      ? Math.max(0, Math.floor(callback.timeoutMs))
      : DEFAULT_CALLBACK_TIMEOUT_MS,
  }
}

const normalizeConfig = (raw = {}) => ({
  version: 1,
  stableIdleMs: Number.isFinite(raw.stableIdleMs)
    ? Math.max(0, Math.floor(raw.stableIdleMs))
    : DEFAULT_STABLE_IDLE_MS,
  payloadRetentionDays: Number.isFinite(raw.payloadRetentionDays)
    ? Math.max(0, Number(raw.payloadRetentionDays))
    : DEFAULT_PAYLOAD_RETENTION_DAYS,
  agentOutput: normalizeAgentOutput(raw.agentOutput || {}),
  callbacks: Array.isArray(raw.callbacks) ? raw.callbacks.map(normalizeCallback).filter(Boolean) : [],
})

const loadConfig = () => {
  const target = configPath()
  try {
    return {
      path: target,
      config: normalizeConfig(JSON.parse(fs.readFileSync(target, "utf8"))),
      error: null,
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: target, config: normalizeConfig(), error: null, missing: true }
    }
    return { path: target, config: normalizeConfig(), error }
  }
}

const getSessionID = (value = {}) =>
  value.sessionID ||
  value.sessionId ||
  value.session_id ||
  value.properties?.sessionID ||
  value.properties?.sessionId ||
  value.properties?.session_id ||
  "default"

const eventType = (event) => String(event?.type || "")

const statusValue = (event) => {
  const status = event?.properties?.status || event?.status
  return typeof status === "string" ? status : status?.type
}

const textValue = (value) => {
  if (typeof value === "string") return value
  if (value && typeof value.value === "string") return value.value
  return ""
}

const textFromPart = (part) => {
  if (!part) return ""
  if (typeof part === "string") return part
  if (part.type && part.type !== "text") return ""
  return textValue(part.text) || textValue(part.content) || textValue(part.value) || textValue(part.delta)
}

const textFromParts = (parts) =>
  Array.isArray(parts)
    ? parts.map(textFromPart).filter(Boolean).join("\n")
    : textFromPart(parts)

const messageFields = (eventOrInput = {}, output = null) => {
  const props = eventOrInput.properties || {}
  const message = output?.message || props.message || props.info || eventOrInput.message || {}
  const parts =
    output?.parts ||
    props.parts ||
    eventOrInput.parts ||
    message.parts ||
    props.part ||
    eventOrInput.part ||
    []
  const role =
    message.role ||
    props.role ||
    eventOrInput.role ||
    message.author?.role ||
    eventOrInput.agentRole ||
    null
  const text =
    output?.message_text ||
    props.message_text ||
    eventOrInput.message_text ||
    textFromParts(parts) ||
    message.text ||
    message.content ||
    ""
  const part = props.part || eventOrInput.part || null
  const messageId =
    eventOrInput.messageID ||
    eventOrInput.messageId ||
    eventOrInput.message_id ||
    props.messageID ||
    props.messageId ||
    props.message_id ||
    part?.messageID ||
    part?.messageId ||
    part?.message_id ||
    message.id ||
    null
  const partId =
    props.partID ||
    props.partId ||
    props.part_id ||
    part?.id ||
    null
  return { role, text: String(text || ""), messageId, partId }
}

const shouldCacheAssistantMessage = ({ role, text }) => {
  if (!text.trim()) return false
  if (!role) return true
  return String(role).toLowerCase() === "assistant"
}

const createInitialSessionState = () => ({
  activitySeq: 0,
  lastTriggeredSeq: -1,
  pendingTimer: null,
  pendingTimerSeq: null,
  lastTool: null,
  lastToolAt: null,
  lastMessageAt: null,
  lastTodoAt: null,
  lastAssistant: null,
  partTexts: new Map(),
})

const getSessionState = (sessions, sessionID) => {
  const id = sessionID || "default"
  if (!sessions.has(id)) sessions.set(id, createInitialSessionState())
  return sessions.get(id)
}

const cancelPendingIdle = (session) => {
  if (session.pendingTimer) clearTimeout(session.pendingTimer)
  session.pendingTimer = null
  session.pendingTimerSeq = null
}

const markActivity = (sessions, sessionID, kind, details = {}) => {
  const session = getSessionState(sessions, sessionID)
  session.activitySeq += 1
  cancelPendingIdle(session)
  const at = nowIso()
  if (kind === "tool") {
    session.lastTool = details.tool || null
    session.lastToolAt = at
  } else if (kind === "message") {
    session.lastMessageAt = at
    if (details.assistant) session.lastAssistant = details.assistant
  } else if (kind === "todo") {
    session.lastTodoAt = at
  }
  return session
}

const buildAgentOutput = (session, config) => {
  const mode = config.agentOutput.mode
  const cached = session.lastAssistant
  if (mode === "none" || !cached?.text) {
    return {
      source: cached?.source || "none",
      messageId: cached?.messageId || null,
      preview: "",
      truncated: false,
    }
  }

  const maxChars = config.agentOutput.maxChars
  const text = String(cached.text || "")
  const truncated = maxChars > 0 && text.length > maxChars
  const preview = maxChars > 0 ? text.slice(0, maxChars) : ""
  return {
    source: cached.source || "message-cache",
    messageId: cached.messageId || null,
    preview,
    truncated,
    ...(mode === "full" ? { text } : {}),
  }
}

const payloadPath = (cwd, sessionID) =>
  path.join(
    os.tmpdir(),
    "opencode-turn-checkpoint",
    `${hash(path.resolve(cwd))}-${sanitize(sessionID)}-${Date.now()}.json`
  )

const payloadDir = () => path.join(os.tmpdir(), "opencode-turn-checkpoint")

const cleanupOldPayloads = (retentionDays = DEFAULT_PAYLOAD_RETENTION_DAYS, now = Date.now()) => {
  const days = Number.isFinite(retentionDays) ? Math.max(0, retentionDays) : DEFAULT_PAYLOAD_RETENTION_DAYS
  const maxAgeMs = days * 24 * 60 * 60 * 1000
  const dir = payloadDir()
  try {
    let removed = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const fp = path.join(dir, entry.name)
      const stat = fs.statSync(fp)
      if (now - stat.mtimeMs <= maxAgeMs) continue
      fs.unlinkSync(fp)
      removed += 1
    }
    return removed
  } catch {
    return 0
  }
}

const buildPayload = ({ ctx, sessionID, session, stableIdleMs, rawType, config }) => {
  const cwd = normalizeCwd(ctx)
  return {
    schemaVersion: 1,
    timestamp: nowIso(),
    runtime: "opencode",
    event: "stable-idle",
    cwd,
    sessionId: sessionID || "default",
    idleRawType: rawType || null,
    stableIdleMs,
    agentOutput: buildAgentOutput(session, config),
    recentActivity: {
      lastTool: session.lastTool,
      lastToolAt: session.lastToolAt,
      lastMessageAt: session.lastMessageAt,
      lastTodoAt: session.lastTodoAt,
    },
  }
}

const runCallback = async ({ callback, payloadFile, client, spawnFn = spawn }) =>
  new Promise((resolve) => {
    const args = callback.args.map((arg) => arg.replaceAll("{payloadFile}", payloadFile))
    let stdout = ""
    let stderr = ""
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawnFn(callback.command, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, timedOut: false, code: null, error: error.message, stdout, stderr })
      return
    }
    timer =
      callback.timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill()
            } catch {}
            finish({ ok: false, timedOut: true, code: null, stdout, stderr })
          }, callback.timeoutMs)
        : null

    child.stdout?.on("data", (chunk) => {
      stdout = compact(stdout + String(chunk), 4000)
    })
    child.stderr?.on("data", (chunk) => {
      stderr = compact(stderr + String(chunk), 4000)
    })
    child.on("error", (error) => {
      finish({ ok: false, timedOut: false, code: null, error: error.message, stdout, stderr })
    })
    child.on("close", (code) => {
      finish({ ok: code === 0, timedOut: false, code, stdout, stderr })
    })
  }).then(async (result) => {
    await logPluginIssue(client, result.ok ? "info" : "warn", "turn checkpoint callback completed", {
      id: callback.id,
      ok: result.ok,
      timedOut: Boolean(result.timedOut),
      code: result.code,
      error: result.error || null,
      stdout: compact(result.stdout, 1000),
      stderr: compact(result.stderr, 1000),
    })
    return result
  })

const runCallbacks = async ({ ctx, sessionID, session, stableIdleMs, rawType, config, spawnFn = spawn }) => {
  if (!config.callbacks.length) {
    await logPluginIssue(ctx.client, "info", "stable idle checkpoint observed with no callbacks", {
      sessionID,
      stableIdleMs,
    })
    return []
  }

  const payload = buildPayload({ ctx, sessionID, session, stableIdleMs, rawType, config })
  const removedPayloads = cleanupOldPayloads(config.payloadRetentionDays)
  const target = payloadPath(payload.cwd, sessionID)
  writeJsonAtomic(target, payload)
  await logPluginIssue(ctx.client, "info", "stable idle checkpoint payload written", {
    sessionID,
    payloadFile: target,
    removedPayloads,
    callbacks: config.callbacks.map((callback) => callback.id),
  })

  const results = []
  for (const callback of config.callbacks) {
    results.push(await runCallback({ callback, payloadFile: target, client: ctx.client, spawnFn }))
  }
  return results
}

const completeStableIdle = async ({ ctx, sessions, sessionID, seq, rawType, config }) => {
  const current = getSessionState(sessions, sessionID)
  current.pendingTimer = null
  current.pendingTimerSeq = null
  if (current.activitySeq !== seq || current.lastTriggeredSeq === seq) return false
  current.lastTriggeredSeq = seq
  try {
    await runCallbacks({
      ctx,
      sessionID,
      session: current,
      stableIdleMs: config.stableIdleMs,
      rawType,
      config,
    })
  } catch (error) {
    await logPluginIssue(ctx.client, "warn", "stable idle checkpoint failed", {
      sessionID,
      error: compact(error?.stack || error),
    })
  }
  return true
}

const scheduleStableIdle = async ({ ctx, sessions, sessionID, rawType, config, setTimeoutFn = setTimeout }) => {
  const session = getSessionState(sessions, sessionID)
  const seq = session.activitySeq
  if (session.lastTriggeredSeq === seq || session.pendingTimerSeq === seq) return false
  cancelPendingIdle(session)

  if (config.stableIdleMs <= 0) {
    session.pendingTimerSeq = seq
    return completeStableIdle({ ctx, sessions, sessionID, seq, rawType, config })
  }

  session.pendingTimerSeq = seq
  session.pendingTimer = setTimeoutFn(async () => {
    await completeStableIdle({ ctx, sessions, sessionID, seq, rawType, config })
  }, config.stableIdleMs)
  return true
}

const handleMessageActivity = (sessions, sessionID, eventOrInput, output = null, source = "message-cache") => {
  const fields = messageFields(eventOrInput, output)
  const session = getSessionState(sessions, sessionID)
  if (fields.partId && fields.text) session.partTexts.set(fields.partId, fields.text)
  const assistant = shouldCacheAssistantMessage(fields)
    ? {
        source,
        messageId: fields.messageId,
        partId: fields.partId || null,
        text: fields.text,
        updatedAt: nowIso(),
      }
    : null
  return markActivity(sessions, sessionID, "message", { assistant })
}

const handleMessagePartDelta = (sessions, sessionID, event = {}) => {
  const props = event.properties || {}
  if (props.field && props.field !== "text") {
    return markActivity(sessions, sessionID, "message")
  }
  const partId = props.partID || props.partId || props.part_id || null
  const messageId = props.messageID || props.messageId || props.message_id || null
  const delta = textValue(props.delta)
  if (!delta) return markActivity(sessions, sessionID, "message")

  const session = getSessionState(sessions, sessionID)
  const key = partId || messageId || "default"
  const text = `${session.partTexts.get(key) || ""}${delta}`
  session.partTexts.set(key, text)
  return markActivity(sessions, sessionID, "message", {
    assistant: {
      source: "message.part.delta",
      messageId,
      partId,
      text,
      updatedAt: nowIso(),
    },
  })
}

const OpenCodeTurnCheckpoint = async (ctx) => {
  const sessions = new Map()
  let loaded = loadConfig()
  if (loaded.error) {
    await logPluginIssue(ctx.client, "warn", "turn checkpoint config could not be parsed", {
      path: loaded.path,
      error: compact(loaded.error.message),
    })
  } else if (loaded.missing) {
    await logPluginIssue(ctx.client, "info", "turn checkpoint config not found; callbacks disabled", {
      path: loaded.path,
    })
  }

  const reloadConfig = async () => {
    loaded = loadConfig()
    if (loaded.error) {
      await logPluginIssue(ctx.client, "warn", "turn checkpoint config could not be parsed", {
        path: loaded.path,
        error: compact(loaded.error.message),
      })
    }
    return loaded.config
  }

  return {
    "chat.message": async (input, output) => {
      handleMessageActivity(sessions, getSessionID(input), input, output, "chat.message")
    },

    "tool.execute.before": async (input) => {
      markActivity(sessions, getSessionID(input), "tool", { tool: input?.tool || null })
    },

    "tool.execute.after": async (input) => {
      markActivity(sessions, getSessionID(input), "tool", { tool: input?.tool || null })
    },

    event: async ({ event }) => {
      const type = eventType(event)
      const sessionID = getSessionID(event)

      if (type === "session.idle" || (type === "session.status" && statusValue(event) === "idle")) {
        const config = await reloadConfig()
        await scheduleStableIdle({ ctx, sessions, sessionID, rawType: type, config })
        return
      }

      if (type === "session.status") {
        markActivity(sessions, sessionID, "message")
        return
      }

      if (type === "message.updated" || type === "message.part.updated") {
        handleMessageActivity(sessions, sessionID, event, null, type)
        return
      }

      if (type === "message.part.delta") {
        handleMessagePartDelta(sessions, sessionID, event)
        return
      }

      if (type === "todo.updated") {
        markActivity(sessions, sessionID, "todo")
      }
    },
  }
}

const privateApi = Object.assign(async () => ({}), {
  buildAgentOutput,
  buildPayload,
  completeStableIdle,
  cleanupOldPayloads,
  configPath,
  eventType,
  getSessionID,
  handleMessagePartDelta,
  handleMessageActivity,
  loadConfig,
  markActivity,
  messageFields,
  normalizeConfig,
  payloadPath,
  runCallback,
  runCallbacks,
  scheduleStableIdle,
  shouldCacheAssistantMessage,
  statusValue,
})

exports.OpenCodeTurnCheckpoint = OpenCodeTurnCheckpoint
exports._private = privateApi
