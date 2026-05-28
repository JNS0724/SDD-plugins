const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const { Actions, runActions } = require("../../actions")
const { HookHandlers, createHookHandlers } = require("../../dispatcher")
const { handlePreCompact } = require("../../handlers/pre-compact")
const { handlePostToolUse } = require("../../handlers/post-tool-use")
const { handlePreToolUse } = require("../../handlers/pre-tool-use")
const { handleStop } = require("../../handlers/stop")
const { handleUserPromptSubmit } = require("../../handlers/user-prompt-submit")
const { readStdin } = require("../../stdin")
const {
  getToolFilePath,
  isQuestionCheckpointTool,
  isSubagentCheckpointTool,
  normalizeToolName: normalizeCheckpointToolName,
} = require("../../core/tool-events")
const {
  collectCheckpointOutputText,
  extractCheckpointEditedPaths,
  hydrateStateFromCheckpointMtime,
  hydrateStateFromCheckpointOutput,
  hydrateStateFromTranscript,
  resolveTranscriptPath,
} = require("../../core/hydration")
const { normalizeKey, rel, resolveFile, samePath, toPosix } = require("../../core/paths")
const { Attribution } = require("../../core/attribution")
const { isCodePath, isSddPath } = require("../../core/file-classifier")
const { acquireFileLock, releaseFileLock } = require("../../core/locks")
const {
  cleanupDiagnosticLogs,
  recordDiagnosticSummaryEvent,
  writeDiagnosticLog,
} = require("../../core/diagnostics")
const {
  diagnosticLogPath,
  projectStatePath,
  statePath,
} = require("../../core/state-storage")
const {
  applyToolRecord,
  clearPeerSyncs,
  clearStageOnlyRequirements,
  editedSeq,
  emptyState,
  getPeerSyncBucket,
  hasEditedSddChange,
  loadState,
  markToolEvent,
  pruneStateFiles,
  recordFile,
  saveState,
  touchedSeq,
  updateRequirementsForEdit,
} = require("../../core/session-state")
const {
  collectActiveChangeDirs,
  collectCarryOverDrift,
  computeProjectConditions,
  computeProjectState,
  createChangeDirFromFs,
  discoverChangeDirs,
  docKeyForFile,
  emptyProjectState,
  ensureProjectChangeDirs,
  eventMsForFileRecord,
  loadProjectState,
  normalizeProjectState,
  recomputeProjectState,
  refreshAlignedBaseline,
  relDirForProject,
  saveProjectState,
} = require("../../core/project-state")
const {
  codeReviewSignature,
  collectCodeGaps,
  collectCombinedCodeGaps,
  collectCombinedPeerGaps,
  collectPeerGaps,
  collectProjectCodeGaps,
  collectProjectPeerGaps,
  collectReviewTargets,
  drift,
  isDtsContextActive,
  markCodeReviewNoEditConfirmation,
} = require("../../core/drift-engine")
const {
  buildAttributionReviewPrompt,
  buildCodeEnforcement,
  buildCodeToolReminder,
  buildPendingEnforcement,
  buildPreCompactSummary,
  buildQuestionCheckpointEnforcement,
  buildStopEnforcement,
  buildSubagentCheckpointEnforcement,
  buildToolEnforcement,
  formatCarryOverReminder,
  peerDriftSignature,
  serializableCodeGap,
} = require("../../core/prompts")
const {
  collectReportLines,
  refreshReport,
} = require("../../core/report")
const { createOutputHelpers } = require("../../core/output")
const {
  ATTRIBUTION_REVIEW_RULES,
  DESIGN_FILE,
  PROPOSAL_FILE,
  TASKS_FILE,
  findSdd,
  getChangeDoc,
  hasSddWorkspace,
  isArchivedChangeDir,
} = require("../../core/sdd-rules")
const {
  ACTIVE_CHANGE_DIR_TTL_MS,
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_MAX_FAILURES,
  CODE_REVIEW_STOP_MAX_BLOCKS,
  CODE_REVIEW_TOOL_MAX_REMINDERS,
  CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS,
  DEBUG,
  DTS_CONTEXT_OVERRIDE,
  DTS_CONTEXT_SKIP,
  DTS_CONTEXT_TEXT_MAX_BYTES,
  OPENCODE_STOP_REPORT_ONLY,
  OUTPUT_MODE,
  PROJECT_LINKED_CODE_CAP,
  PROJECT_LOCK_WAIT_MS,
  SHOW_WARNINGS,
  STATE_LOCK_RETRY_MS,
  STATE_LOCK_STALE_MS,
  STATE_LOCK_WAIT_MS,
  STDIN_TIMEOUT_MS,
  STOP_MAX_BLOCKS,
  STRICT_BLOCK,
} = require("../../core/runtime-config")

const DIAGNOSTIC_SUMMARY_EVENTS = new Set([
  "handler_exception",
  "hook_exception",
  "circuit_open",
  "circuit_open_skip",
])
const DTS_CONTEXT_PATTERNS = [
  /\bDTS[-_\s]?\d{4,}\b/i,
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

const parseHookInput = (raw) => JSON.parse(String(raw || "{}").replace(/^\uFEFF/, ""))

const hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12)

const limitString = (value, max = 500) => {
  const text = String(value || "")
  return text.length > max ? `${text.slice(0, max)}...` : text
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

const getToolEventKey = (input) => {
  const id = input?.tool_use_id || input?.toolUseId
  if (typeof id === "string" && id.trim()) {
    return `${input.session_id || "default"}:${input.hook_event_name || ""}:${id.trim()}`
  }
  return null
}

const attributionReviewSignature = (cwd, codeFiles, candidates) =>
  hash(
    JSON.stringify({
      type: "attribution-review",
      codeFiles: (codeFiles || []).map((file) => rel(cwd, file)).sort(),
      candidates: (candidates || []).map((dir) => dir.relDir).sort(),
    })
  )

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
  dir.docSyncs = dir.docSyncs && typeof dir.docSyncs === "object" ? dir.docSyncs : {}

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
      key === "design" && dir.docSyncs?.tasks?.sourceFile === DESIGN_FILE
    const designWasSyncedFromPriorTasks =
      key === "tasks" && dir.docSyncs?.design?.sourceFile === TASKS_FILE
    if (designWasSyncedFromPriorTasks) delete dir.docSyncs.design
    if (tasksWasSyncedFromPriorDesign) delete dir.docSyncs.tasks

    if (
      key === "tasks" &&
      (sessionSyncedFromDesign || previousConditions.designAheadOfTasks || designEditedInSession) &&
      !(!sessionSyncedFromDesign && designWasSyncedFromPriorTasks)
    ) {
      dir.docSyncs.tasks = {
        sourceFile: DESIGN_FILE,
        sourceEditedMs: designEdited,
        targetEditedMs: target.lastEditedMs,
      }
    } else if (
      key === "design" &&
      (sessionSyncedFromTasks || previousConditions.tasksAheadOfDesign || tasksEditedInSession) &&
      !(!sessionSyncedFromTasks && tasksWasSyncedFromPriorDesign)
    ) {
      dir.docSyncs.design = {
        sourceFile: TASKS_FILE,
        sourceEditedMs: tasksEdited,
        targetEditedMs: target.lastEditedMs,
      }
    } else {
      if (key === "tasks") delete dir.docSyncs.design
      if (key === "design") delete dir.docSyncs.tasks
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

const clearCodeDriftNoticeIfResolved = (state, codeGaps) => {
  if (codeGaps.length) return
  state.codeDriftNotice = null
  state.codeDriftToolNotice = null
}

const clearPeerDriftNoticeIfResolved = (state, peerGaps) => {
  if (peerGaps.length) return
  state.peerDriftNotice = null
}

const clearSubagentCheckpointNoticeIfResolved = (state, pending) => {
  if (pending) return
  state.subagentCheckpointNotice = null
}

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

const codeReviewToolSessionMaxReminders = () => {
  if (!Number.isFinite(CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS)) return 1
  return Math.max(0, CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS)
}

const codeDriftNoticeEmissionCount = (state) =>
  Math.max(0, Number(state.codeDriftNotice?.emissionCount || 0))

const codeDriftToolSessionEmissionCount = (state) =>
  Math.max(0, Number(state.codeDriftToolNotice?.emissionCount || 0))

const hasPendingCodeReview = (codeGaps) => codeGaps.some((gap) => !gap.reviewReady)

const shouldEmitCodeDriftNotice = (state, codeGaps) => {
  if (!hasPendingCodeReview(codeGaps)) return false
  const maxReminders = codeReviewToolMaxReminders()
  if (maxReminders === 0) return false
  const sessionMaxReminders = codeReviewToolSessionMaxReminders()
  if (sessionMaxReminders === 0) return false
  if (codeDriftToolSessionEmissionCount(state) >= sessionMaxReminders) return false
  if (!state.codeDriftNotice?.active) return true
  return codeDriftNoticeEmissionCount(state) < maxReminders
}

const isCodeDriftNoticeSuppressed = (state, codeGaps) =>
  hasPendingCodeReview(codeGaps) &&
  ((Boolean(state.codeDriftNotice?.active) &&
    codeDriftNoticeEmissionCount(state) >= codeReviewToolMaxReminders()) ||
    codeDriftToolSessionEmissionCount(state) >= codeReviewToolSessionMaxReminders())

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
  const sessionNotice = state.codeDriftToolNotice || {}
  state.codeDriftToolNotice = {
    ...sessionNotice,
    emittedAt: sessionNotice.emittedAt || new Date().toISOString(),
    lastEmittedAt: new Date().toISOString(),
    emissionCount: codeDriftToolSessionEmissionCount(state) + 1,
  }
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

const markStopCodeReviewConfirmation = (state, pending) => {
  if (pending?.type !== "code") return false
  return markCodeReviewNoEditConfirmation(state, pending.gaps || [])
}

const isOpenCodeHookInput = (input) => {
  if (OUTPUT_MODE === "opencode") return true
  if (OUTPUT_MODE === "claude" || OUTPUT_MODE === "claude-code") return false
  return input?.hook_source === "opencode-plugin"
}

const createRuntimeOutputHelpers = (options = {}) => createOutputHelpers({
  isOpenCodeHookInput,
  opencodeStopReportOnly: OPENCODE_STOP_REPORT_ONLY,
  strictBlock: STRICT_BLOCK,
  stdout: options.stdout || process.stdout,
  stderr: options.stderr || process.stderr,
  exit: options.exit || process.exit,
})

const defaultOutputHelpers = createRuntimeOutputHelpers()
const {
  buildClaudeCodeOutput,
  buildPreToolUseDenyOutput,
  buildStopOutput,
  emitEnforcement,
  emitStopEnforcement,
} = defaultOutputHelpers

const dispatch = async (input, options = {}) => {
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
  const outputHelpers =
    options.stdout || options.stderr || options.exit
      ? createRuntimeOutputHelpers(options)
      : defaultOutputHelpers
  const stdout = options.stdout || process.stdout
  const handlerContext = {
    cwd,
    sessionID,
    state,
    project,
    applySessionToProject,
    applyToolRecord,
    buildClaudeCodeOutput: outputHelpers.buildClaudeCodeOutput,
    buildCodeEnforcement,
    buildCodeToolReminder,
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
    codeDriftToolSessionEmissionCount,
    codeReviewToolMaxReminders,
    codeReviewToolSessionMaxReminders,
    collectCombinedCodeGaps,
    collectCombinedPeerGaps,
    drift,
    emitEnforcement: outputHelpers.emitEnforcement,
    emitStopEnforcement: outputHelpers.emitStopEnforcement,
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
    writeStdout: (message) => stdout.write(message),
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

const runHookInput = async (input, options = {}) => {
  let stdout = ""
  let stderr = ""
  let status = 0
  const stdoutStream = {
    write: (chunk) => {
      stdout += String(chunk || "")
      return true
    },
  }
  const stderrStream = {
    write: (chunk) => {
      stderr += String(chunk || "")
      return true
    },
  }
  const exit = (code = 0) => {
    status = Number.isFinite(Number(code)) ? Number(code) : 0
    const error = new Error(`sdd-drift-check hook requested exit ${status}`)
    error.__sddDriftHookExit = true
    throw error
  }

  try {
    await dispatch(input, {
      ...options,
      stdout: options.stdout || stdoutStream,
      stderr: options.stderr || stderrStream,
      exit: options.exit || exit,
    })
  } catch (error) {
    if (!error?.__sddDriftHookExit) throw error
  }

  return {
    status,
    stdout,
    stderr,
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
    buildCodeToolReminder,
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
    recordDiagnosticSummaryEvent,
    resolveTranscriptPath,
    refreshReport,
    releaseFileLock,
    acceptUnresolvedAttributionReviews,
    resolveReadOnlyAttributionReviews,
    runActions,
    runHookInput,
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
