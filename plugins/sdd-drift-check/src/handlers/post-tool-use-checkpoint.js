const handlePostToolUseCheckpoint = (input, ctx, details) => {
  const { tool, toolInput } = details
  const { cwd, state, project } = ctx
  const subagentCheckpoint = ctx.isSubagentCheckpointTool(tool, toolInput)
  const questionCheckpoint = ctx.isQuestionCheckpointTool(tool)
  const checkpoint = subagentCheckpoint || questionCheckpoint
  if (checkpoint && !ctx.markToolEvent(state, ctx.getToolEventKey(input))) {
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(cwd, {
      event: "ignored_duplicate_checkpoint_event",
      input: ctx.summarizeInput(input),
      tool,
      subagentCheckpoint,
      questionCheckpoint,
    })
    return
  }

  const hydratedFromCheckpointOutput = subagentCheckpoint
    ? ctx.hydrateStateFromCheckpointOutput(cwd, state, input)
    : false
  if (project) ctx.applySessionToProject(cwd, project, state, ctx.sessionID)
  const pending = subagentCheckpoint
    ? ctx.buildSubagentCheckpointEnforcement(cwd, state, project)
    : questionCheckpoint
      ? ctx.buildQuestionCheckpointEnforcement(cwd, state, project)
      : null
  ctx.clearSubagentCheckpointNoticeIfResolved(state, pending)
  if (pending && ctx.shouldEmitSubagentCheckpointNotice(state, pending)) {
    ctx.markSubagentCheckpointNoticeEmitted(state, pending, tool)
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(cwd, {
      event: questionCheckpoint
        ? "emit_question_checkpoint_enforcement"
        : "emit_subagent_checkpoint_enforcement",
      input: ctx.summarizeInput(input),
      tool,
      subagentCheckpoint,
      questionCheckpoint,
      hydratedFromCheckpointOutput,
      pendingType: pending.type,
      pendingSignature: pending.signature,
      messagePreview: ctx.limitString(pending.message, 800),
    })
    ctx.emitEnforcement(input, pending.message)
    return
  }

  const carryOverFallback =
    state.noEditSession &&
    !ctx.isDtsContextActive(state) &&
    ctx.shouldEmitCarryOverNotice(state, project)
      ? ctx.formatCarryOverReminder(project, { prefix: "[Carry-over] " })
      : ""
  if (carryOverFallback) {
    if (!state.firstEventAt) state.firstEventAt = new Date().toISOString()
    ctx.markCarryOverNoticeEmitted(state, project, "PostToolUse")
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(cwd, {
      event: "emit_carry_over_fallback",
      input: ctx.summarizeInput(input),
      tool,
      subagentCheckpoint,
      questionCheckpoint,
      hydratedFromCheckpointOutput,
      messagePreview: ctx.limitString(carryOverFallback, 800),
    })
    ctx.emitEnforcement(input, carryOverFallback)
    return
  }

  ctx.persistAndReport()
  ctx.writeDiagnosticLog(cwd, {
    event: "ignored_no_file_path",
    input: ctx.summarizeInput(input),
    tool,
    subagentCheckpoint,
    questionCheckpoint,
    hydratedFromCheckpointOutput,
    pendingCheckpoint: Boolean(pending),
  })
}

module.exports = { handlePostToolUseCheckpoint }
