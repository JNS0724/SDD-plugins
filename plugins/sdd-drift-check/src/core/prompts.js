const { collectCombinedCodeGaps, collectCombinedPeerGaps } = require("./drift-engine")
const { rel } = require("./paths")
const { collectCarryOverDrift } = require("./project-state")
const {
  ACTIVE_SDD_ALIGNMENT_RULES,
  DOCUMENT_SYNC_RULES,
  RESUME_ORIGINAL_TASK_RULES,
  SUBAGENT_REVIEW_RULE,
  formatAttributionReviewRules,
} = require("./sdd-rules")
const { hash } = require("./state-storage")

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
      ...RESUME_ORIGINAL_TASK_RULES,
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
    ...RESUME_ORIGINAL_TASK_RULES,
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
      "After both documents have been reviewed, resume the original user task if anything remains; finish only if the original task is already complete.",
      ...RESUME_ORIGINAL_TASK_RULES,
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
    ...RESUME_ORIGINAL_TASK_RULES,
    "Do not give the final answer while this code-change batch still has unreviewed SDD documents.",
  ].join("\n")
}

const buildCodeToolReminder = (cwd, gaps) => {
  const detail = gaps
    .map((gap) => {
      const codeList = gap.codeFiles.map((file) => rel(cwd, file)).join(", ")
      const reviewList = formatCodeReviewTargets(cwd, gap.reviewTargets || [])
      return `- changed code file(s) [${codeList}]. Review before final answer: ${reviewList}`
    })
    .join("\n")

  return [
    "SDD drift code review noted.",
    "Implementation code changed, so SDD review will be required before the final answer.",
    detail,
    "",
    "Do not stop coding just because this reminder appeared. If more implementation, verification, cleanup, or requested edits remain, continue the original task now.",
    "When the implementation batch is complete, and before final answer or before asking the user what to do next, read/review the listed active design.md and tasks.md files.",
    "Update only the SDD documents that are stale; if no document needs changes, leave them unchanged and say which files you reviewed.",
    SUBAGENT_REVIEW_RULE,
    ...RESUME_ORIGINAL_TASK_RULES,
  ].join("\n")
}

const serializablePeerGap = (gap) => ({
  relDir: gap.relDir,
  edited: [...(gap.edited || [])].sort(),
  sourceFiles: [...(gap.sourceFiles || [])].sort(),
  stageOnly: Boolean(gap.stageOnly),
  absent: [...(gap.absent || [])].sort(),
  unsynced: [...(gap.unsynced || [])].sort(),
  stale: [...(gap.stale || [])].sort(),
  required: [...(gap.required || [])].sort(),
})

const serializableCodeGap = (cwd, gap) => ({
  codeFiles: (gap.codeFiles || []).map((file) => rel(cwd, file)).sort(),
  latestCodeSeq: gap.latestCodeSeq || 0,
  reviewTargets: (gap.reviewTargets || []).map((file) => rel(cwd, file)).sort(),
  pendingReviewTargets: (gap.pendingReviewTargets || []).map((file) => rel(cwd, file)).sort(),
  reviewReady: Boolean(gap.reviewReady),
  needsConfirmation: Boolean(gap.needsConfirmation),
})

const peerDriftSignature = (peerGaps) =>
  hash(JSON.stringify({ type: "peer", gaps: peerGaps.map(serializablePeerGap) }))

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
    "After the pending SDD work is resolved, return to the original user task from where you paused; do not treat this checkpoint itself as task completion.",
    ...RESUME_ORIGINAL_TASK_RULES,
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

const buildStopEnforcement = (pendingMessage) =>
  [
    "SDD drift stop enforcement.",
    "The assistant attempted to stop while required SDD synchronization or review is still missing.",
    "",
    pendingMessage,
    "",
    "Continue the current task now. Do not ask the user for permission to continue.",
    "After the required SDD work is resolved, resume the original user task if anything remains; do not stop only because the SDD checkpoint is resolved.",
    "For code-review gaps, read/review the listed SDD document(s), then update only the files that actually need changes.",
    "If those documents have already been reviewed and no edit is needed, stop again with a concise final answer; the hook will record the review confirmation marker.",
    "For peer-sync gaps, use read, then edit or write, to synchronize the listed SDD document(s) before trying to stop again.",
  ].join("\n")

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

const buildPreCompactSummary = (cwdOrProject, stateOrNull = null, projectOrNull = null) => {
  const legacyCall = typeof cwdOrProject !== "string"
  const cwd = legacyCall ? "" : cwdOrProject
  const state = legacyCall ? null : stateOrNull
  const project = legacyCall ? cwdOrProject : projectOrNull
  const driftDirs = collectCarryOverDrift(project)
  const pending = cwd && state ? buildQuestionCheckpointEnforcement(cwd, state, project) : null
  const checkpointActive =
    Boolean(pending?.signature) &&
    state?.subagentCheckpointNotice?.active &&
    state.subagentCheckpointNotice.signature === pending.signature

  if (!driftDirs.length && !checkpointActive) return ""

  if (checkpointActive) {
    return [
      "SDD drift checkpoint preserved across compaction:",
      "Before compaction, the assistant was blocked from asking the user or handing control back because SDD synchronization/review was pending.",
      "After compaction resumes, handle this SDD work first, then return to the original user task from where it was interrupted.",
      ...RESUME_ORIGINAL_TASK_RULES,
      "",
      pending.message,
      ...(driftDirs.length
        ? [
            "",
            "Active SDD change-dir states:",
            ...driftDirs.slice(0, 20).map((dir) => `- ${dir.relDir}: ${dir.state}`),
          ]
        : []),
    ].join("\n")
  }

  return [
    "SDD drift summary preserved across compaction:",
    ...driftDirs.slice(0, 20).map((dir) => `- ${dir.relDir}: ${dir.state}`),
    "",
    "After compaction resumes, review these active SDD change directories before final answer and synchronize design.md/tasks.md with the implementation if needed.",
    ...RESUME_ORIGINAL_TASK_RULES,
  ].join("\n")
}

module.exports = {
  buildAttributionReviewPrompt,
  buildCodeEnforcement,
  buildCodeToolReminder,
  buildPendingEnforcement,
  buildPreCompactSummary,
  buildQuestionCheckpointEnforcement,
  buildQuestionCheckpointMessage,
  buildStopEnforcement,
  buildSubagentCheckpointEnforcement,
  buildToolEnforcement,
  formatCarryOverReminder,
  formatCodeReviewTargets,
  formatGap,
  peerDriftSignature,
  serializableCodeGap,
  serializablePeerGap,
}
