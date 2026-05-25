const fs = require("fs")
const path = require("path")
const { isCodePath } = require("./file-classifier")
const { rel, samePath, toPosix } = require("./paths")
const {
  collectActiveChangeDirs,
  computeProjectConditions,
  discoverChangeDirs,
  docKeyForFile,
} = require("./project-state")
const {
  editedSeq,
  editedSddSeqAfter,
  hasEditedSddChange,
  touchedSeq,
} = require("./session-state")
const { CODE_REVIEW_CONFIRMATION_CAP, DTS_CONTEXT_SKIP } = require("./runtime-config")
const {
  DESIGN_FILE,
  PEER_FILES,
  PROPOSAL_FILE,
  REVIEW_FILES,
  TASKS_FILE,
  getChangeDoc,
  hasSddWorkspace,
  isArchivedChangeDir,
} = require("./sdd-rules")
const { hash } = require("./state-storage")

const isDtsContextActive = (state) => DTS_CONTEXT_SKIP && Boolean(state.dtsContext?.active)

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

  if (isCodePath(fp) && !hasEditedSddChange(state)) {
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
    if (conditions.proposalOnly && includeStageOnly) continue
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

module.exports = {
  codeReviewSignature,
  collectCodeGaps,
  collectCombinedCodeGaps,
  collectCombinedPeerGaps,
  collectPeerGaps,
  collectProjectCodeGaps,
  collectProjectPeerGaps,
  collectReviewTargets,
  drift,
  isCodeReviewConfirmed,
  isDtsContextActive,
  markCodeReviewNoEditConfirmation,
  pruneCodeReviewConfirmations,
}
