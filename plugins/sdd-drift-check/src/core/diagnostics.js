const fs = require("fs")
const path = require("path")
const { acquireFileLock, releaseFileLock } = require("./locks")
const {
  DIAGNOSTIC_LOG,
  DIAGNOSTIC_LOG_MAX_BYTES,
  DIAGNOSTIC_LOG_RETENTION_DAYS,
  DIAGNOSTIC_SUMMARY_WINDOW_MS,
} = require("./runtime-config")
const { diagnosticLogPath, writeTextAtomic } = require("./state-storage")

const DIAGNOSTIC_SUMMARY_EVENTS = new Set([
  "handler_exception",
  "hook_exception",
  "circuit_open",
  "circuit_open_skip",
])

const diagnosticSummaryState = {
  windowStartMs: 0,
  counts: {},
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const diagnosticSummaryWindowMs = (value = DIAGNOSTIC_SUMMARY_WINDOW_MS) =>
  Number.isFinite(value) && value > 0 ? value : 60 * 1000

const diagnosticSummaryLine = (state, windowMs) => ({
  event: "diagnostic_summary",
  windowStart: new Date(state.windowStartMs).toISOString(),
  windowEnd: new Date(state.windowStartMs + windowMs).toISOString(),
  counts: { ...(state.counts || {}) },
})

const recordDiagnosticSummaryEvent = (
  state,
  eventName,
  nowMs = Date.now(),
  windowMsValue = DIAGNOSTIC_SUMMARY_WINDOW_MS,
  trackedEvents = DIAGNOSTIC_SUMMARY_EVENTS
) => {
  if (!trackedEvents.has(eventName)) return []
  const windowMs = diagnosticSummaryWindowMs(windowMsValue)
  const summaries = []

  if (!state.windowStartMs) {
    state.windowStartMs = nowMs
    state.counts = {}
  } else if (nowMs >= state.windowStartMs + windowMs) {
    if (Object.keys(state.counts || {}).length > 0) {
      summaries.push(diagnosticSummaryLine(state, windowMs))
    }
    state.windowStartMs = nowMs
    state.counts = {}
  }

  state.counts[eventName] = Number(state.counts[eventName] || 0) + 1
  return summaries
}

const rotateDiagnosticLog = (target) => {
  const maxBytes = Number.isFinite(DIAGNOSTIC_LOG_MAX_BYTES)
    ? Math.max(64 * 1024, DIAGNOSTIC_LOG_MAX_BYTES)
    : 2 * 1024 * 1024
  try {
    if (!fs.existsSync(target)) return
    if (fs.statSync(target).size < maxBytes) return
    const rotated = `${target}.1`
    try {
      fs.unlinkSync(rotated)
    } catch {}
    fs.renameSync(target, rotated)
  } catch {}
}

const diagnosticLogRetentionMs = () => {
  if (!Number.isFinite(DIAGNOSTIC_LOG_RETENTION_DAYS)) return 3 * 24 * 60 * 60 * 1000
  if (DIAGNOSTIC_LOG_RETENTION_DAYS <= 0) return null
  return DIAGNOSTIC_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
}

const parseDiagnosticLogTs = (line) => {
  try {
    const ts = Date.parse(JSON.parse(line)?.ts)
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}

const pruneDiagnosticLogFile = (target, cutoffMs) => {
  let text = ""
  try {
    text = fs.readFileSync(target, "utf8")
  } catch {
    return
  }

  const lines = text.split(/\r?\n/).filter(Boolean)
  const kept = lines.filter((line) => {
    const ts = parseDiagnosticLogTs(line)
    return ts === null || ts >= cutoffMs
  })

  if (kept.length === lines.length) return
  if (!kept.length) {
    try {
      fs.unlinkSync(target)
    } catch {}
    return
  }

  writeTextAtomic(target, `${kept.join("\n")}\n`)
}

const cleanupDiagnosticLogs = (target, now = Date.now()) => {
  const retentionMs = diagnosticLogRetentionMs()
  if (retentionMs === null) return

  const cutoffMs = now - retentionMs
  const dir = path.dirname(target)
  const base = path.basename(target)
  const rotatedPattern = new RegExp(`^${escapeRegExp(base)}\\.\\d+$`)

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (entry.name !== base && !rotatedPattern.test(entry.name)) continue

      const fp = path.join(dir, entry.name)
      const stat = fs.statSync(fp)
      if (stat.mtimeMs < cutoffMs) {
        try {
          fs.unlinkSync(fp)
        } catch {}
        continue
      }
      pruneDiagnosticLogFile(fp, cutoffMs)
    }
  } catch {}
}

const writeDiagnosticLog = (cwd, event) => {
  if (!DIAGNOSTIC_LOG) return
  let lock = null
  try {
    const target = diagnosticLogPath(cwd || process.cwd())
    fs.mkdirSync(path.dirname(target), { recursive: true })
    lock = acquireFileLock(target)
    if (!lock) return
    cleanupDiagnosticLogs(target)
    rotateDiagnosticLog(target)
    const nowMs = Date.now()
    const lines = [
      ...recordDiagnosticSummaryEvent(diagnosticSummaryState, event?.event, nowMs),
      event,
    ].map((entry) =>
      JSON.stringify({
        ts: new Date(nowMs).toISOString(),
        pid: process.pid,
        ...entry,
      })
    )
    fs.appendFileSync(target, `${lines.join("\n")}\n`)
  } catch {
  } finally {
    releaseFileLock(lock)
  }
}

module.exports = {
  DIAGNOSTIC_SUMMARY_EVENTS,
  cleanupDiagnosticLogs,
  diagnosticLogRetentionMs,
  diagnosticSummaryLine,
  diagnosticSummaryState,
  diagnosticSummaryWindowMs,
  parseDiagnosticLogTs,
  pruneDiagnosticLogFile,
  recordDiagnosticSummaryEvent,
  rotateDiagnosticLog,
  writeDiagnosticLog,
}
