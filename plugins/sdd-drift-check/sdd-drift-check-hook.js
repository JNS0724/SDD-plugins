const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)$/
const SHOW_WARNINGS = process.env.SDD_DRIFT_SHOW_WARNINGS === "1"
const STRICT_BLOCK = process.env.SDD_DRIFT_STRICT === "1"
const DEBUG = process.env.SDD_DRIFT_DEBUG === "1"
const OUTPUT_MODE = String(process.env.SDD_DRIFT_OUTPUT || "").toLowerCase()
const STATE_DIR = ".sdd-drift-hook-state"
const PEER_FILES = ["design.md", "tasks.md"]
const DESIGN_FILE = "design.md"
const CHANGE_DOC_REQUIREMENTS = {
  "proposal.md": ["design.md", "tasks.md"],
  "design.md": ["tasks.md"],
  "tasks.md": ["design.md"],
}
const DOCUMENT_SYNC_RULES = [
  "When updating SDD documents, preserve the existing document template and heading structure.",
  "Do not add a new section or rewrite the template just to satisfy this enforcement.",
  "Read the target document first, find the most appropriate existing section, and make the smallest needed update there.",
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

const stateDir = (cwd) => {
  const gitDir = findNearestGitDir(cwd)
  if (gitDir) {
    const gitStateDir = path.join(gitDir, "sdd-drift-hook-state")
    try {
      fs.mkdirSync(gitStateDir, { recursive: true })
      const probe = path.join(gitStateDir, `.probe.${process.pid}.${Date.now()}`)
      fs.writeFileSync(probe, "")
      fs.unlinkSync(probe)
      return gitStateDir
    } catch {}
  }
  return path.join(cwd, STATE_DIR)
}

const statePath = (cwd, sessionID) =>
  path.join(stateDir(cwd), `${hash(path.resolve(cwd))}-${sanitize(sessionID)}.json`)

const emptyState = () => ({
  version: 2,
  clock: 0,
  touched: [],
  edited: [],
  changeDirs: [],
  files: {},
  requirements: {},
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
      fs.unlinkSync(tmp)
      return
    } catch {}
    throw err
  }
}

const cleanupOldState = (cwd) => {
  const dir = stateDir(cwd)
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000
  try {
    const now = Date.now()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const fp = path.join(dir, entry.name)
      const stat = fs.statSync(fp)
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(fp)
    }
  } catch {}
}

const saveState = (cwd, sessionID, state) => {
  cleanupOldState(cwd)
  writeTextAtomic(statePath(cwd, sessionID), JSON.stringify(state, null, 2))
}

const resolveFile = (cwd, fp) =>
  path.isAbsolute(fp) ? path.normalize(fp) : path.resolve(cwd, fp)

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

const editedSeq = (state, fp) => state.files[normalizeKey(fp)]?.editedSeq || 0

const rel = (cwd, fp) => toPosix(path.relative(cwd, fp))

const recordFile = (state, fp, edited) => {
  const abs = path.normalize(path.resolve(fp))
  const key = normalizeKey(abs)
  state.clock += 1
  state.files[key] = {
    ...(state.files[key] || {}),
    path: abs,
    touchedSeq: state.clock,
    ...(edited ? { editedSeq: state.clock } : {}),
  }
  addPath(state.touched, abs)
  if (edited) addPath(state.edited, abs)
  return state.clock
}

const addChangeDir = (state, dir) => addPath(state.changeDirs, dir)

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

const updateRequirementsForEdit = (state, dir, file, seq) => {
  const bucket = getRequirementBucket(state, dir, false)
  const pending = bucket?.files?.[file]
  if (pending && seq > pending.afterSeq) {
    delete bucket.files[file]
    cleanupRequirementBucket(state, dir)
    return
  }

  const requiredPeers = CHANGE_DOC_REQUIREMENTS[file] || []
  if (requiredPeers.length === 0) return

  const target = getRequirementBucket(state, dir, true)
  for (const peer of requiredPeers) {
    const peerPath = path.join(dir, peer)
    if (editedSeq(state, peerPath) > seq) continue
    target.files[peer] = {
      sourceFile: file,
      afterSeq: seq,
    }
  }
  cleanupRequirementBucket(state, dir)
}

const hasEditedSddChange = (state) =>
  Object.values(state.files).some((file) => file.editedSeq && isSddChangePath(file.path || ""))

const hasEditedChangeDesignAfter = (state, seq) =>
  Object.values(state.files).some((file) => {
    if (!file.editedSeq || file.editedSeq <= seq) return false
    const doc = getChangeDoc(file.path || "")
    return doc?.file === DESIGN_FILE
  })

const drift = (cwd, fp, state) => {
  const warn = []
  const doc = getChangeDoc(fp)

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

const collectPeerGaps = (cwd, state) => {
  const gaps = []

  for (const bucket of Object.values(state.requirements || {})) {
    const dir = bucket.dir
    const missing = []
    const stale = []
    const required = []

    for (const [file, requirement] of Object.entries(bucket.files || {})) {
      const peerPath = path.join(dir, file)
      const seq = editedSeq(state, peerPath)
      if (seq > requirement.afterSeq) continue

      required.push(file)
      if (!fs.existsSync(peerPath) || seq === 0) {
        missing.push(file)
      } else {
        stale.push(file)
      }
    }

    if (!required.length) continue

    const edited = ["proposal.md", ...PEER_FILES].filter((file) => editedSeq(state, path.join(dir, file)) > 0)
    const relDir = toPosix(path.relative(cwd, dir))
    gaps.push({
      relDir,
      edited,
      missing,
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

const collectDesignTargets = (cwd, state) => {
  const dirs = [...(state.changeDirs || []), ...discoverChangeDirs(cwd)]
  const targets = []

  for (const dir of dirs) {
    const design = path.join(dir, DESIGN_FILE)
    if (!targets.some((target) => samePath(target, design))) targets.push(path.normalize(design))
  }

  if (targets.length) return targets

  const fallbackRoot = fs.existsSync(path.join(cwd, ".sdd")) ? ".sdd" : "sdd"
  return [path.join(cwd, fallbackRoot, "changes", "<change-id>", DESIGN_FILE)]
}

const collectCodeGaps = (cwd, state) => {
  const codeFiles = Object.values(state.files || {})
    .filter((file) => file.editedSeq && isCodePath(file.path || ""))
    .sort((left, right) => (right.editedSeq || 0) - (left.editedSeq || 0))

  if (!codeFiles.length) return []

  const latestCodeSeq = codeFiles[0].editedSeq || 0
  if (hasEditedChangeDesignAfter(state, latestCodeSeq)) return []

  const designTargets = collectDesignTargets(cwd, state)
  return [
    {
      codeFiles: codeFiles.map((file) => file.path),
      latestCodeSeq,
      designTargets,
    },
  ]
}

const formatGap = (gap) => {
  const parts = [`required [${gap.required.join(", ")}]`]
  if (gap.missing.length) parts.push(`missing [${gap.missing.join(", ")}]`)
  if (gap.stale.length) parts.push(`stale [${gap.stale.join(", ")}]`)
  return `${gap.relDir}: edited [${gap.edited.join(", ")}], ${parts.join(", ")}`
}

const buildToolEnforcement = (gaps) => {
  const detail = gaps
    .map(
      (gap) =>
        `- ${formatGap(gap)}. Read and update: ${gap.required
          .map((file) => `${gap.relDir}/${file}`)
          .join(", ")}`
    )
    .join("\n")

  return [
    "SDD drift tool result enforcement.",
    "The preceding tool changed SDD change document(s), but peer document(s) are still unsynchronized:",
    detail,
    "",
    "This assistant turn is incomplete until the required peer document(s) are synchronized.",
    "Before any final answer, use the read tool on each required peer file, then use edit or write to synchronize it with the edited SDD change document(s).",
    ...DOCUMENT_SYNC_RULES,
    "Do not stop or summarize completion until the required peer document(s) are updated.",
  ].join("\n")
}

const buildCodeEnforcement = (cwd, gaps) => {
  const detail = gaps
    .map((gap) => {
      const codeList = gap.codeFiles.map((file) => rel(cwd, file)).join(", ")
      const designList = gap.designTargets.map((file) => rel(cwd, file)).join(", ")
      return `- code changed [${codeList}]. Read and update design document(s): ${designList}`
    })
    .join("\n")

  return [
    "SDD drift tool result enforcement.",
    "The preceding tool changed code, but no sdd/changes/**/design.md document has been synchronized after that code change:",
    detail,
    "",
    "This assistant turn is incomplete until the relevant SDD design document is synchronized.",
    "Before any final answer, use the read tool on the relevant design.md, then use edit or write to update it so the design matches the code change.",
    "If the listed path contains <change-id>, choose or create the correct sdd/changes/<change-id>/design.md for this code change.",
    ...DOCUMENT_SYNC_RULES,
    "Do not stop or summarize completion until the required design document is updated.",
  ].join("\n")
}

const collectReportLines = (cwd, state) => {
  const lines = collectPeerGaps(cwd, state).map((gap) => `  - ${formatGap(gap)}`)

  for (const gap of collectCodeGaps(cwd, state)) {
    const codeList = gap.codeFiles.map((file) => rel(cwd, file)).join(", ")
    const designList = gap.designTargets.map((file) => rel(cwd, file)).join(", ")
    lines.push(
      `  - edited code file(s) [${codeList}], but did not update design document(s) after the code change: ${designList}`
    )
  }

  return lines
}

const refreshReport = (cwd, state) => {
  const reportPath = path.join(cwd, ".sdd-drift-report.md")
  const lines = collectReportLines(cwd, state)

  if (lines.length) {
    try {
      writeTextAtomic(reportPath, "## " + new Date().toISOString() + "\n" + lines.join("\n") + "\n")
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

const main = async () => {
  const input = parseHookInput(await readStdin())
  const cwd = input.cwd || process.cwd()
  const sessionID = input.session_id || "default"
  const state = loadState(cwd, sessionID)

  if (input.hook_event_name === "Stop") {
    refreshReport(cwd, state)
    return
  }

  if (input.hook_event_name !== "PostToolUse") return

  const tool = String(input.tool_name || "").toLowerCase()
  const toolInput = input.tool_input || {}
  const fp = toolInput.file_path || toolInput.filePath || toolInput.path
  if (!fp || typeof fp !== "string") return

  const abs = resolveFile(cwd, fp)
  const isEdit = tool === "edit" || tool === "write"
  const seq = recordFile(state, abs, isEdit)

  if (isEdit) {
    const doc = getChangeDoc(abs)
    if (doc?.dir && doc.file) {
      addChangeDir(state, doc.dir)
      updateRequirementsForEdit(state, doc.dir, doc.file, seq)
    }

    const warnings = drift(cwd, abs, state)
    const peerGaps = collectPeerGaps(cwd, state)
    const codeGaps = collectCodeGaps(cwd, state)
    saveState(cwd, sessionID, state)
    refreshReport(cwd, state)

    if (peerGaps.length) {
      emitEnforcement(input, buildToolEnforcement(peerGaps))
    } else if (codeGaps.length) {
      emitEnforcement(input, buildCodeEnforcement(cwd, codeGaps))
    } else if (SHOW_WARNINGS && warnings.length) {
      emitEnforcement(input, warnings.join("\n"))
    }
    return
  }

  saveState(cwd, sessionID, state)
}

if (require.main === module) {
  main().catch((err) => {
    if (DEBUG) process.stderr.write(`[sdd-drift-check] ${err?.stack || err}\n`)
    process.exit(0)
  })
} else {
  module.exports = {
    buildToolEnforcement,
    buildClaudeCodeOutput,
    buildCodeEnforcement,
    collectCodeGaps,
    collectPeerGaps,
    collectReportLines,
    drift,
    emptyState,
    findSdd,
    getChangeDoc,
    hasEditedSddChange,
    isOpenCodeHookInput,
    loadState,
    normalizeKey,
    parseHookInput,
    recordFile,
    refreshReport,
    saveState,
    updateRequirementsForEdit,
  }
}
