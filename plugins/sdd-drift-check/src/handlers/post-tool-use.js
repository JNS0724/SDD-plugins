const { handlePostToolUseCheckpoint } = require("./post-tool-use-checkpoint")

const handlePostToolUse = (input, ctx) => {
  const { cwd, state, project } = ctx
  const tool = String(input.tool_name || "").toLowerCase()
  const toolInput = input.tool_input || {}
  const fp = ctx.getToolFilePath(toolInput)

  if (!fp || typeof fp !== "string") {
    handlePostToolUseCheckpoint(input, ctx, { tool, toolInput })
    return
  }

  const abs = ctx.resolveFile(cwd, fp)
  const isEdit = tool === "edit" || tool === "write" || tool === "multiedit"

  if (!ctx.markToolEvent(state, ctx.getToolEventKey(input))) {
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(cwd, {
      event: "ignored_duplicate_tool_event",
      input: ctx.summarizeInput(input),
      file: ctx.rel(cwd, abs),
    })
    return
  }

  if (!ctx.applyToolRecord(cwd, state, tool, toolInput)) {
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(cwd, {
      event: "ignored_unsupported_tool_record",
      input: ctx.summarizeInput(input),
      file: ctx.rel(cwd, abs),
    })
    return
  }

  if (project) ctx.applySessionToProject(cwd, project, state, ctx.sessionID)
  const codeToolReminderEnabled =
    ctx.codeReviewToolMaxReminders() > 0 &&
    ctx.codeReviewToolSessionMaxReminders() > 0 &&
    ctx.codeDriftToolSessionEmissionCount(state) < ctx.codeReviewToolSessionMaxReminders()
  const attributionReviewPrompts = codeToolReminderEnabled
    ? ctx.takeAttributionReviewPrompts(state)
    : []
  const warnings = isEdit ? ctx.drift(cwd, abs, state) : []
  const peerGaps = ctx.collectCombinedPeerGaps(cwd, state, project)
  const hardPeerGaps = ctx.collectCombinedPeerGaps(cwd, state, project, { includeStageOnly: false })
  const stagePeerGaps = ctx.collectCombinedPeerGaps(cwd, state, project, { includeHard: false })
  let codeGaps = ctx.collectCombinedCodeGaps(cwd, state, project)
  const codeReviewNoEditConfirmed =
    !hardPeerGaps.length && ctx.markCodeReviewNoEditConfirmation(state, codeGaps)
  if (codeReviewNoEditConfirmed) {
    codeGaps = ctx.collectCombinedCodeGaps(cwd, state, project)
  }
  const noticePeerGaps = hardPeerGaps.length ? hardPeerGaps : stagePeerGaps
  ctx.clearPeerDriftNoticeIfResolved(state, noticePeerGaps)
  ctx.clearCodeDriftNoticeIfResolved(state, codeGaps)
  ctx.clearSubagentCheckpointNoticeIfResolved(
    state,
    ctx.buildSubagentCheckpointEnforcement(cwd, state, project)
  )
  const emitAttributionReview = attributionReviewPrompts.length > 0
  const emitCodeGap =
    !hardPeerGaps.length &&
    codeToolReminderEnabled &&
    (emitAttributionReview || ctx.shouldEmitCodeDriftNotice(state, codeGaps))
  const suppressCodeGap =
    !hardPeerGaps.length && !emitCodeGap && ctx.isCodeDriftNoticeSuppressed(state, codeGaps)
  const deferredCodeGap =
    !hardPeerGaps.length &&
    !emitCodeGap &&
    codeGaps.some((gap) => !gap.reviewReady) &&
    !codeToolReminderEnabled
  const emitStagePeerGap = !hardPeerGaps.length && !emitCodeGap && stagePeerGaps.length > 0
  const emitPeerGaps = hardPeerGaps.length ? hardPeerGaps : emitStagePeerGap ? stagePeerGaps : []
  const peerSignature = emitPeerGaps.length ? ctx.peerDriftSignature(emitPeerGaps) : null
  const compactPeerGap =
    emitPeerGaps.length > 0 &&
    Boolean(state.peerDriftNotice?.active) &&
    state.peerDriftNotice.signature === peerSignature
  const compactCodeGap = emitCodeGap && Boolean(state.codeDriftNotice?.active)
  const carryOverFallback =
    !emitPeerGaps.length &&
    !emitCodeGap &&
    state.noEditSession &&
    !ctx.isDtsContextActive(state) &&
    ctx.shouldEmitCarryOverNotice(state, project)
      ? ctx.formatCarryOverReminder(project, { prefix: "[Carry-over] " })
      : ""
  if (emitPeerGaps.length) {
    ctx.markPeerDriftNoticeEmitted(state, emitPeerGaps)
  }
  if (emitCodeGap) {
    ctx.markCodeDriftNoticeEmitted(cwd, state, codeGaps)
  }
  if (carryOverFallback) {
    if (!state.firstEventAt) state.firstEventAt = new Date().toISOString()
    ctx.markCarryOverNoticeEmitted(state, project, "PostToolUse")
  }

  ctx.persistAndReport()

  if (emitPeerGaps.length) {
    ctx.writeDiagnosticLog(cwd, {
      event: emitPeerGaps.every((gap) => gap.stageOnly)
        ? "emit_peer_stage_reminder"
        : "emit_peer_enforcement",
      input: ctx.summarizeInput(input),
      file: ctx.rel(cwd, abs),
      tool,
      isEdit,
      ...ctx.summarizeGaps(cwd, peerGaps, codeGaps),
    })
    ctx.emitEnforcement(input, ctx.buildToolEnforcement(emitPeerGaps, { compact: compactPeerGap }))
  } else if (emitCodeGap) {
    ctx.writeDiagnosticLog(cwd, {
      event: emitAttributionReview
        ? "emit_attribution_review"
        : compactCodeGap
          ? "emit_code_reminder_compact"
          : "emit_code_tool_reminder",
      input: ctx.summarizeInput(input),
      file: ctx.rel(cwd, abs),
      tool,
      isEdit,
      attributionReviewSignatures: attributionReviewPrompts.map((item) => item.signature),
      ...ctx.summarizeGaps(cwd, peerGaps, codeGaps),
    })
    ctx.emitEnforcement(
      input,
      [
        ...attributionReviewPrompts.map((item) => item.prompt),
        ctx.buildCodeToolReminder(cwd, codeGaps, { compact: compactCodeGap }),
      ]
        .filter(Boolean)
        .join("\n\n")
    )
  } else if (ctx.SHOW_WARNINGS && warnings.length) {
    ctx.writeDiagnosticLog(cwd, {
      event: "emit_warning",
      input: ctx.summarizeInput(input),
      file: ctx.rel(cwd, abs),
      tool,
      warnings,
      ...ctx.summarizeGaps(cwd, peerGaps, codeGaps),
    })
    ctx.emitEnforcement(input, warnings.join("\n"))
  } else if (carryOverFallback) {
    ctx.writeDiagnosticLog(cwd, {
      event: "emit_carry_over_fallback",
      input: ctx.summarizeInput(input),
      file: ctx.rel(cwd, abs),
      tool,
      isEdit,
      messagePreview: ctx.limitString(carryOverFallback, 800),
      ...ctx.summarizeGaps(cwd, peerGaps, codeGaps),
    })
    ctx.emitEnforcement(input, carryOverFallback)
  } else {
    ctx.writeDiagnosticLog(cwd, {
      event: codeReviewNoEditConfirmed
        ? "posttooluse_code_review_no_edit_confirmed"
        : deferredCodeGap
          ? "posttooluse_code_review_deferred_to_checkpoint"
          : suppressCodeGap
          ? "posttooluse_code_review_reminder_suppressed"
          : "posttooluse_no_output",
      input: ctx.summarizeInput(input),
      file: ctx.rel(cwd, abs),
      tool,
      isEdit,
      ...(suppressCodeGap
        ? {
            codeReviewToolReminderCount: ctx.codeDriftNoticeEmissionCount(state),
            codeReviewToolMaxReminders: ctx.codeReviewToolMaxReminders(),
          }
        : {}),
      ...(deferredCodeGap
        ? {
            codeReviewToolMaxReminders: ctx.codeReviewToolMaxReminders(),
          }
        : {}),
      ...ctx.summarizeGaps(cwd, peerGaps, codeGaps),
    })
  }
}

module.exports = { handlePostToolUse }
