const fs = require("fs")
const path = require("path")
const { isCodePath } = require("./file-classifier")
const { normalizeKey, samePath, toPosix } = require("./paths")
const { editedSeq } = require("./session-state")
const {
  DESIGN_FILE,
  PROPOSAL_FILE,
  TASKS_FILE,
  isArchivedChangeDir,
} = require("./sdd-rules")
const { projectStatePath, writeTextAtomic } = require("./state-storage")

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
    docSyncs: {},
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
    docSyncs:
      value?.docSyncs && typeof value.docSyncs === "object"
        ? value.docSyncs
        : value?.peerSyncs && typeof value.peerSyncs === "object"
          ? value.peerSyncs
          : {},
  }
  delete changeDir.peerSyncs
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
  const docSyncs = dir.docSyncs || {}
  const tasksSyncedFromDesign =
    docSyncs.tasks?.sourceFile === DESIGN_FILE &&
    Number(docSyncs.tasks.sourceEditedMs || 0) >= designEdited &&
    Number(docSyncs.tasks.targetEditedMs || 0) >= Number(docSyncs.tasks.sourceEditedMs || 0)
  const designSyncedFromTasks =
    docSyncs.design?.sourceFile === TASKS_FILE &&
    Number(docSyncs.design.sourceEditedMs || 0) >= tasksEdited &&
    Number(docSyncs.design.targetEditedMs || 0) >= Number(docSyncs.design.sourceEditedMs || 0)
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
      designExists &&
      tasksExists &&
      designEditedKnown &&
      designEdited > tasksEdited &&
      designEdited > 0 &&
      !designSyncedFromTasks,
    tasksAheadOfDesign:
      designExists &&
      tasksExists &&
      tasksEditedKnown &&
      tasksEdited > designEdited &&
      tasksEdited > 0 &&
      !tasksSyncedFromDesign,
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

const collectCarryOverDrift = (project) =>
  Object.values(project?.changeDirs || {})
    .filter((dir) => !dir.archived)
    .filter((dir) => dir.state !== "ALIGNED" && dir.state !== "PROPOSAL_STAGE")

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

module.exports = {
  collectActiveChangeDirs,
  collectCarryOverDrift,
  computeProjectConditions,
  computeProjectState,
  createChangeDirFromFs,
  discoverChangeDirs,
  docFileForKey,
  docKeyForFile,
  docRecordFromFs,
  emptyProjectState,
  ensureProjectChangeDirs,
  eventMsForFileRecord,
  loadProjectState,
  normalizeProjectChangeDir,
  normalizeProjectDoc,
  normalizeProjectState,
  quarantineCorruptStateFile,
  recomputeProjectState,
  refreshAlignedBaseline,
  relDirForProject,
  saveProjectState,
}
