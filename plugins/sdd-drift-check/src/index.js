const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { Actions, runActions } = require("./actions")
const { Attribution } = require("./attribution")
const { HookHandlers, createHookHandlers } = require("./dispatcher")
const { handlePreCompact } = require("./handlers/pre-compact")
const { handlePostToolUse } = require("./handlers/post-tool-use")
const { handlePreToolUse } = require("./handlers/pre-tool-use")
const { handleStop } = require("./handlers/stop")
const { handleUserPromptSubmit } = require("./handlers/user-prompt-submit")
const { readStdin } = require("./stdin")

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)$/i
const SHOW_WARNINGS = process.env.SDD_DRIFT_SHOW_WARNINGS === "1"
const STRICT_BLOCK = process.env.SDD_DRIFT_STRICT === "1"
const DEBUG = process.env.SDD_DRIFT_DEBUG === "1"
const OUTPUT_MODE = String(process.env.SDD_DRIFT_OUTPUT || "").toLowerCase()
const OPENCODE_STOP_MODE = String(process.env.SDD_DRIFT_OPENCODE_STOP_MODE || "").toLowerCase()
const OPENCODE_STOP_REPORT_ONLY =
  OPENCODE_STOP_MODE === "report-only" ||
  OPENCODE_STOP_MODE === "off" ||
  process.env.SDD_DRIFT_OPENCODE_STOP_INJECT === "0"
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
const CHECKPOINT_OUTPUT_TEXT_MAX_BYTES = 64 * 1024
const CHECKPOINT_MTIME_SCAN = process.env.SDD_DRIFT_CHECKPOINT_MTIME_SCAN !== "0"
const CHECKPOINT_MTIME_WINDOW_MS = Number.parseInt(
  process.env.SDD_DRIFT_CHECKPOINT_MTIME_WINDOW_MS || String(10 * 60 * 1000),
  10
)
const CHECKPOINT_MTIME_SCAN_MAX_FILES = Number.parseInt(
  process.env.SDD_DRIFT_CHECKPOINT_MTIME_SCAN_MAX_FILES || "50",
  10
)
const CHECKPOINT_MTIME_SCAN_MAX_VISITS = Number.parseInt(
  process.env.SDD_DRIFT_CHECKPOINT_MTIME_SCAN_MAX_VISITS || "2000",
  10
)
const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000
const STATE_LOCK_STALE_MS = 30 * 1000
const STATE_LOCK_WAIT_MS = 5 * 1000
const STATE_LOCK_RETRY_MS = 20
const STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_FILES_MAX = Number.parseInt(process.env.SDD_DRIFT_SESSION_FILES_MAX || "1000", 10)
const STDIN_TIMEOUT_MS = Number.parseInt(process.env.SDD_DRIFT_STDIN_TIMEOUT_MS || "5000", 10)
const PROJECT_LOCK_WAIT_MS = 2 * 1000
const PROJECT_LINKED_CODE_CAP = Number.parseInt(
  process.env.SDD_DRIFT_PROJECT_LINKED_CODE_CAP || "200",
  10
)
const CIRCUIT_MAX_FAILURES = Number.parseInt(
  process.env.SDD_DRIFT_CIRCUIT_MAX_FAILURES || "5",
  10
)
const CIRCUIT_COOLDOWN_MS = Number.parseInt(
  process.env.SDD_DRIFT_CIRCUIT_COOLDOWN_MS || String(60 * 1000),
  10
)
const ACTIVE_CHANGE_DIR_TTL_MS = Number.parseInt(
  process.env.SDD_DRIFT_ACTIVE_TTL_MS || String(7 * 24 * 60 * 60 * 1000),
  10
)
const STATE_DIR = ".sdd-drift-hook-state"
const PEER_FILES = ["design.md", "tasks.md"]
const PROPOSAL_FILE = "proposal.md"
const DESIGN_FILE = "design.md"
const TASKS_FILE = "tasks.md"
const REVIEW_FILES = [DESIGN_FILE, TASKS_FILE]
const ARCHIVED_CHANGE_DIR_NAMES = new Set(["archive", "archives", "archived", ".archive", ".archived", "已归档"])
const ARCHIVE_MARKER_FILES = [".archived", ".archive", "ARCHIVED", "archived.md", "archive.md", "已归档.md"]
const ARCHIVE_STATUS_FILES = ["status.md", "state.md", "metadata.md", ".status"]
const SUBAGENT_CHECKPOINT_TOOLS = new Set([
  "background_output",
  "call_omo_agent",
  "delegate_task",
  "task",
])
const QUESTION_CHECKPOINT_TOOLS = new Set([
  "ask_user",
  "ask_user_question",
  "askuser",
  "askuserquestion",
  "confirm",
  "confirmation",
  "question",
])
const CHECKPOINT_OUTPUT_KEYS = [
  "tool_output",
  "tool_result",
  "tool_response",
  "result",
  "output",
  "response",
]
const CHECKPOINT_EDIT_LINE_RE =
  /\b(changed|modified|edited|updated|created|wrote|written|implemented|generated|patched|touched|saved|added|deleted|removed|renamed|refactored)\b|已修改|已更新|已创建|已写入|已实现|已生成|写入|修改|更新|创建|实现|变更/i
const CHECKPOINT_EDIT_HEADER_RE =
  /\b(files?\s+(changed|modified|edited|updated|created|written)|changed\s+files?|modified\s+files?|updated\s+files?|created\s+files?|implementation\s+changes?)\b|变更文件|修改文件|更新文件|创建文件|已修改文件|已更新文件/i
const CHECKPOINT_COMPLETION_RE =
  /\b(implemented|fixed|updated|created|modified|changed|wrote|patched|refactored|built|generated|saved|completed implementation|implementation complete|feature complete)\b|已完成|完成实现|实现完成|已实现|已修复|已更新|已修改|已创建|已写入|完成修改|修复完成|更新完成|修改完成/i
const CHECKPOINT_PATH_RE =
  /(?:[A-Za-z]:)?(?:[A-Za-z0-9_. -]+[\\/])*(?:[A-Za-z0-9_. -]+\.(?:ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)|(?:proposal|design|tasks)\.md)/gi
const CHECKPOINT_PATH_IGNORE_RE =
  /^(?:node_modules|\.git|\.opencode|\.claude|\.sdd-drift-hook-state|\.real-workspaces)(?:\/|$)/
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
  "Do not remove unrelated existing paragraphs, checklist items, examples, requirements, or notes while synchronizing drift.",
  "For existing SDD documents, prefer Edit or MultiEdit. If Write is necessary, copy the original file content first and write the full document including all existing headings, template text, paragraphs, and checklist items.",
  "Do not edit design.md and tasks.md in the same parallel tool batch; update one SDD document, wait for its tool result and hook feedback, then update the required peer.",
  "Find the most appropriate existing heading, paragraph, list item, or task item, and make the smallest needed update there.",
  "For tasks.md, preserve the task-list format and update the relevant existing checklist item when possible.",
]
const ACTIVE_SDD_ALIGNMENT_RULES = [
  "Active SDD documents are live planning records until their change directory is archived; before the final answer, keep active design.md and tasks.md aligned with the implemented code.",
  "Do not treat an optimization or refactor as documentation-free if it changes behavior, API or contracts, algorithms, state or data flow, data structures, performance strategy, error handling, security boundaries, user-visible results, or implementation constraints; update design.md when any of those code facts changed.",
  "Do not satisfy SDD alignment by only adding a marker, completion note, or generic summary; replace the specific stale sentence, paragraph, or checklist item so the document states the actual implemented behavior, API, error handling, performance strategy, or task status.",
  "When a changed code file adds or changes exported names, public function signatures, literal return values, config defaults, user-visible strings, or acceptance-relevant constants, carry those concrete facts into the appropriate existing design.md/tasks.md wording instead of summarizing them vaguely.",
  "After editing design.md, re-read the changed sentence mentally and ensure no old wording still contradicts the code you just wrote.",
  "Update tasks.md when the code completes, changes, cancels, splits, or invalidates an implementation task, checklist item, planned step, or acceptance condition.",
  "The no-document-change path is only valid for purely mechanical edits with no design or task impact, such as formatting-only changes, comment-only edits, test-only scaffolding, or dependency/config churn that does not change the active SDD plan.",
  "If you choose no SDD edit, explicitly state which active design.md/tasks.md files you reviewed and why the code change has no design or task impact.",
  "Modify only content relevant to the current code batch; do not invent future requirements or broaden the scope.",
]
const ATTRIBUTION_REVIEW_RULES = [
  "Purely mechanical changes (formatting, comment-only edits, test-scaffolding, dependency bumps, lint fixes) do not require any SDD document update. State this conclusion explicitly in your response and continue.",
  "If the code change implements behavior already described in a candidate change-dir's design.md, and that change-dir's tasks.md already reflects the implementation, no SDD action is needed.",
  "If the code change adds, changes, or removes behavior not described in any candidate change-dir's design.md, update the most relevant change-dir's design.md to state the actual implemented behavior. Update tasks.md if a tracked task item is now complete or invalidated.",
  "If the code change is genuinely unrelated to any active change-dir, acknowledge it as out-of-SDD scope in your response, or create a new sdd/changes/<id>/ directory when the work is feature-sized and warrants tracking.",
  "If multiple candidate change-dirs could apply, choose the most specific match based on design.md content and briefly document the reasoning in your response. Do not edit unrelated change-dirs.",
]
const SUBAGENT_REVIEW_RULE =
  "If the current environment supports subagents and a read-only review subagent is allowed, you may delegate SDD review to it; otherwise perform the review yourself with the read tool. The main agent remains responsible for any final edits."
const formatAttributionReviewRules = () => [
  "When deciding whether SDD documents need edits, apply these attribution review rules in order:",
  ...ATTRIBUTION_REVIEW_RULES.map((rule, index) => `${index + 1}. ${rule}`),
]
const DTS_CONTEXT_PATTERNS = [
  /\bDTS-\d+\b/,
  /\bDTS\b/,
  /dts\s*(问题单|工单|缺陷单|缺陷|bug|issue|ticket)/i,
  /(问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket).{0,30}dts/i,
  /(DTS|问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket).{0,40}(修复|修改|处理|解决|fix|resolve|repair|patch|handle|address)/i,
  /(修复|修改|处理|解决|fix|resolve|repair|patch|handle|address).{0,40}(DTS|问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket)/i,
  /dts\s*(问题单|单|工单|缺陷|bug|issue|ticket)/i,
  /(问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket).{0,30}dts/i,
]
const DTS_CONTEXT_NEGATION_PATTERNS = [
  /(不是|非|无需|不要|不属于)\s*(DTS|问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket)/i,
  /(DTS|问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket).{0,10}(不是|非|无需|不要|不属于)/i,
  /\bnot\s+(?:a\s+)?(?:DTS|issue\s+ticket|bug\s+ticket|ticket)\b/i,
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

const projectStatePath = (cwd) => path.join(stateDir(cwd), "project.json")

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
  version: 3,
  createdAt: new Date().toISOString(),
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
  subagentCheckpointNotice: null,
  codeReviewConfirmations: {},
  transcriptEvents: {},
  transcriptCursor: null,
  dtsContext: null,
  firstEventAt: null,
  projectStateSeenAt: null,
  carryOverNotice: null,
  attributionReviews: {},
  noEditSession: true,
  circuitBreaker: {},
})

const addPath = (items, item) => {
  if (!items.some((existing) => samePath(existing, item))) items.push(path.normalize(item))
}

const sessionFilesMax = () =>
  Number.isFinite(SESSION_FILES_MAX) ? Math.max(100, SESSION_FILES_MAX) : 1000

const fileRecordOrder = (record) =>
  Math.max(
    Number(record?.editedSeq || 0),
    Number(record?.touchedSeq || 0),
    Number(record?.firstEditedSeq || 0)
  )

const pruneStateFiles = (state) => {
  const maxFiles = sessionFilesMax()
  const entries = Object.entries(state.files || {})
  if (entries.length <= maxFiles) return false

  const keep = new Set(
    entries
      .sort((left, right) => fileRecordOrder(right[1]) - fileRecordOrder(left[1]))
      .slice(0, maxFiles)
      .map(([key]) => key)
  )
  state.files = Object.fromEntries(entries.filter(([key]) => keep.has(key)))
  state.touched = (state.touched || []).filter((file) => keep.has(normalizeKey(file)))
  state.edited = (state.edited || []).filter((file) => keep.has(normalizeKey(file)))
  return true
}

const normalizeState = (parsed) => {
  const state = emptyState()
  if (!parsed || typeof parsed !== "object") return state

  state.version = 3
  state.createdAt =
    typeof parsed.createdAt === "string" && parsed.createdAt
      ? parsed.createdAt
      : new Date().toISOString()
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
  state.subagentCheckpointNotice =
    parsed.subagentCheckpointNotice && typeof parsed.subagentCheckpointNotice === "object"
      ? parsed.subagentCheckpointNotice
      : null
  state.codeReviewConfirmations =
    parsed.codeReviewConfirmations && typeof parsed.codeReviewConfirmations === "object"
      ? parsed.codeReviewConfirmations
      : {}
  state.transcriptEvents =
    parsed.transcriptEvents && typeof parsed.transcriptEvents === "object"
      ? parsed.transcriptEvents
      : {}
  state.transcriptCursor =
    parsed.transcriptCursor && typeof parsed.transcriptCursor === "object"
      ? {
          path:
            typeof parsed.transcriptCursor.path === "string"
              ? path.resolve(parsed.transcriptCursor.path)
              : null,
          offset: Number.isFinite(parsed.transcriptCursor.offset)
            ? Math.max(0, Number(parsed.transcriptCursor.offset))
            : 0,
          lineIndex: Number.isFinite(parsed.transcriptCursor.lineIndex)
            ? Math.max(0, Number(parsed.transcriptCursor.lineIndex))
            : 0,
        }
      : null
  state.dtsContext =
    parsed.dtsContext && typeof parsed.dtsContext === "object" ? parsed.dtsContext : null
  state.firstEventAt =
    typeof parsed.firstEventAt === "string" && parsed.firstEventAt ? parsed.firstEventAt : null
  state.projectStateSeenAt =
    typeof parsed.projectStateSeenAt === "string" && parsed.projectStateSeenAt
      ? parsed.projectStateSeenAt
      : null
  state.carryOverNotice =
    parsed.carryOverNotice && typeof parsed.carryOverNotice === "object"
      ? parsed.carryOverNotice
      : null
  state.attributionReviews =
    parsed.attributionReviews && typeof parsed.attributionReviews === "object"
      ? parsed.attributionReviews
      : {}
  state.noEditSession =
    typeof parsed.noEditSession === "boolean" ? parsed.noEditSession : state.edited.length === 0
  state.circuitBreaker =
    parsed.circuitBreaker && typeof parsed.circuitBreaker === "object" ? parsed.circuitBreaker : {}

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

  pruneStateFiles(state)
  return state
}

const circuitMaxFailures = () =>
  Number.isFinite(CIRCUIT_MAX_FAILURES) ? Math.max(1, CIRCUIT_MAX_FAILURES) : 5

const circuitCooldownMs = () =>
  Number.isFinite(CIRCUIT_COOLDOWN_MS) ? Math.max(1, CIRCUIT_COOLDOWN_MS) : 60 * 1000

const CircuitBreaker = {
  isOpen(state, hookName, now = Date.now()) {
    const bucket = state?.circuitBreaker?.[hookName]
    return Boolean(bucket && Number(bucket.openUntilMs || 0) > now)
  },

  recordFailure(state, hookName, now = Date.now()) {
    if (!state?.circuitBreaker || !hookName) return false
    const bucket = state.circuitBreaker[hookName] || { failures: 0, openUntilMs: 0 }
    bucket.failures = Number(bucket.failures || 0) + 1
    let opened = false
    if (bucket.failures >= circuitMaxFailures()) {
      bucket.failures = 0
      bucket.openUntilMs = now + circuitCooldownMs()
      bucket.openedAt = new Date(now).toISOString()
      opened = true
    }
    state.circuitBreaker[hookName] = bucket
    return opened
  },

  recordSuccess(state, hookName) {
    const bucket = state?.circuitBreaker?.[hookName]
    if (!bucket) return false
    const changed = Number(bucket.failures || 0) !== 0 || Number(bucket.openUntilMs || 0) !== 0
    bucket.failures = 0
    bucket.openUntilMs = 0
    delete bucket.openedAt
    return changed
  },
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

const fileMtimeMs = (fp) => {
  try {
    return fs.statSync(fp).mtimeMs
  } catch {
    return 0
  }
}

const latestStateEventMs = (state) =>
  Object.values(state.files || {}).reduce(
    (latest, file) =>
      Math.max(latest, Number(file?.touchedAtMs || 0), Number(file?.editedAtMs || 0)),
    0
  )

const recordFile = (state, fp, edited) => {
  const abs = path.normalize(path.resolve(fp))
  const key = normalizeKey(abs)
  const existing = state.files[key] || {}
  const mtimeMs = fileMtimeMs(abs)
  state.clock += 1
  const eventMs = Math.max(Date.now() * 1000, latestStateEventMs(state), Math.round(mtimeMs * 1000)) + 1
  state.files[key] = {
    ...existing,
    path: abs,
    ...(mtimeMs ? { mtimeMs } : {}),
    touchedAtMs: eventMs,
    touchedSeq: state.clock,
    ...(edited ? { editedSeq: state.clock, editedAtMs: eventMs } : {}),
    ...(edited ? { firstEditedSeq: existing.firstEditedSeq || existing.editedSeq || state.clock } : {}),
  }
  addPath(state.touched, abs)
  if (edited) {
    addPath(state.edited, abs)
    state.noEditSession = false
  }
  pruneStateFiles(state)
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

const countTranscriptLines = (text) => {
  if (!text) return 0
  const newlines = (text.match(/\n/g) || []).length
  return text.endsWith("\n") ? newlines : newlines + 1
}

const readTranscriptChunk = (state, transcriptPath) => {
  const abs = path.resolve(transcriptPath)
  const stat = fs.statSync(abs)
  const sameCursor = state.transcriptCursor?.path === abs
  let offset = sameCursor ? Number(state.transcriptCursor?.offset || 0) : 0
  let lineIndex = sameCursor ? Number(state.transcriptCursor?.lineIndex || 0) : 0

  if (!Number.isFinite(offset) || offset < 0 || offset > stat.size) {
    offset = 0
    lineIndex = 0
  }

  const buffer = fs.readFileSync(abs).subarray(offset)
  if (!buffer.length) {
    state.transcriptCursor = { path: abs, offset, lineIndex }
    return { content: "", lineIndexBase: lineIndex }
  }

  let processLength = buffer.length
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline >= 0) {
    const tail = buffer.subarray(lastNewline + 1).toString("utf8").trim()
    processLength = tail && !(tail.startsWith("{") && tail.endsWith("}")) ? lastNewline + 1 : buffer.length
  } else if (offset > 0) {
    const tail = buffer.toString("utf8").trim()
    processLength = tail.startsWith("{") && tail.endsWith("}") ? buffer.length : 0
  }

  const processBuffer = buffer.subarray(0, processLength)
  const content = processBuffer.toString("utf8")
  const nextOffset = offset + processLength
  const nextLineIndex = lineIndex + countTranscriptLines(content)
  state.transcriptCursor = { path: abs, offset: nextOffset, lineIndex: nextLineIndex }
  return { content, lineIndexBase: lineIndex }
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
  let lineIndexBase = 0
  const seen = new Set()
  const pendingToolUses = new Map()
  try {
    const chunk = readTranscriptChunk(state, transcriptPath)
    content = chunk.content
    lineIndexBase = chunk.lineIndexBase
  } catch {
    return false
  }
  if (!content) return false

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

      const key = transcriptToolEventKey(finalRecord, lineIndexBase + lineIndex, recordIndex)
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

const isArchivedChangeDirName = (dir) => {
  const name = path.basename(path.normalize(dir)).toLowerCase()
  return (
    ARCHIVED_CHANGE_DIR_NAMES.has(name) ||
    /(^|[-_.])(archived|已归档)($|[-_.])/.test(name)
  )
}

const isArchiveStatusText = (text) =>
  /^\s*(status|state)\s*[:：]\s*(archived|archive|closed)\s*$/im.test(text || "") ||
  /^\s*(状态|阶段)\s*[:：]\s*(已归档|归档)\s*$/im.test(text || "")

const readSmallText = (fp) => {
  try {
    return fs.readFileSync(fp, "utf8").slice(0, 4096)
  } catch {
    return ""
  }
}

const isArchivedChangeDir = (dir) => {
  if (!dir || isArchivedChangeDirName(dir)) return true

  for (const marker of ARCHIVE_MARKER_FILES) {
    if (fs.existsSync(path.join(dir, marker))) return true
  }

  for (const statusFile of ARCHIVE_STATUS_FILES) {
    const text = readSmallText(path.join(dir, statusFile))
    if (text && isArchiveStatusText(text)) return true
  }

  return false
}

const collectPeerGaps = (cwd, state, options = {}) => {
  const includeStageOnly = options.includeStageOnly !== false
  const includeHard = options.includeHard !== false
  const gaps = []

  for (const bucket of Object.values(state.requirements || {})) {
    const dir = bucket.dir
    if (isArchivedChangeDir(dir)) continue

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

const collectActiveChangeDirs = (cwd, state) => {
  const dirs = [...(state.changeDirs || []), ...discoverChangeDirs(cwd)]
  const active = []

  for (const dir of dirs) {
    const normalized = path.normalize(dir)
    if (isArchivedChangeDir(normalized)) continue
    if (!active.some((existing) => samePath(existing, normalized))) active.push(normalized)
  }

  return active
}

const emptyProjectState = () => ({
  version: 1,
  lastUpdatedAt: new Date().toISOString(),
  changeDirs: {},
  activeChangeDir: null,
  activeUntilMs: 0,
  activeLastEditedSession: null,
})

const relDirForProject = (cwd, dir) => toPosix(path.relative(cwd, dir))

const docKeyForFile = (file) => {
  if (file === PROPOSAL_FILE) return "proposal"
  if (file === DESIGN_FILE) return "design"
  if (file === TASKS_FILE) return "tasks"
  return null
}

const docFileForKey = (key) => {
  if (key === "proposal") return PROPOSAL_FILE
  if (key === "design") return DESIGN_FILE
  if (key === "tasks") return TASKS_FILE
  return null
}

const eventMsForFileRecord = (record, edited) => {
  const value = edited ? record?.editedAtMs : record?.touchedAtMs
  if (Number.isFinite(value)) return value
  if (Number.isFinite(record?.mtimeMs)) return Math.round(record.mtimeMs * 1000)
  return Date.now() * 1000
}

const docRecordFromFs = (fp) => {
  try {
    const stat = fs.statSync(fp)
    if (!stat.isFile()) return { exists: false }
    const ms = Math.round(stat.mtimeMs * 1000)
    return {
      exists: true,
      lastEditedMs: ms,
      lastReviewedMs: ms,
    }
  } catch {
    return { exists: false }
  }
}

const createChangeDirFromFs = (cwd, dir) => {
  const normalized = path.normalize(dir)
  const changeDir = {
    relDir: relDirForProject(cwd, normalized),
    archived: isArchivedChangeDir(normalized),
    docs: {
      proposal: docRecordFromFs(path.join(normalized, PROPOSAL_FILE)),
      design: docRecordFromFs(path.join(normalized, DESIGN_FILE)),
      tasks: docRecordFromFs(path.join(normalized, TASKS_FILE)),
    },
    linkedCode: [],
    alignedAt: null,
    alignedAtMs: 0,
    state: "ALIGNED",
    conditions: {
      proposalOnly: false,
      designAheadOfTasks: false,
      tasksAheadOfDesign: false,
      codeAheadOfDocs: false,
      codePendingDocs: [],
    },
    peerSyncs: {},
  }
  changeDir.conditions = computeProjectConditions(changeDir)
  changeDir.state = computeProjectState(changeDir.conditions, changeDir.archived)
  return changeDir
}

const normalizeProjectDoc = (doc) => ({
  exists: Boolean(doc?.exists),
  ...(Number.isFinite(doc?.lastEditedMs) ? { lastEditedMs: Number(doc.lastEditedMs) } : {}),
  ...(Number.isFinite(doc?.lastReviewedMs) ? { lastReviewedMs: Number(doc.lastReviewedMs) } : {}),
  ...(typeof doc?.lastEditedSession === "string" ? { lastEditedSession: doc.lastEditedSession } : {}),
  ...(typeof doc?.lastReviewedSession === "string" ? { lastReviewedSession: doc.lastReviewedSession } : {}),
})

const normalizeProjectChangeDir = (cwd, relDirValue, value) => {
  const relDir = toPosix(value?.relDir || relDirValue || "")
  const absDir = path.join(cwd, relDir)
  const fromFs = createChangeDirFromFs(cwd, absDir)
  const changeDir = {
    ...fromFs,
    ...value,
    relDir,
    archived: Boolean(value?.archived) || isArchivedChangeDir(absDir),
    docs: {
      proposal: normalizeProjectDoc(value?.docs?.proposal || fromFs.docs.proposal),
      design: normalizeProjectDoc(value?.docs?.design || fromFs.docs.design),
      tasks: normalizeProjectDoc(value?.docs?.tasks || fromFs.docs.tasks),
    },
    linkedCode: Array.isArray(value?.linkedCode)
      ? value.linkedCode
          .filter((item) => item?.path && Number.isFinite(item?.lastEditedMs))
          .map((item) => ({
            path: toPosix(item.path),
            lastEditedMs: Number(item.lastEditedMs),
            ...(typeof item.lastEditedSession === "string"
              ? { lastEditedSession: item.lastEditedSession }
              : {}),
            linkedAt: Number.isFinite(item.linkedAt) ? Number(item.linkedAt) : Number(item.lastEditedMs),
          }))
      : [],
    alignedAt: typeof value?.alignedAt === "string" ? value.alignedAt : null,
    alignedAtMs: Number.isFinite(value?.alignedAtMs) ? Number(value.alignedAtMs) : 0,
    peerSyncs: value?.peerSyncs && typeof value.peerSyncs === "object" ? value.peerSyncs : {},
  }
  changeDir.conditions = computeProjectConditions(changeDir)
  changeDir.state = computeProjectState(changeDir.conditions, changeDir.archived)
  return changeDir
}

const computeProjectConditions = (dir) => {
  const design = dir.docs?.design || {}
  const tasks = dir.docs?.tasks || {}
  const proposal = dir.docs?.proposal || {}
  const designExists = design.exists === true
  const tasksExists = tasks.exists === true
  const designEditedKnown = typeof design.lastEditedSession === "string"
  const tasksEditedKnown = typeof tasks.lastEditedSession === "string"
  const designEdited = Number(design.lastEditedMs || 0)
  const tasksEdited = Number(tasks.lastEditedMs || 0)
  const designReviewed = Math.max(designEdited, Number(design.lastReviewedMs || 0))
  const tasksReviewed = Math.max(tasksEdited, Number(tasks.lastReviewedMs || 0))
  const latestCodeMs = Math.max(0, ...(dir.linkedCode || []).map((item) => Number(item.lastEditedMs || 0)))
  const tasksSyncedFromDesign =
    dir.peerSyncs?.tasks?.sourceFile === DESIGN_FILE &&
    Number(dir.peerSyncs.tasks.sourceEditedMs || 0) >= designEdited &&
    Number(dir.peerSyncs.tasks.targetEditedMs || 0) >= Number(dir.peerSyncs.tasks.sourceEditedMs || 0)
  const designSyncedFromTasks =
    dir.peerSyncs?.design?.sourceFile === TASKS_FILE &&
    Number(dir.peerSyncs.design.sourceEditedMs || 0) >= tasksEdited &&
    Number(dir.peerSyncs.design.targetEditedMs || 0) >= Number(dir.peerSyncs.design.sourceEditedMs || 0)
  const reviewTargets = [
    designExists ? [DESIGN_FILE, designReviewed] : null,
    tasksExists ? [TASKS_FILE, tasksReviewed] : null,
  ].filter(Boolean)
  const codePendingDocs = reviewTargets
    .filter(([, reviewedAt]) => latestCodeMs > reviewedAt)
    .map(([file]) => file)

  return {
    proposalOnly: proposal.exists === true && !designExists && !tasksExists,
    designAheadOfTasks:
      designExists && tasksExists && designEditedKnown && designEdited > tasksEdited && designEdited > 0 && !designSyncedFromTasks,
    tasksAheadOfDesign:
      designExists && tasksExists && tasksEditedKnown && tasksEdited > designEdited && tasksEdited > 0 && !tasksSyncedFromDesign,
    codeAheadOfDocs: latestCodeMs > Number(dir.alignedAtMs || 0) && codePendingDocs.length > 0,
    codePendingDocs,
  }
}

const computeProjectState = (conditions, archived) => {
  if (archived) return "ARCHIVED"
  if (conditions.proposalOnly) return "PROPOSAL_STAGE"
  const flags = [
    conditions.designAheadOfTasks,
    conditions.tasksAheadOfDesign,
    conditions.codeAheadOfDocs,
  ].filter(Boolean)
  if (flags.length === 0) return "ALIGNED"
  if (flags.length > 1) return "MULTI_DRIFT"
  if (conditions.designAheadOfTasks) return "DESIGN_PENDING_TASKS"
  if (conditions.tasksAheadOfDesign) return "TASKS_PENDING_DESIGN"
  return "CODE_PENDING_REVIEW"
}

const recomputeProjectState = (project, cwd) => {
  for (const [relDirValue, dir] of Object.entries(project.changeDirs || {})) {
    const absDir = path.join(cwd, dir.relDir || relDirValue)
    dir.archived = Boolean(dir.archived) || isArchivedChangeDir(absDir)
    for (const key of ["proposal", "design", "tasks"]) {
      const file = docFileForKey(key)
      const fp = path.join(absDir, file)
      const fsDoc = docRecordFromFs(fp)
      dir.docs[key] = {
        ...(dir.docs?.[key] || {}),
        exists: fsDoc.exists,
        ...(fsDoc.exists && !Number.isFinite(dir.docs?.[key]?.lastEditedMs)
          ? { lastEditedMs: fsDoc.lastEditedMs }
          : {}),
        ...(fsDoc.exists && !Number.isFinite(dir.docs?.[key]?.lastReviewedMs)
          ? { lastReviewedMs: fsDoc.lastReviewedMs }
          : {}),
      }
    }
    dir.conditions = computeProjectConditions(dir)
    dir.state = computeProjectState(dir.conditions, dir.archived)
  }
  project.lastUpdatedAt = new Date().toISOString()
  return project
}

const ensureProjectChangeDirs = (cwd, project) => {
  for (const dir of discoverChangeDirs(cwd)) {
    const relDirValue = relDirForProject(cwd, dir)
    if (!project.changeDirs[relDirValue]) {
      project.changeDirs[relDirValue] = createChangeDirFromFs(cwd, dir)
    }
  }
  return recomputeProjectState(project, cwd)
}

const normalizeProjectState = (cwd, parsed) => {
  const project = emptyProjectState()
  if (parsed && typeof parsed === "object") {
    project.version = 1
    project.lastUpdatedAt =
      typeof parsed.lastUpdatedAt === "string" && parsed.lastUpdatedAt
        ? parsed.lastUpdatedAt
        : project.lastUpdatedAt
    project.activeChangeDir =
      typeof parsed.activeChangeDir === "string" ? toPosix(parsed.activeChangeDir) : null
    project.activeUntilMs = Number.isFinite(parsed.activeUntilMs) ? Number(parsed.activeUntilMs) : 0
    project.activeLastEditedSession =
      typeof parsed.activeLastEditedSession === "string" ? parsed.activeLastEditedSession : null
    project.changeDirs = {}
    for (const [relDirValue, value] of Object.entries(parsed.changeDirs || {})) {
      project.changeDirs[toPosix(relDirValue)] = normalizeProjectChangeDir(cwd, relDirValue, value)
    }
  }
  return ensureProjectChangeDirs(cwd, project)
}

const quarantineCorruptStateFile = (fp) => {
  try {
    if (!fs.existsSync(fp)) return
    fs.renameSync(fp, `${fp}.corrupt-${Date.now()}`)
  } catch {}
}

const loadProjectState = (cwd) => {
  const fp = projectStatePath(cwd)
  try {
    return normalizeProjectState(cwd, JSON.parse(fs.readFileSync(fp, "utf8")))
  } catch (err) {
    if (err?.code !== "ENOENT") quarantineCorruptStateFile(fp)
    return normalizeProjectState(cwd, emptyProjectState())
  }
}

const saveProjectState = (cwd, project) => {
  recomputeProjectState(project, cwd)
  writeTextAtomic(projectStatePath(cwd), JSON.stringify(project, null, 2))
}

const attributionReviewSignature = (cwd, codeFiles, candidates) =>
  hash(
    JSON.stringify({
      type: "attribution-review",
      codeFiles: (codeFiles || []).map((file) => rel(cwd, file)).sort(),
      candidates: (candidates || []).map((dir) => dir.relDir).sort(),
    })
  )

const buildAttributionReviewPrompt = (cwd, { codeFiles = [], candidates = [] } = {}) => {
  const codeLines = codeFiles.length
    ? codeFiles.map((file) => `  - ${rel(cwd, file)}`)
    : ["  - unknown code file"]
  const candidateLines = candidates.length
    ? candidates.map((dir) => {
        const docs = dir.docs || {}
        const docState = [
          docs.design?.exists ? "design.md" : null,
          docs.tasks?.exists ? "tasks.md" : null,
        ]
          .filter(Boolean)
          .join(", ")
        const suffix = docState ? `; docs: ${docState}` : ""
        return `  - ${dir.relDir}${dir.state ? ` (${dir.state}${suffix})` : suffix}`
      })
    : ["  - no active SDD change-dir candidates"]

  return [
    "SDD attribution review needed.",
    "",
    "Recent code changes:",
    ...codeLines,
    "",
    "Candidate active SDD change directories:",
    ...candidateLines,
    "",
    ...formatAttributionReviewRules(),
    "",
    "Read the relevant candidate design.md/tasks.md files, decide which change-dir owns the code change, then do exactly one of these:",
    "- edit the matching SDD document(s) if they are stale;",
    "- leave documents unchanged if the reviewed docs are already aligned;",
    "- create a new sdd/changes/<id>/ directory only if this work is feature-sized and not covered by any candidate;",
    "- state that the code change is unrelated to active SDD scope if none applies.",
    "Preserve existing SDD templates and headings when editing.",
  ].join("\n")
}

const markAttributionReviewEmitted = (cwd, state, codeFiles, candidates) => {
  if (!state || !Array.isArray(candidates) || candidates.length === 0) return null
  state.attributionReviews =
    state.attributionReviews && typeof state.attributionReviews === "object"
      ? state.attributionReviews
      : {}
  const signature = attributionReviewSignature(cwd, codeFiles, candidates)
  if (state.attributionReviews[signature]?.emittedAt) return null

  const prompt = buildAttributionReviewPrompt(cwd, { codeFiles, candidates })
  state.attributionReviews[signature] = {
    signature,
    emittedAt: new Date().toISOString(),
    codeFiles: (codeFiles || []).map((file) => rel(cwd, file)).sort(),
    candidates: candidates.map((dir) => dir.relDir).sort(),
  }
  state.attributionReviewPrompts = [
    ...(state.attributionReviewPrompts || []),
    { signature, prompt },
  ]
  return { signature, prompt }
}

const takeAttributionReviewPrompts = (state) => {
  const prompts = Array.isArray(state?.attributionReviewPrompts)
    ? state.attributionReviewPrompts
    : []
  if (state) delete state.attributionReviewPrompts
  return prompts
}

const pendingAttributionReviews = (state) =>
  Object.values(state?.attributionReviews || {}).filter((review) => !review.resolution)

const candidateHasDir = (review, relDirValue) =>
  (review.candidates || []).some((candidate) => toPosix(candidate) === toPosix(relDirValue))

const resolveAttributionReviewsForDoc = (cwd, project, state, sessionID, doc, record) => {
  const reviews = pendingAttributionReviews(state)
  if (!reviews.length || !doc?.dir) return false
  const relDirValue = relDirForProject(cwd, doc.dir)
  const edited = Number(record?.editedSeq || 0) > 0
  const nowIso = new Date().toISOString()
  let changed = false

  for (const review of reviews) {
    const isCandidate = candidateHasDir(review, relDirValue)
    const isNewChangeDir = !isCandidate && project?.changeDirs?.[relDirValue]
    if (!isCandidate && !isNewChangeDir) continue

    if (edited) {
      review.resolution = isCandidate ? "edit" : "new-change-dir"
      review.resolvedToDir = relDirValue
      review.resolvedAt = nowIso
      if (project) {
        project.activeChangeDir = relDirValue
        project.activeUntilMs = Date.now() + ACTIVE_CHANGE_DIR_TTL_MS
        project.activeLastEditedSession = sessionID
      }
      changed = true
    } else if (!review.partialResolution) {
      review.partialResolution = "read-only"
      review.partialResolvedToDir = relDirValue
      review.partialResolvedAt = nowIso
      changed = true
    }
  }
  return changed
}

const resolveReadOnlyAttributionReviews = (state) => {
  const nowIso = new Date().toISOString()
  let changed = false
  for (const review of pendingAttributionReviews(state)) {
    if (review.partialResolution !== "read-only") continue
    review.resolution = "no-edit-confirmed"
    review.resolvedAt = nowIso
    review.resolvedToDir = review.partialResolvedToDir
    changed = true
  }
  return changed
}

const acceptUnresolvedAttributionReviews = (state) => {
  const nowIso = new Date().toISOString()
  let changed = false
  for (const review of pendingAttributionReviews(state)) {
    review.resolution = "unrelated"
    review.resolvedAt = nowIso
    changed = true
  }
  return changed
}

const updateProjectDocFromRecord = (cwd, project, state, sessionID, doc, record) => {
  const relDirValue = relDirForProject(cwd, doc.dir)
  const dir = project.changeDirs[relDirValue] || createChangeDirFromFs(cwd, doc.dir)
  const key = docKeyForFile(doc.file)
  if (!key) return

  const edited = Number(record.editedSeq || 0) > 0
  const eventMs = eventMsForFileRecord(record, edited)
  const target = {
    ...(dir.docs[key] || {}),
    exists: true,
  }
  if (edited) {
    if (target.lastEditedSession && eventMs <= Number(target.lastEditedMs || 0)) {
      dir.docs[key] = target
      project.changeDirs[relDirValue] = dir
      return
    }
    const previousConditions = computeProjectConditions(dir)
    target.lastEditedMs = Math.max(Number(target.lastEditedMs || 0), eventMs)
    target.lastEditedSession = sessionID
    target.lastReviewedMs = Math.max(Number(target.lastReviewedMs || 0), target.lastEditedMs)
    target.lastReviewedSession = sessionID
    const designEdited = Number(dir.docs.design?.lastEditedMs || 0)
    const tasksEdited = Number(dir.docs.tasks?.lastEditedMs || 0)
    const designEditedInSession =
      key === "tasks" &&
      editedSeq(state, path.join(doc.dir, DESIGN_FILE)) > 0 &&
      editedSeq(state, path.join(doc.dir, DESIGN_FILE)) < Number(record.editedSeq || 0)
    const tasksEditedInSession =
      key === "design" &&
      editedSeq(state, path.join(doc.dir, TASKS_FILE)) > 0 &&
      editedSeq(state, path.join(doc.dir, TASKS_FILE)) < Number(record.editedSeq || 0)
    const sessionPeerSync = getPeerSyncBucket(state, doc.dir, false)?.files?.[doc.file]
    const sessionSyncedFromDesign =
      key === "tasks" && sessionPeerSync?.sourceFile === DESIGN_FILE
    const sessionSyncedFromTasks =
      key === "design" && sessionPeerSync?.sourceFile === TASKS_FILE
    const tasksWasSyncedFromPriorDesign =
      key === "design" && dir.peerSyncs?.tasks?.sourceFile === DESIGN_FILE
    const designWasSyncedFromPriorTasks =
      key === "tasks" && dir.peerSyncs?.design?.sourceFile === TASKS_FILE
    if (designWasSyncedFromPriorTasks) delete dir.peerSyncs.design
    if (tasksWasSyncedFromPriorDesign) delete dir.peerSyncs.tasks

    if (
      key === "tasks" &&
      (sessionSyncedFromDesign || previousConditions.designAheadOfTasks || designEditedInSession) &&
      !(!sessionSyncedFromDesign && designWasSyncedFromPriorTasks)
    ) {
      dir.peerSyncs.tasks = {
        sourceFile: DESIGN_FILE,
        sourceEditedMs: designEdited,
        targetEditedMs: target.lastEditedMs,
      }
    } else if (
      key === "design" &&
      (sessionSyncedFromTasks || previousConditions.tasksAheadOfDesign || tasksEditedInSession) &&
      !(!sessionSyncedFromTasks && tasksWasSyncedFromPriorDesign)
    ) {
      dir.peerSyncs.design = {
        sourceFile: TASKS_FILE,
        sourceEditedMs: tasksEdited,
        targetEditedMs: target.lastEditedMs,
      }
    } else {
      if (key === "tasks") delete dir.peerSyncs.design
      if (key === "design") delete dir.peerSyncs.tasks
    }
    project.activeChangeDir = relDirValue
    project.activeUntilMs = Date.now() + ACTIVE_CHANGE_DIR_TTL_MS
    project.activeLastEditedSession = sessionID
  } else {
    if (target.lastReviewedSession && eventMs <= Number(target.lastReviewedMs || 0)) {
      dir.docs[key] = target
      project.changeDirs[relDirValue] = dir
      return
    }
    target.lastReviewedMs = Math.max(Number(target.lastReviewedMs || 0), eventMs)
    target.lastReviewedSession = sessionID
  }
  dir.docs[key] = target
  project.changeDirs[relDirValue] = dir
  resolveAttributionReviewsForDoc(cwd, project, state, sessionID, doc, record)
}

const getChangeDirForPath = (fp) => {
  const root = findSdd(fp)
  if (!root) return null
  const relPath = toPosix(path.relative(root, fp))
  const match = relPath.match(/^changes\/([^/]+)(?:\/|$)/)
  if (!match) return null
  return {
    root,
    id: match[1],
    dir: path.join(root, "changes", match[1]),
    rel: relPath,
  }
}

const recordProjectArchiveAction = (cwd, project, fp) => {
  const changeDir = getChangeDirForPath(fp)
  if (!changeDir) return false
  const relDirValue = relDirForProject(cwd, changeDir.dir)
  const dir = project.changeDirs[relDirValue] || createChangeDirFromFs(cwd, changeDir.dir)
  if (!isArchivedChangeDir(changeDir.dir)) return false
  dir.archived = true
  dir.conditions = computeProjectConditions(dir)
  dir.state = "ARCHIVED"
  project.changeDirs[relDirValue] = dir
  if (project.activeChangeDir === relDirValue) {
    project.activeChangeDir = null
    project.activeUntilMs = 0
  }
  return true
}

const collectProjectAttributionTargets = (cwd, project, state, codeFile) => {
  const decision = Attribution.decide({ cwd, session: state, project, codeFile })
  if (decision?.kind === "needs-review") {
    markAttributionReviewEmitted(cwd, state, [codeFile], decision.candidates)
    return []
  }
  return Attribution.targetsForDecision(decision)
}

const appendProjectLinkedCode = (dir, cwd, record, sessionID) => {
  const relPath = rel(cwd, record.path)
  const lastEditedMs = eventMsForFileRecord(record, true)
  const existing = (dir.linkedCode || []).find((item) => samePath(path.join(cwd, item.path), record.path))
  if (existing) {
    existing.lastEditedMs = Math.max(Number(existing.lastEditedMs || 0), lastEditedMs)
    existing.lastEditedSession = sessionID
    return
  }
  dir.linkedCode = [
    ...(dir.linkedCode || []),
    {
      path: relPath,
      lastEditedMs,
      lastEditedSession: sessionID,
      linkedAt: lastEditedMs,
    },
  ]
    .sort((left, right) => Number(right.lastEditedMs || 0) - Number(left.lastEditedMs || 0))
    .slice(0, Math.max(1, PROJECT_LINKED_CODE_CAP || 200))
}

const applySessionToProject = (cwd, project, state, sessionID) => {
  ensureProjectChangeDirs(cwd, project)
  if (isDtsContextActive(state)) return recomputeProjectState(project, cwd)

  for (const record of Object.values(state.files || {})) {
    const fp = record?.path
    if (!fp) continue
    const doc = getChangeDoc(fp)
    if (doc?.dir && doc.file) {
      updateProjectDocFromRecord(cwd, project, state, sessionID, doc, record)
      continue
    }
    if (record.editedSeq && isCodePath(fp)) {
      const targets = collectProjectAttributionTargets(cwd, project, state, fp)
      for (const dir of targets) appendProjectLinkedCode(dir, cwd, record, sessionID)
      if (targets.length === 1) {
        project.activeChangeDir = targets[0].relDir
        project.activeUntilMs = Date.now() + ACTIVE_CHANGE_DIR_TTL_MS
        project.activeLastEditedSession = sessionID
      }
    }
  }

  for (const fp of state.edited || []) recordProjectArchiveAction(cwd, project, fp)
  return recomputeProjectState(project, cwd)
}

const collectProjectPeerGaps = (cwd, project, options = {}) => {
  const includeStageOnly = options.includeStageOnly !== false
  const includeHard = options.includeHard !== false
  const gaps = []
  for (const dir of Object.values(project?.changeDirs || {})) {
    if (dir.archived) continue
    const absDir = path.join(cwd, dir.relDir)
    const conditions = computeProjectConditions(dir)
    const required = []
    const sourceFiles = []
    if (conditions.proposalOnly && includeStageOnly) {
      continue
    }
    if (conditions.designAheadOfTasks && includeHard) {
      required.push(TASKS_FILE)
      sourceFiles.push(DESIGN_FILE)
    }
    if (conditions.tasksAheadOfDesign && includeHard) {
      required.push(DESIGN_FILE)
      sourceFiles.push(TASKS_FILE)
    }
    if (!required.length) continue
    gaps.push({
      relDir: dir.relDir,
      edited: [PROPOSAL_FILE, DESIGN_FILE, TASKS_FILE].filter((file) => {
        const key = docKeyForFile(file)
        return Number(dir.docs?.[key]?.lastEditedMs || 0) > 0
      }),
      sourceFiles,
      stageOnly: false,
      absent: required.filter((file) => !fs.existsSync(path.join(absDir, file))),
      missing: required.filter((file) => !fs.existsSync(path.join(absDir, file))),
      unsynced: required.filter((file) => fs.existsSync(path.join(absDir, file))),
      stale: [],
      required,
      projectLevel: true,
    })
  }
  return gaps
}

const collectProjectCodeGaps = (cwd, project) => {
  if (!project || !hasSddWorkspace(cwd)) return []
  const gaps = []
  for (const dir of Object.values(project.changeDirs || {})) {
    if (dir.archived) continue
    const conditions = computeProjectConditions(dir)
    if (!conditions.codeAheadOfDocs) continue
    const codeFiles = (dir.linkedCode || []).map((item) => path.join(cwd, item.path))
    const latestCodeMs = Math.max(0, ...(dir.linkedCode || []).map((item) => Number(item.lastEditedMs || 0)))
    const reviewTargets = conditions.codePendingDocs.map((file) => path.join(cwd, dir.relDir, file))
    if (!reviewTargets.length || !codeFiles.length) continue
    gaps.push({
      codeFiles,
      latestCodeSeq: latestCodeMs,
      latestCodeMs,
      reviewTargets,
      pendingReviewTargets: reviewTargets,
      reviewReady: false,
      needsConfirmation: false,
      projectLevel: true,
      relDir: dir.relDir,
      reviewSignature: hash(
        JSON.stringify({
          type: "project-code",
          relDir: dir.relDir,
          latestCodeMs,
          reviewTargets: reviewTargets.map((file) => rel(cwd, file)).sort(),
        })
      ),
    })
  }
  return gaps
}

const collectCombinedPeerGaps = (cwd, state, project, options = {}) => {
  const combined = [
    ...collectPeerGaps(cwd, state, options),
    ...collectProjectPeerGaps(cwd, project, options),
  ]
  const seen = new Set()
  return combined.filter((gap) => {
    const key = `${gap.relDir}:${gap.required.sort().join(",")}:${gap.sourceFiles.sort().join(",")}:${gap.stageOnly}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const collectCombinedCodeGaps = (cwd, state, project) => {
  const sessionGaps = collectCodeGaps(cwd, state)
  const rawProjectGaps = collectProjectCodeGaps(cwd, project)
  const projectGaps = rawProjectGaps.filter(
    (gap) =>
      !state.codeReviewConfirmations?.[gap.reviewSignature]?.implementationFlow &&
      !isCodeReviewConfirmed(state, gap.reviewSignature)
  )
  const codeFilesKey = (gap) => (gap.codeFiles || []).map((file) => rel(cwd, file)).sort().join("\0")
  const projectCodeKeys = new Set(rawProjectGaps.map(codeFilesKey))
  const projectLinkedCode = new Set(
    Object.values(project?.changeDirs || {}).flatMap((dir) =>
      (dir.linkedCode || []).map((item) => toPosix(item.path))
    )
  )
  const allCodeFilesTrackedByProject = (gap) =>
    (gap.codeFiles || []).every((file) => projectLinkedCode.has(rel(cwd, file)))
  const combined = [
    ...sessionGaps.filter(
      (gap) => !projectCodeKeys.has(codeFilesKey(gap)) && !allCodeFilesTrackedByProject(gap)
    ),
    ...projectGaps,
  ]
  const seen = new Set()
  return combined.filter((gap) => {
    const key = JSON.stringify({
      codeFiles: (gap.codeFiles || []).map((file) => rel(cwd, file)).sort(),
      reviewTargets: (gap.reviewTargets || []).map((file) => rel(cwd, file)).sort(),
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const collectCarryOverDrift = (project) =>
  Object.values(project?.changeDirs || {})
    .filter((dir) => !dir.archived)
    .filter((dir) => dir.state !== "ALIGNED" && dir.state !== "PROPOSAL_STAGE")

const carryOverSignature = (project) =>
  hash(
    JSON.stringify(
      collectCarryOverDrift(project).map((dir) => ({
        relDir: dir.relDir,
        state: dir.state,
      }))
    )
  )

const markCarryOverNoticeEmitted = (state, project, source) => {
  const signature = carryOverSignature(project)
  state.carryOverNotice = {
    signature,
    source,
    emittedAt: new Date().toISOString(),
  }
}

const shouldEmitCarryOverNotice = (state, project) => {
  const driftDirs = collectCarryOverDrift(project)
  if (!driftDirs.length) return false
  return state.carryOverNotice?.signature !== carryOverSignature(project)
}

const formatCarryOverReminder = (project, options = {}) => {
  const driftDirs = collectCarryOverDrift(project)
  if (!driftDirs.length) return ""
  return [
    `${options.prefix || ""}SDD carry-over drift from prior sessions:`,
    ...driftDirs.map((dir) => `- ${dir.relDir}: ${dir.state}`),
    "",
    "Before final answer, review these active SDD change directories and synchronize design.md/tasks.md with the implementation if needed.",
    SUBAGENT_REVIEW_RULE,
  ].join("\n")
}

const buildPreCompactSummary = (project) => {
  const driftDirs = collectCarryOverDrift(project)
  if (!driftDirs.length) return ""
  return [
    "SDD drift summary preserved across compaction:",
    ...driftDirs.slice(0, 20).map((dir) => `- ${dir.relDir}: ${dir.state}`),
  ].join("\n")
}

const refreshAlignedBaseline = (cwd, project, state) => {
  if (!project) return false
  const nowMs = Date.now() * 1000
  let changed = false
  for (const dir of Object.values(project.changeDirs || {})) {
    if (dir.archived) continue
    const linkedCodeRecords = (dir.linkedCode || [])
      .map((item) => state.files?.[normalizeKey(path.join(cwd, item.path))])
      .filter((record) => record?.editedSeq && isCodePath(record.path || ""))
    if (!linkedCodeRecords.length) continue
    const latestCodeSeq = Math.max(0, ...linkedCodeRecords.map((record) => Number(record.editedSeq || 0)))
    if (!latestCodeSeq) continue

    const docPaths = [DESIGN_FILE, TASKS_FILE]
      .filter((file) => dir.docs?.[docKeyForFile(file)]?.exists)
      .map((file) => path.join(cwd, dir.relDir, file))
    if (!docPaths.length) continue

    const docSeqs = docPaths.map((file) => editedSeq(state, file))
    const allDocsEditedBeforeCode = docSeqs.every((seq) => seq > 0 && seq < latestCodeSeq)
    if (!allDocsEditedBeforeCode) continue

    const latestCodeMs = Math.max(0, ...linkedCodeRecords.map((record) => eventMsForFileRecord(record, true)))
    if (Number(dir.alignedAtMs || 0) >= latestCodeMs) continue
    dir.alignedAtMs = Math.max(nowMs, latestCodeMs)
    dir.alignedAt = new Date().toISOString()
    changed = true
  }
  if (changed) recomputeProjectState(project, cwd)
  return changed
}

const isImplementationFlowCodePending = (cwd, state, pending) => {
  if (pending?.type !== "code") return false
  const gaps = pending.gaps || []
  if (!gaps.length) return false
  return gaps.every((gap) => {
    const latest = Number(gap.latestCodeSeq || 0)
    if (!latest) return false
    const targets = gap.reviewTargets || []
    if (!targets.length) return false
    return targets.every((target) => {
      const seq = editedSeq(state, target)
      return seq > 0 && seq < latest
    })
  })
}

const markImplementationFlowConfirmation = (cwd, state, pending, project = null) => {
  if (!isImplementationFlowCodePending(cwd, state, pending)) return false
  const nowMs = Date.now() * 1000
  for (const gap of pending.gaps || []) {
    const signature = gap.reviewSignature || codeReviewSignature(cwd, gap)
    if (!signature) continue
    state.codeReviewConfirmations[signature] = {
      confirmed: true,
      confirmedAt: new Date().toISOString(),
      codeSeq: gap.latestCodeSeq || 0,
      codeFiles: gap.codeFiles || [],
      reviewTargets: gap.reviewTargets || [],
      implementationFlow: true,
      userConfirmationRecommended: false,
    }
    if (project) {
      const relDirs = new Set(
        (gap.reviewTargets || [])
          .map((file) => getChangeDirForPath(file))
          .filter(Boolean)
          .map((changeDir) => relDirForProject(cwd, changeDir.dir))
      )
      for (const relDirValue of relDirs) {
        const dir = project.changeDirs?.[relDirValue]
        if (!dir) continue
        dir.alignedAtMs = Math.max(Number(dir.alignedAtMs || 0), Number(gap.latestCodeMs || 0), nowMs)
        dir.alignedAt = new Date().toISOString()
      }
    }
  }
  if (project) recomputeProjectState(project, cwd)
  return true
}

const collectReviewTargets = (cwd, state) => {
  if (!hasSddWorkspace(cwd)) return []

  const discoveredDirs = [...(state.changeDirs || []), ...discoverChangeDirs(cwd)]
  const dirs = collectActiveChangeDirs(cwd, state)
  const targets = []

  for (const dir of dirs) {
    for (const file of REVIEW_FILES) {
      const target = path.join(dir, file)
      if (!fs.existsSync(target)) continue
      if (!targets.some((existing) => samePath(existing, target))) {
        targets.push(path.normalize(target))
      }
    }
  }

  if (targets.length || dirs.length || discoveredDirs.length) return targets

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
  if (state.codeReviewConfirmations?.[reviewSignature]?.implementationFlow) return []
  const hasReviewEdit = editedSddSeqAfter(state, reviewTargets, latestCodeSeq)

  const reviewReady = pendingReviewTargets.length === 0
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
      ...ACTIVE_SDD_ALIGNMENT_RULES,
      ...formatAttributionReviewRules(),
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
    "After review, update active SDD document(s) whenever they no longer match the implemented code. Optimization and refactor work can still require SDD updates.",
    ...ACTIVE_SDD_ALIGNMENT_RULES,
    ...formatAttributionReviewRules(),
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

const clearSubagentCheckpointNoticeIfResolved = (state, pending) => {
  if (pending) return
  state.subagentCheckpointNotice = null
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

const normalizeCheckpointToolName = (tool) =>
  String(tool || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s.]+/g, "_")

const isSubagentCheckpointTool = (tool, toolInput = {}) => {
  const normalized = normalizeCheckpointToolName(tool)
  if (normalized === "background_task") return false
  if (normalized === "call_omo_agent" && toolInput?.run_in_background === true) return false
  return SUBAGENT_CHECKPOINT_TOOLS.has(normalized)
}

const isQuestionCheckpointTool = (tool) =>
  QUESTION_CHECKPOINT_TOOLS.has(normalizeCheckpointToolName(tool))

const collectCheckpointStrings = (value, depth = 0, seen = new Set()) => {
  if (value == null || depth > 4) return []
  if (typeof value === "string") return [limitString(value, CHECKPOINT_OUTPUT_TEXT_MAX_BYTES)]
  if (typeof value !== "object") return []
  if (seen.has(value)) return []
  seen.add(value)

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCheckpointStrings(item, depth + 1, seen))
  }

  const texts = []
  for (const key of [
    "output",
    "content",
    "text",
    "message",
    "summary",
    "result",
    "stdout",
    "value",
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      texts.push(...collectCheckpointStrings(value[key], depth + 1, seen))
    }
  }
  return texts
}

const collectCheckpointOutputText = (input) => {
  const texts = []
  for (const key of CHECKPOINT_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input || {}, key)) {
      texts.push(...collectCheckpointStrings(input[key]))
    }
  }
  return limitString(texts.filter(Boolean).join("\n"), CHECKPOINT_OUTPUT_TEXT_MAX_BYTES)
}

const stripCheckpointPathToken = (token) =>
  String(token || "")
    .replace(/^[\s"'`(<\[\-*]+/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/[\s"'`)>.,;:\]]+$/, "")

const isInsideWorkspace = (cwd, fp) => {
  const relative = path.relative(path.resolve(cwd), path.resolve(fp))
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

const isIgnoredCheckpointPath = (cwd, fp) => {
  const relative = rel(cwd, fp)
  return CHECKPOINT_PATH_IGNORE_RE.test(relative)
}

const checkpointLineMayDescribeEdit = (line, priorHeaderLines) =>
  CHECKPOINT_EDIT_LINE_RE.test(line) || priorHeaderLines > 0

const extractCheckpointEditedPaths = (cwd, text) => {
  const paths = []
  let headerCarry = 0
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      headerCarry = 0
      continue
    }

    if (CHECKPOINT_EDIT_HEADER_RE.test(line)) {
      headerCarry = 4
    }
    const mayDescribeEdit = checkpointLineMayDescribeEdit(line, headerCarry)
    if (headerCarry > 0) headerCarry -= 1
    if (!mayDescribeEdit) continue

    for (const match of line.matchAll(CHECKPOINT_PATH_RE)) {
      const token = stripCheckpointPathToken(match[0])
      if (!token) continue
      const abs = path.isAbsolute(token) ? path.resolve(token) : resolveFile(cwd, token)
      if (!isInsideWorkspace(cwd, abs)) continue
      if (isIgnoredCheckpointPath(cwd, abs)) continue
      if (!fs.existsSync(abs)) continue
      if (!isCodePath(abs)) continue
      if (!paths.some((existing) => samePath(existing, abs))) paths.push(path.normalize(abs))
    }
  }
  return paths
}

const checkpointOutputSuggestsCodeEdit = (text) =>
  CHECKPOINT_EDIT_LINE_RE.test(text || "") || CHECKPOINT_COMPLETION_RE.test(text || "")

const checkpointMtimeWindowMs = () => {
  if (!Number.isFinite(CHECKPOINT_MTIME_WINDOW_MS)) return 10 * 60 * 1000
  return Math.max(0, CHECKPOINT_MTIME_WINDOW_MS)
}

const checkpointMtimeScanMaxFiles = () => {
  if (!Number.isFinite(CHECKPOINT_MTIME_SCAN_MAX_FILES)) return 50
  return Math.max(1, CHECKPOINT_MTIME_SCAN_MAX_FILES)
}

const checkpointMtimeScanMaxVisits = () => {
  if (!Number.isFinite(CHECKPOINT_MTIME_SCAN_MAX_VISITS)) return 2000
  return Math.max(100, CHECKPOINT_MTIME_SCAN_MAX_VISITS)
}

const shouldRecordCheckpointMtimePath = (state, fp, cutoffMs) => {
  const mtimeMs = fileMtimeMs(fp)
  if (!mtimeMs || mtimeMs < cutoffMs) return false
  const existing = state.files[normalizeKey(fp)]
  if (existing?.editedSeq && existing?.mtimeMs && mtimeMs <= Number(existing.mtimeMs) + 1) {
    return false
  }
  return true
}

const scanRecentCheckpointCodePaths = (cwd, state, cutoffMs) => {
  const found = []
  const stack = [path.resolve(cwd)]
  let visited = 0
  const maxFiles = checkpointMtimeScanMaxFiles()
  const maxVisits = checkpointMtimeScanMaxVisits()

  while (stack.length && visited < maxVisits && found.length < maxFiles) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (visited >= maxVisits || found.length >= maxFiles) break
      const fp = path.join(dir, entry.name)
      if (!isInsideWorkspace(cwd, fp) && !samePath(cwd, fp)) continue
      if (isIgnoredCheckpointPath(cwd, fp)) continue
      visited += 1
      if (entry.isDirectory()) {
        stack.push(fp)
        continue
      }
      if (!entry.isFile()) continue
      if (!isCodePath(fp)) continue
      if (!shouldRecordCheckpointMtimePath(state, fp, cutoffMs)) continue
      found.push(path.normalize(fp))
    }
  }

  return found
}

const hydrateStateFromCheckpointMtime = (cwd, state, input, text = collectCheckpointOutputText(input)) => {
  const tool = String(input?.tool_name || "").toLowerCase()
  if (!CHECKPOINT_MTIME_SCAN) return false
  if (!hasSddWorkspace(cwd) || isDtsContextActive(state)) return false
  if (!isSubagentCheckpointTool(tool, input?.tool_input || {})) return false
  const hasText = Boolean(String(text || "").trim())
  if (hasText && !checkpointOutputSuggestsCodeEdit(text)) return false

  const now = Date.now()
  const createdAt = Date.parse(state.createdAt || "") || now
  const cutoffMs = Math.max(createdAt, now - checkpointMtimeWindowMs())
  let changed = false
  for (const fp of scanRecentCheckpointCodePaths(cwd, state, cutoffMs)) {
    recordFile(state, fp, true)
    changed = true
  }
  return changed
}

const hydrateStateFromCheckpointOutput = (cwd, state, input) => {
  const tool = String(input?.tool_name || "").toLowerCase()
  if (!isSubagentCheckpointTool(tool, input?.tool_input || {})) return false

  const text = collectCheckpointOutputText(input)
  if (!text) return hydrateStateFromCheckpointMtime(cwd, state, input, "")

  let changed = false
  for (const fp of extractCheckpointEditedPaths(cwd, text)) {
    recordFile(state, fp, true)
    changed = true
  }
  return changed || hydrateStateFromCheckpointMtime(cwd, state, input, text)
}

const buildSubagentCheckpointEnforcement = (cwd, state, project = null) => {
  const hardPeerGaps = collectCombinedPeerGaps(cwd, state, project, { includeStageOnly: false })
  if (hardPeerGaps.length) {
    return {
      type: "peer",
      signature: hash(JSON.stringify({ type: "subagent-peer", gaps: hardPeerGaps.map(serializablePeerGap) })),
      message: buildToolEnforcement(hardPeerGaps, { compact: true }),
    }
  }

  const pendingCodeGaps = collectCombinedCodeGaps(cwd, state, project).filter((gap) => !gap.reviewReady)
  if (pendingCodeGaps.length) {
    return {
      type: "code",
      signature: hash(
        JSON.stringify({
          type: "subagent-code",
          gaps: pendingCodeGaps.map((gap) => serializableCodeGap(cwd, gap)),
        })
      ),
      message: buildCodeEnforcement(cwd, pendingCodeGaps, { compact: true }),
    }
  }

  return null
}

const buildQuestionCheckpointMessage = (message) =>
  [
    "SDD drift question checkpoint.",
    "The assistant is about to ask the user a question or hand control back while SDD synchronization or review is still pending.",
    "Do not ask about commit, next action, or whether to continue before resolving the SDD reminder below.",
    "Continue the current turn now and handle the pending SDD work first.",
    "",
    message,
  ].join("\n")

const buildQuestionCheckpointEnforcement = (cwd, state, project = null) => {
  const hardPeerGaps = collectCombinedPeerGaps(cwd, state, project, { includeStageOnly: false })
  if (hardPeerGaps.length) {
    return {
      type: "peer",
      signature: hash(JSON.stringify({ type: "question-peer", gaps: hardPeerGaps.map(serializablePeerGap) })),
      message: buildQuestionCheckpointMessage(buildToolEnforcement(hardPeerGaps, { compact: true })),
    }
  }

  const pendingCodeGaps = collectCombinedCodeGaps(cwd, state, project).filter((gap) => !gap.reviewReady)
  if (pendingCodeGaps.length) {
    return {
      type: "code",
      signature: hash(
        JSON.stringify({
          type: "question-code",
          gaps: pendingCodeGaps.map((gap) => serializableCodeGap(cwd, gap)),
        })
      ),
      message: buildQuestionCheckpointMessage(buildCodeEnforcement(cwd, pendingCodeGaps, { compact: true })),
    }
  }

  return null
}

const shouldEmitSubagentCheckpointNotice = (state, pending) =>
  Boolean(pending?.signature) && state.subagentCheckpointNotice?.signature !== pending.signature

const markSubagentCheckpointNoticeEmitted = (state, pending, tool) => {
  if (!pending?.signature) return
  state.subagentCheckpointNotice = {
    active: true,
    signature: pending.signature,
    type: pending.type,
    tool: normalizeCheckpointToolName(tool),
    emittedAt: new Date().toISOString(),
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
  const project = options.project || null
  const peerGaps = collectCombinedPeerGaps(cwd, state, project, {
    includeStageOnly: options.includeStageOnly !== false,
  })
  if (peerGaps.length) {
    return {
      type: "peer",
      message: buildToolEnforcement(peerGaps),
      signature: peerDriftSignature(peerGaps),
    }
  }

  const codeGaps = collectCombinedCodeGaps(cwd, state, project)
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

const confirmationStillNeedsHumanReview = (state, confirmation) =>
  !editedSddSeqAfter(state, confirmation?.reviewTargets || [], Number(confirmation?.codeSeq || 0))

const collectCodeReviewAdvisoryLines = (cwd, state) =>
  Object.values(state.codeReviewConfirmations || {})
    .filter((confirmation) => confirmation?.confirmed && confirmation?.userConfirmationRecommended)
    .filter((confirmation) => confirmationStillNeedsHumanReview(state, confirmation))
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

const collectReportLines = (cwd, state, project = null) => {
  const lines = collectCombinedPeerGaps(cwd, state, project, { includeStageOnly: false }).map(
    (gap) => `  - ${formatGap(gap)}`
  )

  for (const gap of collectCombinedCodeGaps(cwd, state, project)) {
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

const refreshReport = (cwd, state, project = null) => {
  const reportPath = path.join(cwd, ".sdd-drift-report.md")
  const lines = collectReportLines(cwd, state, project)

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

const buildPreToolUseDenyOutput = (message) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
      additionalContext: message,
    },
  })

const buildStopOutput = (input, message) => {
  if (isOpenCodeHookInput(input)) {
    if (OPENCODE_STOP_REPORT_ONLY) {
      return JSON.stringify({
        decision: "approve",
        stop_hook_active: false,
        sdd_drift_report_only: true,
      })
    }
    return JSON.stringify({
      decision: "block",
      reason:
        "SDD drift check found pending SDD synchronization or review. Attempting OpenCode Stop continuation; see .sdd-drift-report.md if the session does not continue.",
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
  if (input?.hook_event_name === "PreToolUse") {
    process.stdout.write(buildPreToolUseDenyOutput(message))
    return
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

const dispatch = async (input) => {
  const cwd = input.cwd || process.cwd()
  if (!hasSddWorkspace(cwd)) return

  const sessionID = input.session_id || "default"
  const currentStatePath = statePath(cwd, sessionID)
  const currentProjectPath = projectStatePath(cwd)
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

  const projectLock = acquireFileLock(currentProjectPath, {
    staleMs: STATE_LOCK_STALE_MS,
    waitMs: PROJECT_LOCK_WAIT_MS,
    retryMs: STATE_LOCK_RETRY_MS,
  })

  try {
  const state = loadState(cwd, sessionID)
  const project = projectLock ? loadProjectState(cwd) : null
  const persist = () => {
    if (project) {
      applySessionToProject(cwd, project, state, sessionID)
      saveProjectState(cwd, project)
      state.projectStateSeenAt = project.lastUpdatedAt
    }
    saveState(cwd, sessionID, state)
  }
  const persistAndReport = () => {
    if (project) {
      applySessionToProject(cwd, project, state, sessionID)
      saveProjectState(cwd, project)
      state.projectStateSeenAt = project.lastUpdatedAt
    }
    refreshReport(cwd, state, project)
    saveState(cwd, sessionID, state)
  }
  const transcriptPathForContext = resolveTranscriptPath(input)
  const dtsContextActive = updateDtsContextFromInput(state, input, transcriptPathForContext)
  const handlerContext = {
    cwd,
    sessionID,
    state,
    project,
    applySessionToProject,
    applyToolRecord,
    buildClaudeCodeOutput,
    buildCodeEnforcement,
    buildAttributionReviewPrompt,
    buildPreCompactSummary,
    buildQuestionCheckpointEnforcement,
    buildPendingEnforcement,
    buildSubagentCheckpointEnforcement,
    buildToolEnforcement,
    clearCodeDriftNoticeIfResolved,
    clearPeerDriftNoticeIfResolved,
    buildStopEnforcement,
    clearSubagentCheckpointNoticeIfResolved,
    clearPeerSyncs,
    clearStageOnlyRequirements,
    CODE_REVIEW_STOP_MAX_BLOCKS,
    codeDriftNoticeEmissionCount,
    codeReviewToolMaxReminders,
    collectCombinedCodeGaps,
    collectCombinedPeerGaps,
    drift,
    emitEnforcement,
    emitStopEnforcement,
    formatCarryOverReminder,
    getToolEventKey,
    getToolFilePath,
    isDtsContextActive,
    isOpenCodeHookInput,
    isQuestionCheckpointTool,
    limitString,
    hydrateStateFromTranscript,
    hydrateStateFromCheckpointOutput,
    acceptUnresolvedAttributionReviews,
    markCarryOverNoticeEmitted,
    markCodeDriftNoticeEmitted,
    markCodeReviewNoEditConfirmation,
    markImplementationFlowConfirmation,
    markPeerDriftNoticeEmitted,
    markSubagentCheckpointNoticeEmitted,
    markStopCodeReviewConfirmation,
    markToolEvent,
    OPENCODE_STOP_REPORT_ONLY,
    persist,
    persistAndReport,
    peerDriftSignature,
    refreshAlignedBaseline,
    refreshReport,
    rel,
    resolveReadOnlyAttributionReviews,
    resolveFile,
    shouldEmitCarryOverNotice,
    shouldEmitCodeDriftNotice,
    shouldEmitSubagentCheckpointNotice,
    isCodeDriftNoticeSuppressed,
    isSubagentCheckpointTool,
    summarizeInput,
    summarizeGaps,
    SHOW_WARNINGS,
    STOP_MAX_BLOCKS,
    takeAttributionReviewPrompts,
    transcriptPathForContext,
    writeDiagnosticLog,
    writeStdout: (message) => process.stdout.write(message),
  }
  writeDiagnosticLog(cwd, {
    event: "hook_start",
    input: summarizeInput(input),
    statePath: currentStatePath,
    projectPath: currentProjectPath,
    stateLockAcquired: Boolean(stateLock),
    projectLockAcquired: Boolean(projectLock),
    outputMode: OUTPUT_MODE || "auto",
    strictBlock: STRICT_BLOCK,
    dtsContextActive,
  })

  if (CircuitBreaker.isOpen(state, input.hook_event_name)) {
    writeDiagnosticLog(cwd, {
      event: "circuit_open_skip",
      input: summarizeInput(input),
    })
    saveState(cwd, sessionID, state)
    return
  }

  const recordCircuitSuccess = () => {
    if (CircuitBreaker.recordSuccess(state, input.hook_event_name)) {
      saveState(cwd, sessionID, state)
      writeDiagnosticLog(cwd, {
        event: "circuit_close",
        input: summarizeInput(input),
      })
    }
  }

  try {

  if (input.hook_event_name === "UserPromptSubmit" || input.hook_event_name === "ChatMessage") {
    handleUserPromptSubmit(input, handlerContext)
    recordCircuitSuccess()
    return
  }

  if (input.hook_event_name === "PreCompact") {
    handlePreCompact(input, handlerContext)
    recordCircuitSuccess()
    return
  }

  if (input.hook_event_name === "PreToolUse") {
    handlePreToolUse(input, handlerContext)
    recordCircuitSuccess()
    return
  }

  if (input.hook_event_name === "Stop") {
    handleStop(input, handlerContext)
    recordCircuitSuccess()
    return
  }

  if (input.hook_event_name === "PostToolUse") {
    handlePostToolUse(input, handlerContext)
    recordCircuitSuccess()
    return
  }

  persistAndReport()
  writeDiagnosticLog(cwd, {
    event: "ignored_event",
    input: summarizeInput(input),
  })
  recordCircuitSuccess()
  return
  } catch (err) {
    const opened = CircuitBreaker.recordFailure(state, input.hook_event_name)
    saveState(cwd, sessionID, state)
    writeDiagnosticLog(cwd, {
      event: "handler_exception",
      input: summarizeInput(input),
      error: limitString(err?.stack || err, 2000),
    })
    if (opened) {
      writeDiagnosticLog(cwd, {
        event: "circuit_open",
        input: summarizeInput(input),
      })
    }
    return
  }
  } finally {
    releaseFileLock(projectLock)
    releaseFileLock(stateLock)
  }
}

const main = async () => {
  const input = parseHookInput(await readStdin(STDIN_TIMEOUT_MS))
  await dispatch(input)
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
    buildAttributionReviewPrompt,
    buildPendingEnforcement,
    buildPreToolUseDenyOutput,
    buildQuestionCheckpointEnforcement,
    buildStopEnforcement,
    buildStopOutput,
    buildSubagentCheckpointEnforcement,
    clearCodeDriftNoticeIfResolved,
    clearSubagentCheckpointNoticeIfResolved,
    cleanupDiagnosticLogs,
    collectActiveChangeDirs,
    collectCarryOverDrift,
    collectCodeGaps,
    collectCombinedCodeGaps,
    collectCombinedPeerGaps,
    collectPeerGaps,
    collectProjectCodeGaps,
    collectProjectPeerGaps,
    collectReportLines,
    collectReviewTargets,
    computeProjectConditions,
    computeProjectState,
    CircuitBreaker,
    codeReviewSignature,
    diagnosticLogPath,
    dispatch,
    drift,
    emptyState,
    findSdd,
    getChangeDoc,
    hasEditedSddChange,
    hasSddWorkspace,
    collectCheckpointOutputText,
    extractCheckpointEditedPaths,
    hydrateStateFromCheckpointMtime,
    hydrateStateFromCheckpointOutput,
    hydrateStateFromTranscript,
    isCodeDriftNoticeSuppressed,
    isDtsContextActive,
    isDtsContextText,
    isOpenCodeHookInput,
    isArchivedChangeDir,
    isQuestionCheckpointTool,
    isSubagentCheckpointTool,
    loadProjectState,
    loadState,
    normalizeKey,
    normalizeProjectState,
    parseHookInput,
    projectStatePath,
    applyToolRecord,
    applySessionToProject,
    acquireFileLock,
    ATTRIBUTION_REVIEW_RULES,
    Attribution,
    Actions,
    buildPreCompactSummary,
    createHookHandlers,
    handlePreCompact,
    handlePostToolUse,
    handlePreToolUse,
    handleStop,
    handleUserPromptSubmit,
    getToolEventKey,
    HookHandlers,
    markCarryOverNoticeEmitted,
    markAttributionReviewEmitted,
    markToolEvent,
    pruneStateFiles,
    refreshAlignedBaseline,
    recordFile,
    resolveTranscriptPath,
    refreshReport,
    releaseFileLock,
    acceptUnresolvedAttributionReviews,
    resolveReadOnlyAttributionReviews,
    runActions,
    saveProjectState,
    saveState,
    writeDiagnosticLog,
    takeAttributionReviewPrompts,
    updateDtsContextFromInput,
    shouldEmitCarryOverNotice,
    shouldEmitCodeDriftNotice,
    shouldEmitSubagentCheckpointNotice,
    markCodeDriftNoticeEmitted,
    markImplementationFlowConfirmation,
    markSubagentCheckpointNoticeEmitted,
    markCodeReviewNoEditConfirmation,
    markStopCodeReviewConfirmation,
    updateRequirementsForEdit,
  }
}
