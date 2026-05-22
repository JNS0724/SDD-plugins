const handleStop = (input, ctx) => {
  const { cwd, state, project } = ctx
  const transcriptPath = ctx.transcriptPathForContext
  const hydrated = ctx.hydrateStateFromTranscript(cwd, state, transcriptPath)
  if (project) ctx.applySessionToProject(cwd, project, state, ctx.sessionID)
  let pending = ctx.buildPendingEnforcement(cwd, state, { includeStageOnly: false, project })
  if (ctx.markImplementationFlowConfirmation(cwd, state, pending, project)) {
    ctx.refreshAlignedBaseline(cwd, project, state)
    pending = ctx.buildPendingEnforcement(cwd, state, { includeStageOnly: false, project })
  }
  if (!pending) {
    const attributionReadOnlyResolved = ctx.resolveReadOnlyAttributionReviews(state)
    state.stopBlocks = {}
    ctx.clearPeerSyncs(state)
    ctx.clearStageOnlyRequirements(state)
    ctx.refreshAlignedBaseline(cwd, project, state)
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(cwd, {
      event: "stop_allow_no_pending",
      input: ctx.summarizeInput(input),
      transcriptPath: transcriptPath ? ctx.limitString(transcriptPath) : null,
      hydrated,
      attributionReadOnlyResolved,
    })
    return
  }

  const reviewConfirmationReady =
    pending.type === "code" &&
    (pending.gaps || []).length > 0 &&
    (pending.gaps || []).every((gap) => gap.needsConfirmation && gap.reviewReady)
  if (ctx.markStopCodeReviewConfirmation(state, pending)) {
    const attributionReadOnlyResolved = ctx.resolveReadOnlyAttributionReviews(state)
    state.stopBlocks = {}
    ctx.clearPeerSyncs(state)
    ctx.refreshAlignedBaseline(cwd, project, state)
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(cwd, {
      event: "stop_allow_review_confirmed",
      input: ctx.summarizeInput(input),
      pendingType: pending.type,
      pendingSignature: pending.signature,
      transcriptPath: transcriptPath ? ctx.limitString(transcriptPath) : null,
      hydrated,
      attributionReadOnlyResolved,
    })
    return
  }

  ctx.refreshReport(cwd, state, project)

  if (ctx.isOpenCodeHookInput(input) && ctx.OPENCODE_STOP_REPORT_ONLY) {
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(cwd, {
      event: "stop_opencode_report_only",
      input: ctx.summarizeInput(input),
      pendingType: pending.type,
      pendingSignature: pending.signature,
      transcriptPath: transcriptPath ? ctx.limitString(transcriptPath) : null,
      hydrated,
      messagePreview: ctx.limitString(pending.message, 800),
    })
    return
  }

  const configuredMaxBlocks =
    pending.type === "code" ? ctx.CODE_REVIEW_STOP_MAX_BLOCKS : ctx.STOP_MAX_BLOCKS
  const maxBlocks = Number.isFinite(configuredMaxBlocks)
    ? Math.max(0, configuredMaxBlocks)
    : pending.type === "code"
      ? 1
      : 2
  const blockCount = state.stopBlocks[pending.signature] || 0
  if (blockCount >= maxBlocks) {
    const attributionUnrelatedAccepted = ctx.acceptUnresolvedAttributionReviews(state)
    ctx.persist()
    if (attributionUnrelatedAccepted) {
      ctx.writeDiagnosticLog(cwd, {
        event: "attribution_unrelated_accepted",
        input: ctx.summarizeInput(input),
        pendingType: pending.type,
        pendingSignature: pending.signature,
        blockCount,
        maxBlocks,
      })
    }
    ctx.writeDiagnosticLog(cwd, {
      event: "stop_allow_max_blocks",
      input: ctx.summarizeInput(input),
      pendingType: pending.type,
      pendingSignature: pending.signature,
      blockCount,
      maxBlocks,
      attributionUnrelatedAccepted,
    })
    return
  }

  state.stopBlocks[pending.signature] = blockCount + 1
  ctx.persist()
  ctx.writeDiagnosticLog(cwd, {
    event: reviewConfirmationReady ? "stop_review_confirmation_requested" : "stop_block_emit",
    input: ctx.summarizeInput(input),
    pendingType: pending.type,
    pendingSignature: pending.signature,
    blockCount: blockCount + 1,
    maxBlocks,
    messagePreview: ctx.limitString(pending.message, 800),
  })
  ctx.emitStopEnforcement(input, ctx.buildStopEnforcement(pending.message))
}

module.exports = { handleStop }
