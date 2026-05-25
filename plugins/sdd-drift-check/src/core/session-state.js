const fs = require("fs")
const path = require("path")
const { getToolFilePath } = require("./tool-events")
const { isCodePath, isSddChangePath } = require("./file-classifier")
const { normalizeKey, resolveFile, samePath } = require("./paths")
const {
  CHANGE_DOC_REQUIREMENTS,
  DESIGN_FILE,
  PEER_FILES,
  PROPOSAL_FILE,
  TASKS_FILE,
  getChangeDoc,
} = require("./sdd-rules")
const { SESSION_FILES_MAX, TOOL_EVENT_CAP, TRANSCRIPT_EVENT_CAP } = require("./runtime-config")
const { cleanupOldState, statePath, writeTextAtomic } = require("./state-storage")

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
  codeDriftToolNotice: null,
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

const sessionFilesMax = () => (Number.isFinite(SESSION_FILES_MAX) ? Math.max(100, SESSION_FILES_MAX) : 1000)

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
  state.codeDriftToolNotice =
    parsed.codeDriftToolNotice && typeof parsed.codeDriftToolNotice === "object"
      ? parsed.codeDriftToolNotice
      : null
  state.peerDriftNotice =
    parsed.peerDriftNotice && typeof parsed.peerDriftNotice === "object" ? parsed.peerDriftNotice : null
  state.subagentCheckpointNotice =
    parsed.subagentCheckpointNotice && typeof parsed.subagentCheckpointNotice === "object"
      ? parsed.subagentCheckpointNotice
      : null
  state.codeReviewConfirmations =
    parsed.codeReviewConfirmations && typeof parsed.codeReviewConfirmations === "object"
      ? parsed.codeReviewConfirmations
      : {}
  state.transcriptEvents =
    parsed.transcriptEvents && typeof parsed.transcriptEvents === "object" ? parsed.transcriptEvents : {}
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
    parsed.carryOverNotice && typeof parsed.carryOverNotice === "object" ? parsed.carryOverNotice : null
  state.attributionReviews =
    parsed.attributionReviews && typeof parsed.attributionReviews === "object" ? parsed.attributionReviews : {}
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

const loadState = (cwd, sessionID) => {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(statePath(cwd, sessionID), "utf8")))
  } catch {
    return emptyState()
  }
}

const saveState = (cwd, sessionID, state) => {
  cleanupOldState(cwd)
  writeTextAtomic(statePath(cwd, sessionID), JSON.stringify(state, null, 2))
}

const touchedSeq = (state, fp) => state.files[normalizeKey(fp)]?.touchedSeq || 0
const editedSeq = (state, fp) => state.files[normalizeKey(fp)]?.editedSeq || 0
const firstEditedSeq = (state, fp) => state.files[normalizeKey(fp)]?.firstEditedSeq || 0

const latestEditedCodeSeq = (state) =>
  Object.values(state.files || {}).reduce((latest, file) => {
    if (!file.editedSeq || !isCodePath(file.path || "")) return latest
    return Math.max(latest, file.editedSeq || 0)
  }, 0)

const editedSddSeqAfter = (state, files, seq) => files.some((file) => editedSeq(state, file) > seq)

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
  return firstEditedSeq(state, tasksPath) === seq && designSourceSeq > 0 && fs.existsSync(designPath)
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

const hasEditedSddChange = (state) =>
  Object.values(state.files).some((file) => file.editedSeq && isSddChangePath(file.path || ""))

module.exports = {
  addChangeDir,
  addPath,
  applyToolRecord,
  clearPeerSyncs,
  clearStageOnlyRequirements,
  cleanupPeerSyncBucket,
  cleanupRequirementBucket,
  editedSddSeqAfter,
  editedSeq,
  emptyState,
  fileMtimeMs,
  fileRecordOrder,
  firstEditedSeq,
  getPeerSyncBucket,
  getRequirementBucket,
  hasEditedSddChange,
  isInitialTasksPlanEdit,
  isPeerSyncContinuation,
  latestEditedCodeSeq,
  latestStateEventMs,
  loadState,
  markPeerSyncResponse,
  markToolEvent,
  markTranscriptEvent,
  normalizeState,
  pruneStateFiles,
  recordFile,
  saveState,
  sessionFilesMax,
  touchedSeq,
  updateRequirementsForEdit,
}
