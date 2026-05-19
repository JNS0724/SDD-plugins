const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)$/i
const SHOW_WARNINGS = process.env.SDD_DRIFT_SHOW_WARNINGS === "1"
const STRICT_BLOCK = process.env.SDD_DRIFT_STRICT === "1"
const DEBUG = process.env.SDD_DRIFT_DEBUG === "1"
const OUTPUT_MODE = String(process.env.SDD_DRIFT_OUTPUT || "").toLowerCase()
const STOP_MAX_BLOCKS = Number.parseInt(process.env.SDD_DRIFT_STOP_MAX_BLOCKS || "2", 10)
const CODE_REVIEW_STOP_MAX_BLOCKS = Number.parseInt(
  process.env.SDD_DRIFT_CODE_REVIEW_STOP_MAX_BLOCKS || "1",
  10
)
const CODE_REVIEW_TOOL_MAX_REMINDERS = Number.parseInt(
  process.env.SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS || "1",
  10
)
const DIAGNOSTIC_LOG = process.env.SDD_DRIFT_LOG !== "0"
const DIAGNOSTIC_LOG_MAX_BYTES = Number.parseInt(
  process.env.SDD_DRIFT_LOG_MAX_BYTES || String(2 * 1024 * 1024),
  10
)
const DIAGNOSTIC_LOG_RETENTION_DAYS = Number.parseFloat(
  process.env.SDD_DRIFT_LOG_RETENTION_DAYS || "3"
)
const DTS_CONTEXT_SKIP = process.env.SDD_DRIFT_DTS_SKIP !== "0"
const DTS_CONTEXT_OVERRIDE = String(process.env.SDD_DRIFT_DTS_CONTEXT || "").toLowerCase()
const TOOL_EVENT_CAP = 200
const TRANSCRIPT_EVENT_CAP = Number.parseInt(
  process.env.SDD_DRIFT_TRANSCRIPT_EVENT_CAP || "2000",
  10
)
const CODE_REVIEW_CONFIRMATION_CAP = 50
const DTS_CONTEXT_TEXT_MAX_BYTES = 512 * 1024
const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000
const STATE_LOCK_STALE_MS = 30 * 1000
const STATE_LOCK_WAIT_MS = 5 * 1000
const STATE_LOCK_RETRY_MS = 20
const STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const STATE_DIR = ".sdd-drift-hook-state"
const PEER_FILES = ["design.md", "tasks.md"]
const PROPOSAL_FILE = "proposal.md"
const DESIGN_FILE = "design.md"
const TASKS_FILE = "tasks.md"
const REVIEW_FILES = [DESIGN_FILE, TASKS_FILE]
const CHANGE_DOC_REQUIREMENTS = {
  [PROPOSAL_FILE]: [DESIGN_FILE],
  [DESIGN_FILE]: [TASKS_FILE],
  [TASKS_FILE]: [DESIGN_FILE],
}
const DOCUMENT_SYNC_RULES = [
  "Before editing any SDD document, read the current file and preserve its existing Markdown template.",
  "Keep every existing heading line exactly as-is, including the top-level title such as # Design or # Tasks, and keep the original heading order.",
  "Do not replace the whole document with a summary, marker, or single-line result.",
  "Do not add a new section or rewrite the template just to satisfy this enforcement.",
  "For existing SDD documents, prefer Edit or MultiEdit. If Write is necessary, write the full document including all existing headings and template text.",
  "Do not edit design.md and tasks.md in the same parallel tool batch; update one SDD document, wait for its tool result and hook feedback, then update the required peer.",
  "Find the most appropriate existing heading, paragraph, list item, or task item, and make the smallest needed update there.",
  "For tasks.md, preserve the task-list format and update the relevant existing checklist item when possible.",
]
const SUBAGENT_REVIEW_RULE =
  "If the current environment supports subagents and a read-only review subagent is allowed, you may delegate SDD review to it; otherwise perform the review yourself with the read tool. The main agent remains responsible for any final edits."
const DTS_CONTEXT_PATTERNS = [
  /\bDTS-\d+\b/,
  /\bDTS\b/,
  /dts\s*(问题单|工单|缺陷单|缺陷|bug|issue|ticket)/i,
  /(问题单|工单|缺陷单|缺陷|bug|issue|ticket).{0,30}dts/i,
  /(DTS|问题单|工单|缺陷单|缺陷|bug|issue|ticket).{0,40}(修复|修改|处理|解决|fix|resolve|repair|patch|handle|address)/i,
  /(修复|修改|处理|解决|fix|resolve|repair|patch|handle|address).{0,40}(DTS|问题单|工单|缺陷单|缺陷|bug|issue|ticket)/i,
  /dts\s*(问题单|单|工单|缺陷|bug|issue|ticket)/i,
  /(问题单|工单|缺陷单|缺陷|bug|issue|ticket).{0,30}dts/i,
]
const DTS_CONTEXT_NEGATION_PATTERNS = [
  /(不是|非|无需|不要|不属于)\s*(DTS|问题单|工单|缺陷单|缺陷|bug|issue|ticket)/i,
  /(DTS|问题单|工单|缺陷单|缺陷|bug|issue|ticket).{0,10}(不是|非|无需|不要|不属于)/i,
  /\bnot\s+(?:a\s+)?(?:DTS|issue|ticket|bug)\b/i,
  /(不是|非|无需|不要|不属于)\s*DTS/i,
  /DTS.{0,10}(不是|非|无需|不要|不属于)/i,
  /\bnot\s+(?:a\s+)?DTS\b/i,
]

const toPosix = (fp) => fp.replace(/\\/g, "/")
const isCaseInsensitiveFs = () =>
  process.platform === "win32" || process.platform === "darwin"

const normalizeKey = (fp) => {
  const normalized = toPosix(path.resolve(fp))
  return isCaseInsensitiveFs() ? normalized.toLowerCase() : normalized
}

const samePath = (left, right) => normalizeKey(left) === normalizeKey(right)

const isSddPath = (fp) => {
  const normalized = toPosix(path.resolve(fp))
  return normalized.includes("/sdd/") || normalized.includes("/.sdd/")
}

const isSddChangePath = (fp) => {
  const normalized = toPosix(path.resolve(fp))
  return (
    normalized.includes("/sdd/changes/") ||
    normalized.includes("/.sdd/changes/")
  )
}

const isCodePath = (fp) => CODE_EXT.test(fp) && !isSddPath(fp)

const hasSddWorkspace = (cwd) => {
  for (const name of ["sdd", ".sdd"]) {
    try {
      if (fs.statSync(path.join(cwd, name)).isDirectory()) return true
    } catch {}
  }
  return false
}

const readStdin = () =>
  new Promise((resolve, reject) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", () => resolve(data))
    process.stdin.on("error", reject)
  })

const parseHookInput = (raw) => JSON.parse(String(raw || "{}").replace(/^\uFEFF/, ""))

const sanitize = (value) => String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_")
const hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12)
const stateDirCache = new Map()

const findNearestGitDir = (cwd) => {
  let dir = path.resolve(cwd)
  while (dir !== path.dirname(dir)) {
    const gitPath = path.join(dir, ".git")
    try {
      const stat = fs.statSync(gitPath)
      if (stat.isDirectory()) return gitPath
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, "utf8").trim()
        const match = content.match(/^gitdir:\s*(.+)$/i)
        if (match) {
          const gitDir = match[1].trim()
          return path.resolve(dir, gitDir)
        }
      }
    } catch {}
    dir = path.dirname(dir)
  }
  return null
}

const canUseStateDir = (dir) => {
  const probeBase = `.probe.${process.pid}.${Date.now()}`
  const tmp = path.join(dir, `${probeBase}.tmp`)
  const target = path.join(dir, probeBase)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, "")
    fs.renameSync(tmp, target)
    fs.unlinkSync(target)
    return true
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    try {
      fs.unlinkSync(target)
    } catch {}
    return false
  }
}

const stateDir = (cwd) => {
  const cacheKey = normalizeKey(cwd)
  const cached = stateDirCache.get(cacheKey)
  if (cached) return cached

  const gitDir = findNearestGitDir(cwd)
  if (gitDir) {
    const gitStateDir = path.join(gitDir, "sdd-drift-hook-state")
    if (canUseStateDir(gitStateDir)) {
      stateDirCache.set(cacheKey, gitStateDir)
      return gitStateDir
    }
  }

  const localStateDir = path.join(cwd, STATE_DIR)
  if (canUseStateDir(localStateDir)) {
    stateDirCache.set(cacheKey, localStateDir)
    return localStateDir
  }

  const tempStateDir = path.join(os.tmpdir(), "sdd-drift-check", hash(path.resolve(cwd)))
  stateDirCache.set(cacheKey, tempStateDir)
  return tempStateDir
}

const statePath = (cwd, sessionID) =>
  path.join(stateDir(cwd), `${hash(path.resolve(cwd))}-${sanitize(sessionID)}.json`)

const diagnosticLogPath = (cwd) =>
  process.env.SDD_DRIFT_LOG_PATH || path.join(stateDir(cwd), "sdd-drift-check.log.jsonl")

const limitString = (value, max = 500) => {
  const text = String(value || "")
  return text.length > max ? `${text.slice(0, max)}...` : text
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const sleepSync = (ms) => {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const summarizeInput = (input) => ({
  hook_event_name: input?.hook_event_name || null,
  hook_source: input?.hook_source || null,
  session_id: input?.session_id || null,
  tool_name: input?.tool_name || null,
  tool_use_id: input?.tool_use_id || input?.toolUseId || null,
  cwd: input?.cwd || null,
})

const summarizeGaps = (cwd, peerGaps, codeGaps) => ({
  peerGapCount: peerGaps.length,
  codeGapCount: codeGaps.length,
  peerGaps: peerGaps.map((gap) => ({
    relDir: gap.relDir,
    required: gap.required,
    stageOnly: Boolean(gap.stageOnly),
    sourceFiles: gap.sourceFiles || [],
    absent: gap.absent,
    unsynced: gap.unsynced,
    stale: gap.stale,
  })),
  codeGaps: codeGaps.map((gap) => ({
    codeFiles: (gap.codeFiles || []).map((file) => rel(cwd, file)),
    pendingReviewTargets: (gap.pendingReviewTargets || []).map((file) => rel(cwd, file)),
    reviewReady: Boolean(gap.reviewReady),
    needsConfirmation: Boolean(gap.needsConfirmation),
  })),
})

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

const acquireFileLock = (target, options = {}) => {
  const staleMs = options.staleMs || DEFAULT_LOCK_STALE_MS
  const waitMs = options.waitMs || 0
  const retryMs = options.retryMs || 25
  const lockPath = `${target}.lock`
  const openLock = () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const fd = fs.openSync(lockPath, "wx")
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
    return { fd, lockPath }
  }

  const deadline = Date.now() + waitMs
  while (true) {
    try {
      return openLock()
    } catch (err) {
      if (err?.code !== "EEXIST") return null
    }

    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath)
    } catch {}

    if (Date.now() >= deadline) return null
    sleepSync(retryMs)
  }
}

const releaseFileLock = (lock) => {
  if (!lock) return
  try {
    fs.closeSync(lock.fd)
  } catch {}
  try {
    fs.unlinkSync(lock.lockPath)
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
    fs.appendFileSync(
      target,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        ...event,
      })}\n`
    )
  } catch {
  } finally {
    releaseFileLock(lock)
  }
}

const emptyState = () => ({
  version: 2,
  clock: 0,
  touched: [],
  edited: [],
  changeDirs: [],
  files: {},
  requirements: {},
  stopBlocks: {},
  toolEvents: {},
  peerSyncs: {},
  codeDriftNotice: null,
  peerDriftNotice: null,
  codeReviewConfirmations: {},
  transcriptEvents: {},
  dtsContext: null,
})

const addPath = (items, item) => {
  if (!items.some((existing) => samePath(existing, item))) items.push(path.normalize(item))
}

const normalizeState = (parsed) => {
  const state = emptyState()
  if (!parsed || typeof parsed !== "object") return state

  state.version = 2
  state.clock = Number.isFinite(parsed.clock) ? parsed.clock : 0
  state.touched = Array.isArray(parsed.touched) ? parsed.touched.map((fp) => path.normalize(fp)) : []
  state.edited = Array.isArray(parsed.edited) ? parsed.edited.map((fp) => path.normalize(fp)) : []
  state.changeDirs = Array.isArray(parsed.changeDirs)
    ? parsed.changeDirs.map((fp) => path.normalize(fp))
    : []
  state.files = parsed.files && typeof parsed.files === "object" ? parsed.files : {}
  state.requirements =
    parsed.requirements && typeof parsed.requirements === "object" ? parsed.requirements : {}
  state.stopBlocks = parsed.stopBlocks && typeof parsed.stopBlocks === "object" ? parsed.stopBlocks : {}
  state.toolEvents = parsed.toolEvents && typeof parsed.toolEvents === "object" ? parsed.toolEvents : {}
  state.peerSyncs = parsed.peerSyncs && typeof parsed.peerSyncs === "object" ? parsed.peerSyncs : {}
  state.codeDriftNotice =
    parsed.codeDriftNotice && typeof parsed.codeDriftNotice === "object"
      ? parsed.codeDriftNotice
      : null
  state.peerDriftNotice =
    parsed.peerDriftNotice && typeof parsed.peerDriftNotice === "object"
      ? parsed.peerDriftNotice
      : null
  state.codeReviewConfirmations =
    parsed.codeReviewConfirmations && typeof parsed.codeReviewConfirmations === "object"
      ? parsed.codeReviewConfirmations
      : {}
  state.transcriptEvents =
    parsed.transcriptEvents && typeof parsed.transcriptEvents === "object"
      ? parsed.transcriptEvents
      : {}
  state.dtsContext =
    parsed.dtsContext && typeof parsed.dtsContext === "object" ? parsed.dtsContext : null

  for (const fp of state.touched) {
    const key = normalizeKey(fp)
    state.files[key] = {
      ...(state.files[key] || {}),
      path: path.normalize(fp),
      touchedSeq: state.files[key]?.touchedSeq || 1,
    }
  }
  for (const fp of state.edited) {
    const key = normalizeKey(fp)
    state.files[key] = {
      ...(state.files[key] || {}),
      path: path.normalize(fp),
      touchedSeq: state.files[key]?.touchedSeq || 1,
      editedSeq: state.files[key]?.editedSeq || 1,
      firstEditedSeq: state.files[key]?.firstEditedSeq || state.files[key]?.editedSeq || 1,
    }
  }

  return state
}

const loadState = (cwd, sessionID) => {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(statePath(cwd, sessionID), "utf8")))
  } catch {
    return emptyState()
  }
}

const writeTextAtomic = (target, text) => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`
  )
  fs.writeFileSync(tmp, text)
  try {
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      fs.writeFileSync(target, text)
    } catch {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw err
    }
    try {
      fs.unlinkSync(tmp)
    } catch {}
    return
  }
}

const cleanupOldState = (cwd) => {
  const dir = stateDir(cwd)
  try {
    const now = Date.now()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const fp = path.join(dir, entry.name)
      const stat = fs.statSync(fp)
      if (now - stat.mtimeMs > STATE_RETENTION_MS) fs.unlinkSync(fp)
    }
  } catch {}
}

const saveState = (cwd, sessionID, state) => {
  cleanupOldState(cwd)
  writeTextAtomic(statePath(cwd, sessionID), JSON.stringify(state, null, 2))
}

const resolveTranscriptPath = (input) => {
  const explicit = input?.transcript_path
  if (explicit && typeof explicit === "string" && fs.existsSync(explicit)) {
    return explicit
  }

  const sessionID = input?.session_id
  if (!sessionID || typeof sessionID !== "string") return explicit

  const candidates = []
  const todoPath = input?.todo_path
  if (todoPath && typeof todoPath === "string") {
    const claudeDir = path.dirname(path.dirname(todoPath))
    candidates.push(path.join(claudeDir, "transcripts", `${sessionID}.jsonl`))
  }

  const homes = [process.env.HOME, process.env.USERPROFILE, os.homedir()].filter(Boolean)
  for (const home of homes) {
    candidates.push(path.join(home, ".claude", "transcripts", `${sessionID}.jsonl`))
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || explicit
}

const resolveFile = (cwd, fp) =>
  path.isAbsolute(fp) ? path.normalize(fp) : path.resolve(cwd, fp)

const isDtsContextText = (text) => {
  const value = String(text || "")
  if (!value.trim()) return false
  if (DTS_CONTEXT_NEGATION_PATTERNS.some((pattern) => pattern.test(value))) return false
  return DTS_CONTEXT_PATTERNS.some((pattern) => pattern.test(value))
}

const dtsOverrideActive = () => {
  if (!DTS_CONTEXT_SKIP) return false
  if (["1", "true", "yes", "on"].includes(DTS_CONTEXT_OVERRIDE)) return true
  if (["0", "false", "no", "off"].includes(DTS_CONTEXT_OVERRIDE)) return false
  return null
}

const collectInputContextStrings = (value, key = "", depth = 0) => {
  if (depth > 6 || value == null) return []
  const normalizedKey = String(key || "").toLowerCase()
  if (
    ["tool_input", "toolinput", "old_string", "oldstring", "new_string", "newstring", "content"].includes(
      normalizedKey
    )
  ) {
    return []
  }

  if (typeof value === "string") {
    if (
      !normalizedKey ||
      /prompt|message|context|instruction|request|description|summary|title|user|input/.test(
        normalizedKey
      )
    ) {
      return [value]
    }
    return []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectInputContextStrings(item, key, depth + 1))
  }

  if (typeof value !== "object") return []

  const strings = []
  const userText =
    value.role === "user"
      ? contentText(value.content)
      : value.type === "user"
        ? contentText(value.content || value.message?.content)
        : value.message?.role === "user"
          ? contentText(value.message.content)
          : ""
  if (userText.trim()) strings.push(userText)
  for (const [childKey, childValue] of Object.entries(value)) {
    strings.push(...collectInputContextStrings(childValue, childKey, depth + 1))
  }
  return strings
}

const contentText = (content) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      return part?.text || part?.content || part?.value || ""
    })
    .filter(Boolean)
    .join("\n")
}

const transcriptUserText = (entry) => {
  if (!entry || typeof entry !== "object") return ""
  if (entry.role === "user") return contentText(entry.content)
  if (entry.type === "user") return contentText(entry.content || entry.message?.content)
  if (entry.message?.role === "user") return contentText(entry.message.content)
  return ""
}

const readLastTranscriptUserText = (transcriptPath) => {
  if (!transcriptPath || typeof transcriptPath !== "string") return ""

  let content = ""
  try {
    const stat = fs.statSync(transcriptPath)
    const start = Math.max(0, stat.size - DTS_CONTEXT_TEXT_MAX_BYTES)
    const fd = fs.openSync(transcriptPath, "r")
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    fs.closeSync(fd)
    content = buffer.toString("utf8")
  } catch {
    return ""
  }

  let lastUserText = ""
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const text = transcriptUserText(JSON.parse(line))
      if (text.trim()) lastUserText = text
    } catch {}
  }
  return lastUserText
}

const setDtsContext = (state, source, text) => {
  state.dtsContext = {
    active: true,
    source,
    evidenceHash: hash(text),
    detectedAt: new Date().toISOString(),
  }
  return true
}

const updateDtsContextFromInput = (state, input, transcriptPath) => {
  if (!DTS_CONTEXT_SKIP) {
    state.dtsContext = null
    return false
  }

  const override = dtsOverrideActive()
  if (override === true) return setDtsContext(state, "env", "SDD_DRIFT_DTS_CONTEXT")
  if (override === false && DTS_CONTEXT_OVERRIDE) {
    state.dtsContext = null
    return false
  }

  const inputText = collectInputContextStrings(input).join("\n")
  if (isDtsContextText(inputText)) return setDtsContext(state, "hook-input", inputText)

  const transcriptText = readLastTranscriptUserText(transcriptPath)
  if (isDtsContextText(transcriptText)) return setDtsContext(state, "transcript", transcriptText)

  return Boolean(state.dtsContext?.active)
}

const isDtsContextActive = (state) => DTS_CONTEXT_SKIP && Boolean(state.dtsContext?.active)

const findSdd = (fp) => {
  const parts = toPosix(path.resolve(fp)).split("/")
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part !== "sdd" && part !== ".sdd") continue

    const rel = parts.slice(index + 1).join("/")
    if (rel === "" || rel.startsWith("changes/") || rel.startsWith("specs/")) {
      return path.normalize(parts.slice(0, index + 1).join("/"))
    }
  }
  return null
}

const getChangeDoc = (fp) => {
  const root = findSdd(fp)
  const rawRel = root ? path.relative(root, fp) : ""
  if (!root || rawRel.startsWith("..")) return null

  const rel = toPosix(rawRel)
  const match = rel.match(/^changes\/([^/]+)\/([^/]+\.md)$/)
  if (!match) return { root, rel }

  const [, id, file] = match
  return {
    root,
    rel,
    id,
    file,
    dir: path.join(root, "changes", id),
  }
}

const touchedSeq = (state, fp) => state.files[normalizeKey(fp)]?.touchedSeq || 0
const editedSeq = (state, fp) => state.files[normalizeKey(fp)]?.editedSeq || 0
const firstEditedSeq = (state, fp) => state.files[normalizeKey(fp)]?.firstEditedSeq || 0

const latestEditedCodeSeq = (state) =>
  Object.values(state.files || {}).reduce((latest, file) => {
    if (!file.editedSeq || !isCodePath(file.path || "")) return latest
    return Math.max(latest, file.editedSeq || 0)
  }, 0)

const editedSddSeqAfter = (state, files, seq) =>
  files.some((file) => editedSeq(state, file) > seq)

const rel = (cwd, fp) => toPosix(path.relative(cwd, fp))

const getToolFilePath = (toolInput) =>
  toolInput?.file_path || toolInput?.filePath || toolInput?.path

const getToolEventKey = (input) => {
  const id = input?.tool_use_id || input?.toolUseId
  if (typeof id === "string" && id.trim()) {
    return `${input.session_id || "default"}:${input.hook_event_name || ""}:${id.trim()}`
  }
  return null
}

const markToolEvent = (state, eventKey) => {
  if (!eventKey) return true
  if (state.toolEvents[eventKey]) return false

  state.toolEvents[eventKey] = Date.now()
  const entries = Object.entries(state.toolEvents)
  if (entries.length > TOOL_EVENT_CAP) {
    entries
      .sort((left, right) => Number(left[1] || 0) - Number(right[1] || 0))
      .slice(0, entries.length - TOOL_EVENT_CAP)
      .forEach(([key]) => {
        delete state.toolEvents[key]
      })
  }
  return true
}

const markTranscriptEvent = (state, eventKey) => {
  if (!eventKey) return true
  if (state.transcriptEvents[eventKey]) return false

  state.transcriptEvents[eventKey] = Date.now()
  const entries = Object.entries(state.transcriptEvents)
  if (entries.length > TRANSCRIPT_EVENT_CAP) {
    entries
      .sort((left, right) => Number(left[1] || 0) - Number(right[1] || 0))
      .slice(0, entries.length - TRANSCRIPT_EVENT_CAP)
      .forEach(([key]) => {
        delete state.transcriptEvents[key]
      })
  }
  return true
}

const recordFile = (state, fp, edited) => {
  const abs = path.normalize(path.resolve(fp))
  const key = normalizeKey(abs)
  const existing = state.files[key] || {}
  state.clock += 1
  state.files[key] = {
    ...existing,
    path: abs,
    touchedSeq: state.clock,
    ...(edited ? { editedSeq: state.clock } : {}),
    ...(edited ? { firstEditedSeq: existing.firstEditedSeq || existing.editedSeq || state.clock } : {}),
  }
  addPath(state.touched, abs)
  if (edited) addPath(state.edited, abs)
  return state.clock
}

const addChangeDir = (state, dir) => addPath(state.changeDirs, dir)

const applyToolRecord = (cwd, state, toolName, toolInput) => {
  const fp = getToolFilePath(toolInput || {})
  if (!fp || typeof fp !== "string") return false

  const tool = String(toolName || "").toLowerCase()
  const isEdit = tool === "edit" || tool === "write" || tool === "multiedit"
  if (!isEdit && tool !== "read") return false

  const abs = resolveFile(cwd, fp)
  const seq = recordFile(state, abs, isEdit)

  if (isEdit) {
    const doc = getChangeDoc(abs)
    if (doc?.dir && doc.file) {
      addChangeDir(state, doc.dir)
      updateRequirementsForEdit(state, doc.dir, doc.file, seq)
    }
  }

  return true
}

const transcriptContentBlocks = (entry) => {
  const content = entry?.message?.content
  if (Array.isArray(content)) return content
  return []
}

const transcriptToolUseRecord = (block) => {
  const name = block?.name || block?.tool || block?.tool_name
  const input = block?.input || block?.tool_input || block?.state?.input
  if (!name || !input || typeof input !== "object") return null
  return {
    id: block.id || block.tool_use_id || block.callID || block.call_id || null,
    name,
    input,
    source: "tool_use",
    completed: block?.state?.status === "completed",
  }
}

const transcriptToolResultRecord = (entry, block) => {
  const result = entry?.tool_use_result || block?.tool_use_result
  const id = block?.tool_use_id || entry?.parent_tool_use_id || entry?.tool_use_id || null
  const failed = Boolean(entry?.is_error || block?.is_error || result?.is_error || result?.error)
  const fp = result?.filePath || result?.file_path
  if (!fp || typeof fp !== "string") {
    return id ? { id, source: "tool_result", failed } : null
  }

  const type = String(result?.type || "").toLowerCase()
  const name =
    type === "text" && !result?.oldString && !result?.newString && !result?.structuredPatch
      ? "Read"
      : "Edit"
  return {
    id,
    name,
    input: { file_path: fp },
    source: "tool_result",
    failed,
  }
}

const transcriptLegacyToolResultRecord = (entry) => {
  const name = entry?.tool_name
  const input = entry?.tool_input
  if (!name || !input || typeof input !== "object") return null
  return {
    id: entry.tool_use_id || null,
    name,
    input,
    source: "tool_result",
    failed: Boolean(entry?.is_error || entry?.error),
  }
}

const transcriptToolRecords = (entry) => {
  const records = []
  const blocks = transcriptContentBlocks(entry)
  const add = (record) => {
    if (record) records.push(record)
  }

  add(transcriptToolUseRecord(entry))
  if (entry?.part?.type === "tool") add(transcriptToolUseRecord(entry.part))
  if (entry?.type === "tool_result") {
    add(transcriptLegacyToolResultRecord(entry))
  }

  for (const block of blocks) {
    if (block?.type === "tool_use") add(transcriptToolUseRecord(block))
    if (block?.type === "tool_result") add(transcriptToolResultRecord(entry, block))
  }

  if (entry?.type === "user" && !blocks.some((block) => block?.type === "tool_result")) {
    add(transcriptToolResultRecord(entry, null))
  }
  return records
}

const transcriptToolEventKey = (record, lineIndex, recordIndex) => {
  if (record?.id) return `id:${record.id}`
  return `pos:${lineIndex}:${recordIndex}:${hash(
    JSON.stringify({
      name: String(record?.name || "").toLowerCase(),
      input: record?.input || {},
    })
  )}`
}

const getRequirementBucket = (state, dir, create) => {
  const key = normalizeKey(dir)
  if (!state.requirements[key] && create) {
    state.requirements[key] = { dir: path.normalize(dir), files: {} }
  }
  return state.requirements[key]
}

const cleanupRequirementBucket = (state, dir) => {
  const key = normalizeKey(dir)
  const bucket = state.requirements[key]
  if (bucket && Object.keys(bucket.files || {}).length === 0) delete state.requirements[key]
}

const getPeerSyncBucket = (state, dir, create) => {
  const key = normalizeKey(dir)
  if (!state.peerSyncs[key] && create) {
    state.peerSyncs[key] = { dir: path.normalize(dir), files: {} }
  }
  return state.peerSyncs[key]
}

const cleanupPeerSyncBucket = (state, dir) => {
  const key = normalizeKey(dir)
  const bucket = state.peerSyncs[key]
  if (bucket && Object.keys(bucket.files || {}).length === 0) delete state.peerSyncs[key]
}

const markPeerSyncResponse = (state, dir, file, sourceFile, sourceSeq, targetSeq) => {
  if (!sourceFile) return
  const bucket = getPeerSyncBucket(state, dir, true)
  bucket.files[file] = { sourceFile, sourceSeq, targetSeq }
}

const isPeerSyncContinuation = (state, dir, file, seq) => {
  const bucket = getPeerSyncBucket(state, dir, false)
  const sync = bucket?.files?.[file]
  if (!sync?.sourceFile) return false

  const sourceSeq = editedSeq(state, path.join(dir, sync.sourceFile))
  if (sourceSeq > sync.sourceSeq) {
    delete bucket.files[file]
    cleanupPeerSyncBucket(state, dir)
    return false
  }

  if (seq > sync.targetSeq) sync.targetSeq = seq
  return true
}

const clearPeerSyncsForSourceEdit = (state, dir, sourceFile, seq) => {
  const bucket = getPeerSyncBucket(state, dir, false)
  if (!bucket) return

  for (const [file, sync] of Object.entries(bucket.files || {})) {
    if (sync?.sourceFile === sourceFile && seq > sync.sourceSeq) delete bucket.files[file]
  }
  cleanupPeerSyncBucket(state, dir)
}

const clearPeerSyncs = (state) => {
  state.peerSyncs = {}
}

const clearStageOnlyRequirements = (state) => {
  for (const [key, bucket] of Object.entries(state.requirements || {})) {
    for (const [file, requirement] of Object.entries(bucket.files || {})) {
      if (requirement?.stageOnly || requirement?.sourceFile === PROPOSAL_FILE) delete bucket.files[file]
    }
    if (Object.keys(bucket.files || {}).length === 0) delete state.requirements[key]
  }
}

const isInitialTasksPlanEdit = (state, dir, seq) => {
  const tasksPath = path.join(dir, TASKS_FILE)
  const designPath = path.join(dir, DESIGN_FILE)
  const designSourceSeq = Math.max(touchedSeq(state, designPath), editedSeq(state, designPath))
  return (
    firstEditedSeq(state, tasksPath) === seq &&
    designSourceSeq > 0 &&
    fs.existsSync(designPath)
  )
}

const updateRequirementsForEdit = (state, dir, file, seq) => {
  const bucket = getRequirementBucket(state, dir, false)
  const pending = bucket?.files?.[file]
  let satisfiedStageOnly = false
  if (pending && seq > pending.afterSeq) {
    satisfiedStageOnly = Boolean(pending.stageOnly || pending.sourceFile === PROPOSAL_FILE)
    if (!satisfiedStageOnly) {
      markPeerSyncResponse(state, dir, file, pending.sourceFile, pending.afterSeq, seq)
    }
    delete bucket.files[file]
    cleanupRequirementBucket(state, dir)
    if (!satisfiedStageOnly) return
  }

  if (!satisfiedStageOnly && isPeerSyncContinuation(state, dir, file, seq)) return
  if (file === TASKS_FILE && isInitialTasksPlanEdit(state, dir, seq)) {
    const designPath = path.join(dir, DESIGN_FILE)
    markPeerSyncResponse(
      state,
      dir,
      TASKS_FILE,
      DESIGN_FILE,
      Math.max(touchedSeq(state, designPath), editedSeq(state, designPath)),
      seq
    )
    return
  }
  clearPeerSyncsForSourceEdit(state, dir, file, seq)

  const stageOnly = file === PROPOSAL_FILE
  let requiredPeers = CHANGE_DOC_REQUIREMENTS[file] || []
  if (file === TASKS_FILE) {
    const latestCodeSeq = latestEditedCodeSeq(state)
    const designReviewedAfterCode = touchedSeq(state, path.join(dir, DESIGN_FILE)) > latestCodeSeq
    const tasksEditedAfterCode = seq > latestCodeSeq
    if (latestCodeSeq > 0 && designReviewedAfterCode && tasksEditedAfterCode) {
      requiredPeers = []
    }
  }
  if (requiredPeers.length === 0) return

  const target = getRequirementBucket(state, dir, true)
  for (const peer of requiredPeers) {
    const peerPath = path.join(dir, peer)
    if (!fs.existsSync(peerPath)) continue
    if (editedSeq(state, peerPath) > seq) continue
    const existing = target.files[peer]
    if (existing && !existing.stageOnly && stageOnly) continue
    target.files[peer] = {
      sourceFile: file,
      afterSeq: seq,
      stageOnly,
    }
  }
  cleanupRequirementBucket(state, dir)
}

const hydrateStateFromTranscript = (cwd, state, transcriptPath) => {
  if (!transcriptPath || typeof transcriptPath !== "string") return false

  let changed = false
  let content = ""
  const seen = new Set()
  const pendingToolUses = new Map()
  try {
    content = fs.readFileSync(transcriptPath, "utf8")
  } catch {
    return false
  }

  const lines = content.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    if (!line.trim()) continue

    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    const records = transcriptToolRecords(entry)
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const record = records[recordIndex]
      if (record.source === "tool_use" && record.id && !record.completed) {
        pendingToolUses.set(record.id, record)
        continue
      }

      let finalRecord = record
      if (record.source === "tool_result" && record.id && pendingToolUses.has(record.id)) {
        finalRecord = {
          ...pendingToolUses.get(record.id),
          source: "tool_result",
          failed: record.failed,
        }
      }
      if (finalRecord.failed) continue
      if (finalRecord.source === "tool_use" && !finalRecord.completed) continue

      const key = transcriptToolEventKey(finalRecord, lineIndex, recordIndex)
      if (seen.has(key)) continue
      seen.add(key)
      if (!markTranscriptEvent(state, key)) continue
      if (applyToolRecord(cwd, state, finalRecord.name, finalRecord.input)) changed = true
    }
  }

  return changed
}

const hasEditedSddChange = (state) =>
  Object.values(state.files).some((file) => file.editedSeq && isSddChangePath(file.path || ""))

const drift = (cwd, fp, state) => {
  const warn = []
  const doc = getChangeDoc(fp)
  if (!hasSddWorkspace(cwd) || isDtsContextActive(state)) return warn

  if (doc?.root) {
    if (doc.rel.startsWith("specs/")) {
      warn.push(
        `SDD DRIFT: ${doc.rel} was changed directly. SDD changes should normally go through sdd/changes/<id>/. If this bypass is intentional, mention it explicitly.`
      )
    }
    return warn
  }

  if (CODE_EXT.test(fp) && !hasEditedSddChange(state)) {
    warn.push(
      `SDD DRIFT: code file ${path.basename(fp)} was changed, but this session did not edit any sdd/changes/** file. SDD expects a change proposal first.`
    )
  }

  return warn
}

const collectPeerGaps = (cwd, state, options = {}) => {
  const includeStageOnly = options.includeStageOnly !== false
  const includeHard = options.includeHard !== false
  const gaps = []

  for (const bucket of Object.values(state.requirements || {})) {
    const dir = bucket.dir
    const absent = []
    const unsynced = []
    const stale = []
    const required = []
    const pendingRequirements = []

    for (const [file, requirement] of Object.entries(bucket.files || {})) {
      const requirementStageOnly = Boolean(requirement?.stageOnly || requirement?.sourceFile === PROPOSAL_FILE)
      if (requirementStageOnly ? !includeStageOnly : !includeHard) continue

      const peerPath = path.join(dir, file)
      const seq = editedSeq(state, peerPath)
      if (seq > requirement.afterSeq) continue

      required.push(file)
      pendingRequirements.push({ file, ...requirement, stageOnly: requirementStageOnly })
      if (!fs.existsSync(peerPath)) {
        absent.push(file)
      } else if (seq === 0) {
        unsynced.push(file)
      } else {
        stale.push(file)
      }
    }

    if (!required.length) continue

    const stageOnly = pendingRequirements.every((requirement) => requirement.stageOnly)
    if (stageOnly && !includeStageOnly) continue

    const edited = [PROPOSAL_FILE, ...PEER_FILES].filter((file) => editedSeq(state, path.join(dir, file)) > 0)
    const relDir = toPosix(path.relative(cwd, dir))
    gaps.push({
      relDir,
      edited,
      sourceFiles: [...new Set(pendingRequirements.map((requirement) => requirement.sourceFile).filter(Boolean))],
      stageOnly,
      absent,
      missing: absent,
      unsynced,
      stale,
      required,
    })
  }

  return gaps
}

const discoverChangeDirs = (cwd) => {
  const roots = ["sdd", ".sdd"].map((dir) => path.join(cwd, dir))
  const dirs = []

  for (const root of roots) {
    const changesRoot = path.join(root, "changes")
    try {
      for (const entry of fs.readdirSync(changesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(changesRoot, entry.name))
      }
    } catch {}
  }

  return dirs
}

const collectReviewTargets = (cwd, state) => {
  if (!hasSddWorkspace(cwd)) return []

  const dirs = [...(state.changeDirs || []), ...discoverChangeDirs(cwd)]
  const targets = []

  for (const dir of dirs) {
    for (const file of REVIEW_FILES) {
      const target = path.join(dir, file)
      if (!targets.some((existing) => samePath(existing, target))) {
        targets.push(path.normalize(target))
      }
    }
  }

  if (targets.length) return targets

  const fallbackRoot = fs.existsSync(path.join(cwd, ".sdd")) ? ".sdd" : "sdd"
  return REVIEW_FILES.map((file) => path.join(cwd, fallbackRoot, "changes", "<change-id>", file))
}

const codeReviewSignature = (cwd, gap) =>
  hash(
    JSON.stringify({
      codeFiles: (gap.codeFiles || []).map((file) => rel(cwd, file)).sort(),
      latestCodeSeq: gap.latestCodeSeq || 0,
      reviewTargets: (gap.reviewTargets || []).map((file) => rel(cwd, file)).sort(),
    })
  )

const isCodeReviewConfirmed = (state, signature) =>
  Boolean(signature && state.codeReviewConfirmations?.[signature]?.confirmed)

const collectCodeGaps = (cwd, state) => {
  if (!hasSddWorkspace(cwd) || isDtsContextActive(state)) return []

  const codeFiles = Object.values(state.files || {})
    .filter((file) => file.editedSeq && isCodePath(file.path || ""))
    .sort((left, right) => (right.editedSeq || 0) - (left.editedSeq || 0))

  if (!codeFiles.length) return []

  const latestCodeSeq = codeFiles[0].editedSeq || 0
  const reviewTargets = collectReviewTargets(cwd, state)
  const pendingReviewTargets = reviewTargets.filter((file) => touchedSeq(state, file) <= latestCodeSeq)
  const baseGap = {
    codeFiles: codeFiles.map((file) => file.path),
    latestCodeSeq,
    reviewTargets,
    pendingReviewTargets,
  }
  const reviewSignature = codeReviewSignature(cwd, baseGap)
  const reviewReady = pendingReviewTargets.length === 0
  const hasReviewEdit = editedSddSeqAfter(state, reviewTargets, latestCodeSeq)

  if (reviewReady && (hasReviewEdit || isCodeReviewConfirmed(state, reviewSignature))) return []

  return [
    {
      ...baseGap,
      reviewSignature,
      reviewReady,
      needsConfirmation: reviewReady && !hasReviewEdit,
    },
  ]
}

const formatGap = (gap) => {
  const parts = [`required [${gap.required.join(", ")}]`]
  if (gap.stageOnly) parts.push("stage reminder")
  if (gap.absent?.length) parts.push(`absent [${gap.absent.join(", ")}]`)
  if (gap.unsynced?.length) parts.push(`unsynced in this session [${gap.unsynced.join(", ")}]`)
  if (gap.stale?.length) parts.push(`stale [${gap.stale.join(", ")}]`)
  return `${gap.relDir}: edited [${gap.edited.join(", ")}], ${parts.join(", ")}`
}

const buildToolEnforcement = (gaps, options = {}) => {
  const compact = Boolean(options.compact)
  const stageOnly = gaps.length > 0 && gaps.every((gap) => gap.stageOnly)
  const detail = gaps
    .map(
      (gap) =>
        `- ${formatGap(gap)}. Synchronize: ${gap.required
          .map((file) => `${gap.relDir}/${file}`)
          .join(", ")}`
    )
    .join("\n")

  if (stageOnly) {
    return [
      "SDD proposal stage reminder.",
      "The preceding tool changed proposal.md. A proposal-only turn is valid; if the current user request only asked for proposal drafting or refinement, you may finish normally.",
      "If you continue this same request into design work, read the current design.md first and update the appropriate existing section without changing its template.",
      "Do not create or edit tasks.md directly from proposal.md. Let tasks.md follow only after design.md has been reviewed or updated.",
      detail,
    ].join("\n")
  }

  if (compact) {
    return [
      "SDD drift reminder.",
      "Peer SDD document synchronization is still pending:",
      detail,
      "For listed peer files, read them first and edit/write only what is needed. If a listed file disappeared, do not recreate it unless the current user request explicitly needs that stage.",
    ].join("\n")
  }

  return [
    "SDD drift tool result enforcement.",
    "The preceding tool changed SDD change document(s), but peer document(s) are still unsynchronized:",
    detail,
    "",
    "This assistant turn is incomplete until the required peer document(s) are synchronized.",
    "Before any final answer, read each listed required peer file, then use edit or write to synchronize it with the edited SDD change document(s). If a listed file disappeared, do not recreate it unless the current user request explicitly needs that stage.",
    ...DOCUMENT_SYNC_RULES,
    "Do not stop or summarize completion until the required peer document(s) are updated.",
  ].join("\n")
}

const formatCodeReviewTargets = (cwd, files) => files.map((file) => rel(cwd, file)).join(", ")

const buildCodeEnforcement = (cwd, gaps, options = {}) => {
  const compact = Boolean(options.compact)
  const detail = gaps
    .map((gap) => {
      const codeList = gap.codeFiles.map((file) => rel(cwd, file)).join(", ")
      const reviewList = formatCodeReviewTargets(cwd, gap.reviewTargets || [])
      const pendingTargets = gap.pendingReviewTargets || gap.reviewTargets || []
      const pendingList = pendingTargets.length
        ? formatCodeReviewTargets(cwd, pendingTargets)
        : "none; final review confirmation marker is pending"
      return `- changed code file(s) [${codeList}]. Review SDD document(s): ${reviewList}. Still needs review: ${pendingList}`
    })
    .join("\n")

  if (compact) {
    return [
      "SDD drift tool result enforcement.",
      "SDD drift reminder: implementation code still has pending SDD review for this code-change batch:",
      detail,
      "",
      "Before the final answer, read/review the listed design.md and tasks.md files, then update only the documents that actually need changes.",
      "If you edit an SDD document, preserve its existing Markdown headings and template; do not replace it with a summary or single-line marker.",
      "If review shows no SDD document needs changes, leave the files unchanged; do not create a no-op edit just to satisfy this hook.",
      "After both documents have been reviewed, you may finish normally; the hook records the no-edit review decision and leaves a human confirmation note.",
      SUBAGENT_REVIEW_RULE,
    ].join("\n")
  }

  return [
    "SDD drift tool result enforcement.",
    "The preceding tool changed implementation code. SDD reconciliation review is now pending for this code-change batch:",
    detail,
    "",
    "This is a deferred review checkpoint, not an instruction to stop coding immediately.",
    "Continue implementation work if more code changes are still required.",
    "When the implementation for this task is complete, and before any final answer, use the read tool to review the relevant design.md and tasks.md files.",
    "After review, update only the SDD document(s) that actually need changes. It is valid to leave design.md and/or tasks.md unchanged when the review shows they already match the code.",
    "If no SDD document needs changes, do not create a no-op edit. In the final answer, say that SDD docs were reviewed and no document edit was needed, so the user can confirm that decision if they expected documentation changes.",
    "If the listed path contains <change-id>, choose or create the correct sdd/changes/<change-id>/ document path for this code change.",
    ...DOCUMENT_SYNC_RULES,
    "Do not create a no-op edit or add a new section just to satisfy this hook.",
    SUBAGENT_REVIEW_RULE,
    "Do not give the final answer while this code-change batch still has unreviewed SDD documents.",
  ].join("\n")
}

const serializablePeerGap = (gap) => ({
  relDir: gap.relDir,
  edited: [...gap.edited].sort(),
  sourceFiles: [...(gap.sourceFiles || [])].sort(),
  stageOnly: Boolean(gap.stageOnly),
  absent: [...(gap.absent || [])].sort(),
  unsynced: [...(gap.unsynced || [])].sort(),
  stale: [...gap.stale].sort(),
  required: [...gap.required].sort(),
})

const serializableCodeGap = (cwd, gap) => ({
  codeFiles: gap.codeFiles.map((file) => rel(cwd, file)).sort(),
  latestCodeSeq: gap.latestCodeSeq || 0,
  reviewTargets: (gap.reviewTargets || []).map((file) => rel(cwd, file)).sort(),
  pendingReviewTargets: (gap.pendingReviewTargets || []).map((file) => rel(cwd, file)).sort(),
  reviewReady: Boolean(gap.reviewReady),
  needsConfirmation: Boolean(gap.needsConfirmation),
})

const clearCodeDriftNoticeIfResolved = (state, codeGaps) => {
  if (codeGaps.length) return
  state.codeDriftNotice = null
}

const clearPeerDriftNoticeIfResolved = (state, peerGaps) => {
  if (peerGaps.length) return
  state.peerDriftNotice = null
}

const peerDriftSignature = (peerGaps) =>
  hash(JSON.stringify({ type: "peer", gaps: peerGaps.map(serializablePeerGap) }))

const markPeerDriftNoticeEmitted = (state, peerGaps) => {
  if (!peerGaps.length) return
  state.peerDriftNotice = {
    active: true,
    signature: peerDriftSignature(peerGaps),
    emittedAt: new Date().toISOString(),
  }
}

const codeReviewToolMaxReminders = () => {
  if (!Number.isFinite(CODE_REVIEW_TOOL_MAX_REMINDERS)) return 1
  return Math.max(0, CODE_REVIEW_TOOL_MAX_REMINDERS)
}

const codeDriftNoticeEmissionCount = (state) =>
  Math.max(0, Number(state.codeDriftNotice?.emissionCount || 0))

const hasPendingCodeReview = (codeGaps) => codeGaps.some((gap) => !gap.reviewReady)

const shouldEmitCodeDriftNotice = (state, codeGaps) => {
  if (!hasPendingCodeReview(codeGaps)) return false
  const maxReminders = codeReviewToolMaxReminders()
  if (maxReminders === 0) return false
  if (!state.codeDriftNotice?.active) return true
  return codeDriftNoticeEmissionCount(state) < maxReminders
}

const isCodeDriftNoticeSuppressed = (state, codeGaps) =>
  hasPendingCodeReview(codeGaps) &&
  Boolean(state.codeDriftNotice?.active) &&
  codeDriftNoticeEmissionCount(state) >= codeReviewToolMaxReminders()

const markCodeDriftNoticeEmitted = (cwd, state, codeGaps) => {
  if (!codeGaps.length) return
  const existing = state.codeDriftNotice || {}
  state.codeDriftNotice = {
    ...existing,
    active: true,
    firstCodeSeq: existing.firstCodeSeq || codeGaps[0].latestCodeSeq || 0,
    latestCodeSeq: codeGaps[0].latestCodeSeq || existing.latestCodeSeq || 0,
    signature: hash(JSON.stringify(codeGaps.map((gap) => serializableCodeGap(cwd, gap)))),
    emittedAt: existing.emittedAt || new Date().toISOString(),
    lastEmittedAt: new Date().toISOString(),
    emissionCount: codeDriftNoticeEmissionCount(state) + 1,
  }
}

const pruneCodeReviewConfirmations = (state) => {
  const entries = Object.entries(state.codeReviewConfirmations || {})
  if (entries.length <= CODE_REVIEW_CONFIRMATION_CAP) return

  entries
    .sort((left, right) => {
      const leftAt = Date.parse(left[1]?.confirmedAt || left[1]?.requestedAt || 0) || 0
      const rightAt = Date.parse(right[1]?.confirmedAt || right[1]?.requestedAt || 0) || 0
      return leftAt - rightAt
    })
    .slice(0, entries.length - CODE_REVIEW_CONFIRMATION_CAP)
    .forEach(([key]) => {
      delete state.codeReviewConfirmations[key]
    })
}

const markCodeReviewNoEditConfirmation = (state, gaps) => {
  if (!gaps.length || !gaps.every((gap) => gap.needsConfirmation && gap.reviewReady)) return false

  let confirmed = true
  for (const gap of gaps) {
    const signature = gap.reviewSignature
    if (!signature) {
      confirmed = false
      continue
    }

    const existing = state.codeReviewConfirmations[signature] || {}
    state.codeReviewConfirmations[signature] = {
      ...existing,
      requested: true,
      requestedAt: existing.requestedAt || new Date().toISOString(),
      confirmed: true,
      confirmedAt: new Date().toISOString(),
      codeSeq: gap.latestCodeSeq || 0,
      codeFiles: (gap.codeFiles || []).map((file) => file.path || file),
      reviewTargets: gap.reviewTargets || [],
      noSddEdit: true,
      userConfirmationRecommended: true,
    }
  }

  pruneCodeReviewConfirmations(state)
  return confirmed
}

const buildPendingEnforcement = (cwd, state, options = {}) => {
  const peerGaps = collectPeerGaps(cwd, state, {
    includeStageOnly: options.includeStageOnly !== false,
  })
  if (peerGaps.length) {
    return {
      type: "peer",
      message: buildToolEnforcement(peerGaps),
      signature: peerDriftSignature(peerGaps),
    }
  }

  const codeGaps = collectCodeGaps(cwd, state)
  if (codeGaps.length) {
    return {
      type: "code",
      message: buildCodeEnforcement(cwd, codeGaps),
      signature: hash(JSON.stringify({ type: "code", gaps: codeGaps.map((gap) => serializableCodeGap(cwd, gap)) })),
      gaps: codeGaps,
    }
  }

  return null
}

const markStopCodeReviewConfirmation = (state, pending) => {
  if (pending?.type !== "code") return false
  return markCodeReviewNoEditConfirmation(state, pending.gaps || [])
}

const buildStopEnforcement = (pendingMessage) =>
  [
    "SDD drift stop enforcement.",
    "The assistant attempted to stop while required SDD synchronization or review is still missing.",
    "",
    pendingMessage,
    "",
    "Continue the current task now. Do not ask the user for permission to continue.",
    "For code-review gaps, read/review the listed SDD document(s), then update only the files that actually need changes.",
    "If those documents have already been reviewed and no edit is needed, stop again with a concise final answer; the hook will record the review confirmation marker.",
    "For peer-sync gaps, use read, then edit or write, to synchronize the listed SDD document(s) before trying to stop again.",
  ].join("\n")

const collectCodeReviewAdvisoryLines = (cwd, state) =>
  Object.values(state.codeReviewConfirmations || {})
    .filter((confirmation) => confirmation?.confirmed && confirmation?.userConfirmationRecommended)
    .sort((left, right) => {
      const leftSeq = Number(left.codeSeq || 0)
      const rightSeq = Number(right.codeSeq || 0)
      return rightSeq - leftSeq
    })
    .map((confirmation) => {
      const codeList = (confirmation.codeFiles || [])
        .map((file) => rel(cwd, file))
        .join(", ")
      const reviewList = (confirmation.reviewTargets || [])
        .map((file) => rel(cwd, file))
        .join(", ")
      return `  - reviewed SDD document(s) after code change(s) [${codeList || "unknown"}] and made no SDD edits. User confirmation recommended for: ${reviewList || "design.md, tasks.md"}`
    })

const collectReportLines = (cwd, state) => {
  const lines = collectPeerGaps(cwd, state, { includeStageOnly: false }).map((gap) => `  - ${formatGap(gap)}`)

  for (const gap of collectCodeGaps(cwd, state)) {
    const codeList = gap.codeFiles.map((file) => rel(cwd, file)).join(", ")
    const reviewList = (gap.pendingReviewTargets || gap.reviewTargets || [])
      .map((file) => rel(cwd, file))
      .join(", ")
    lines.push(
      `  - edited code file(s) [${codeList}], but did not review SDD document(s) after the code change: ${reviewList}`
    )
  }

  lines.push(...collectCodeReviewAdvisoryLines(cwd, state))
  return lines
}

const refreshReport = (cwd, state) => {
  const reportPath = path.join(cwd, ".sdd-drift-report.md")
  const lines = collectReportLines(cwd, state)

  if (lines.length) {
    try {
      const body = lines.join("\n") + "\n"
      try {
        const existing = fs.readFileSync(reportPath, "utf8")
        if (existing.replace(/^## .*\r?\n/, "") === body) return
      } catch {}
      writeTextAtomic(reportPath, "## " + new Date().toISOString() + "\n" + body)
    } catch {}
    return
  }

  try {
    fs.unlinkSync(reportPath)
  } catch {}
}

const isOpenCodeHookInput = (input) => {
  if (OUTPUT_MODE === "opencode") return true
  if (OUTPUT_MODE === "claude" || OUTPUT_MODE === "claude-code") return false
  return input?.hook_source === "opencode-plugin"
}

const buildClaudeCodeOutput = (hookEventName, message) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: hookEventName || "PostToolUse",
      additionalContext: message,
    },
  })

const buildStopOutput = (input, message) => {
  if (isOpenCodeHookInput(input)) {
    return JSON.stringify({
      decision: "block",
      reason: message,
      inject_prompt: message,
      stop_hook_active: true,
    })
  }
  return JSON.stringify({
    decision: "block",
    reason: message,
  })
}

const emitEnforcement = (input, message) => {
  if (STRICT_BLOCK) {
    process.stderr.write(message)
    process.exit(2)
  }
  if (isOpenCodeHookInput(input)) {
    process.stdout.write(message)
    return
  }
  process.stdout.write(buildClaudeCodeOutput(input?.hook_event_name, message))
}

const emitStopEnforcement = (input, message) => {
  if (STRICT_BLOCK) {
    process.stderr.write(message)
    process.exit(2)
  }
  process.stdout.write(buildStopOutput(input, message))
}

const main = async () => {
  const input = parseHookInput(await readStdin())
  const cwd = input.cwd || process.cwd()
  if (!hasSddWorkspace(cwd)) return

  const sessionID = input.session_id || "default"
  const currentStatePath = statePath(cwd, sessionID)
  const stateLock = acquireFileLock(currentStatePath, {
    staleMs: STATE_LOCK_STALE_MS,
    waitMs: STATE_LOCK_WAIT_MS,
    retryMs: STATE_LOCK_RETRY_MS,
  })

  if (!stateLock) {
    writeDiagnosticLog(cwd, {
      event: "state_lock_unavailable",
      input: summarizeInput(input),
      statePath: currentStatePath,
    })
    return
  }

  try {
  const state = loadState(cwd, sessionID)
  const transcriptPathForContext = resolveTranscriptPath(input)
  const dtsContextActive = updateDtsContextFromInput(state, input, transcriptPathForContext)
  writeDiagnosticLog(cwd, {
    event: "hook_start",
    input: summarizeInput(input),
    statePath: currentStatePath,
    stateLockAcquired: Boolean(stateLock),
    outputMode: OUTPUT_MODE || "auto",
    strictBlock: STRICT_BLOCK,
    dtsContextActive,
  })

  if (input.hook_event_name === "Stop") {
    const transcriptPath = transcriptPathForContext
    const hydrated = hydrateStateFromTranscript(cwd, state, transcriptPath)
    const pending = buildPendingEnforcement(cwd, state, { includeStageOnly: false })
    if (!pending) {
      state.stopBlocks = {}
      clearPeerSyncs(state)
      clearStageOnlyRequirements(state)
      refreshReport(cwd, state)
      saveState(cwd, sessionID, state)
      writeDiagnosticLog(cwd, {
        event: "stop_allow_no_pending",
        input: summarizeInput(input),
        transcriptPath: transcriptPath ? limitString(transcriptPath) : null,
        hydrated,
      })
      return
    }

    const reviewConfirmationReady =
      pending.type === "code" &&
      (pending.gaps || []).length > 0 &&
      (pending.gaps || []).every((gap) => gap.needsConfirmation && gap.reviewReady)
    if (markStopCodeReviewConfirmation(state, pending)) {
      state.stopBlocks = {}
      clearPeerSyncs(state)
      refreshReport(cwd, state)
      saveState(cwd, sessionID, state)
      writeDiagnosticLog(cwd, {
        event: "stop_allow_review_confirmed",
        input: summarizeInput(input),
        pendingType: pending.type,
        pendingSignature: pending.signature,
        transcriptPath: transcriptPath ? limitString(transcriptPath) : null,
        hydrated,
      })
      return
    }

    refreshReport(cwd, state)

    const configuredMaxBlocks = pending.type === "code" ? CODE_REVIEW_STOP_MAX_BLOCKS : STOP_MAX_BLOCKS
    const maxBlocks = Number.isFinite(configuredMaxBlocks)
      ? Math.max(0, configuredMaxBlocks)
      : pending.type === "code"
        ? 1
        : 2
    const blockCount = state.stopBlocks[pending.signature] || 0
    if (blockCount >= maxBlocks) {
      saveState(cwd, sessionID, state)
      writeDiagnosticLog(cwd, {
        event: "stop_allow_max_blocks",
        input: summarizeInput(input),
        pendingType: pending.type,
        pendingSignature: pending.signature,
        blockCount,
        maxBlocks,
      })
      return
    }

    state.stopBlocks[pending.signature] = blockCount + 1
    saveState(cwd, sessionID, state)
    writeDiagnosticLog(cwd, {
      event: reviewConfirmationReady ? "stop_review_confirmation_requested" : "stop_block_emit",
      input: summarizeInput(input),
      pendingType: pending.type,
      pendingSignature: pending.signature,
      blockCount: blockCount + 1,
      maxBlocks,
      messagePreview: limitString(pending.message, 800),
    })
    emitStopEnforcement(input, buildStopEnforcement(pending.message))
    return
  }

  if (input.hook_event_name !== "PostToolUse") {
    saveState(cwd, sessionID, state)
    refreshReport(cwd, state)
    writeDiagnosticLog(cwd, {
      event: "ignored_event",
      input: summarizeInput(input),
    })
    return
  }

  const tool = String(input.tool_name || "").toLowerCase()
  const toolInput = input.tool_input || {}
  const fp = getToolFilePath(toolInput)
  if (!fp || typeof fp !== "string") {
    writeDiagnosticLog(cwd, {
      event: "ignored_no_file_path",
      input: summarizeInput(input),
    })
    return
  }

  const abs = resolveFile(cwd, fp)
  const isEdit = tool === "edit" || tool === "write" || tool === "multiedit"

  if (!markToolEvent(state, getToolEventKey(input))) {
    saveState(cwd, sessionID, state)
    refreshReport(cwd, state)
    writeDiagnosticLog(cwd, {
      event: "ignored_duplicate_tool_event",
      input: summarizeInput(input),
      file: rel(cwd, abs),
    })
    return
  }

  if (!applyToolRecord(cwd, state, tool, toolInput)) {
    saveState(cwd, sessionID, state)
    refreshReport(cwd, state)
    writeDiagnosticLog(cwd, {
      event: "ignored_unsupported_tool_record",
      input: summarizeInput(input),
      file: rel(cwd, abs),
    })
    return
  }

  const warnings = isEdit ? drift(cwd, abs, state) : []
  const peerGaps = collectPeerGaps(cwd, state)
  const hardPeerGaps = collectPeerGaps(cwd, state, { includeStageOnly: false })
  const stagePeerGaps = collectPeerGaps(cwd, state, { includeHard: false })
  let codeGaps = collectCodeGaps(cwd, state)
  const codeReviewNoEditConfirmed =
    !hardPeerGaps.length && markCodeReviewNoEditConfirmation(state, codeGaps)
  if (codeReviewNoEditConfirmed) {
    codeGaps = collectCodeGaps(cwd, state)
  }
  const noticePeerGaps = hardPeerGaps.length ? hardPeerGaps : stagePeerGaps
  clearPeerDriftNoticeIfResolved(state, noticePeerGaps)
  clearCodeDriftNoticeIfResolved(state, codeGaps)
  const emitCodeGap = !hardPeerGaps.length && shouldEmitCodeDriftNotice(state, codeGaps)
  const suppressCodeGap = !hardPeerGaps.length && !emitCodeGap && isCodeDriftNoticeSuppressed(state, codeGaps)
  const emitStagePeerGap = !hardPeerGaps.length && !emitCodeGap && stagePeerGaps.length > 0
  const emitPeerGaps = hardPeerGaps.length ? hardPeerGaps : emitStagePeerGap ? stagePeerGaps : []
  const peerSignature = emitPeerGaps.length ? peerDriftSignature(emitPeerGaps) : null
  const compactPeerGap =
    emitPeerGaps.length > 0 &&
    Boolean(state.peerDriftNotice?.active) &&
    state.peerDriftNotice.signature === peerSignature
  const compactCodeGap = emitCodeGap && Boolean(state.codeDriftNotice?.active)
  if (emitPeerGaps.length) {
    markPeerDriftNoticeEmitted(state, emitPeerGaps)
  }
  if (emitCodeGap) {
    markCodeDriftNoticeEmitted(cwd, state, codeGaps)
  }

  saveState(cwd, sessionID, state)
  refreshReport(cwd, state)

  if (emitPeerGaps.length) {
    writeDiagnosticLog(cwd, {
      event: emitPeerGaps.every((gap) => gap.stageOnly)
        ? "emit_peer_stage_reminder"
        : "emit_peer_enforcement",
      input: summarizeInput(input),
      file: rel(cwd, abs),
      tool,
      isEdit,
      ...summarizeGaps(cwd, peerGaps, codeGaps),
    })
    emitEnforcement(input, buildToolEnforcement(emitPeerGaps, { compact: compactPeerGap }))
  } else if (emitCodeGap) {
    writeDiagnosticLog(cwd, {
      event: compactCodeGap ? "emit_code_reminder_compact" : "emit_code_enforcement",
      input: summarizeInput(input),
      file: rel(cwd, abs),
      tool,
      isEdit,
      ...summarizeGaps(cwd, peerGaps, codeGaps),
    })
    emitEnforcement(input, buildCodeEnforcement(cwd, codeGaps, { compact: compactCodeGap }))
  } else if (SHOW_WARNINGS && warnings.length) {
    writeDiagnosticLog(cwd, {
      event: "emit_warning",
      input: summarizeInput(input),
      file: rel(cwd, abs),
      tool,
      warnings,
      ...summarizeGaps(cwd, peerGaps, codeGaps),
    })
    emitEnforcement(input, warnings.join("\n"))
  } else {
    writeDiagnosticLog(cwd, {
      event: codeReviewNoEditConfirmed
        ? "posttooluse_code_review_no_edit_confirmed"
        : suppressCodeGap
          ? "posttooluse_code_review_reminder_suppressed"
          : "posttooluse_no_output",
      input: summarizeInput(input),
      file: rel(cwd, abs),
      tool,
      isEdit,
      ...(suppressCodeGap
        ? {
            codeReviewToolReminderCount: codeDriftNoticeEmissionCount(state),
            codeReviewToolMaxReminders: codeReviewToolMaxReminders(),
          }
        : {}),
      ...summarizeGaps(cwd, peerGaps, codeGaps),
    })
  }
  } finally {
    releaseFileLock(stateLock)
  }
}

if (require.main === module) {
  main().catch((err) => {
    writeDiagnosticLog(process.cwd(), {
      event: "hook_exception",
      error: limitString(err?.stack || err, 2000),
    })
    if (DEBUG) process.stderr.write(`[sdd-drift-check] ${err?.stack || err}\n`)
    process.exit(0)
  })
} else {
  module.exports = {
    buildToolEnforcement,
    buildClaudeCodeOutput,
    buildCodeEnforcement,
    buildPendingEnforcement,
    buildStopEnforcement,
    buildStopOutput,
    clearCodeDriftNoticeIfResolved,
    cleanupDiagnosticLogs,
    collectCodeGaps,
    collectPeerGaps,
    collectReportLines,
    codeReviewSignature,
    diagnosticLogPath,
    drift,
    emptyState,
    findSdd,
    getChangeDoc,
    hasEditedSddChange,
    hasSddWorkspace,
    hydrateStateFromTranscript,
    isCodeDriftNoticeSuppressed,
    isDtsContextActive,
    isDtsContextText,
    isOpenCodeHookInput,
    loadState,
    normalizeKey,
    parseHookInput,
    applyToolRecord,
    acquireFileLock,
    getToolEventKey,
    markToolEvent,
    recordFile,
    resolveTranscriptPath,
    refreshReport,
    releaseFileLock,
    saveState,
    writeDiagnosticLog,
    updateDtsContextFromInput,
    shouldEmitCodeDriftNotice,
    markCodeDriftNoticeEmitted,
    markCodeReviewNoEditConfirmation,
    markStopCodeReviewConfirmation,
    updateRequirementsForEdit,
  }
}
