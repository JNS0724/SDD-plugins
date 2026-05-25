const fs = require("fs")
const path = require("path")
const { collectCombinedCodeGaps, collectCombinedPeerGaps } = require("./drift-engine")
const { rel } = require("./paths")
const { formatGap } = require("./prompts")
const { editedSddSeqAfter } = require("./session-state")
const { writeTextAtomic } = require("./state-storage")

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

module.exports = {
  collectCodeReviewAdvisoryLines,
  collectReportLines,
  confirmationStillNeedsHumanReview,
  refreshReport,
}
