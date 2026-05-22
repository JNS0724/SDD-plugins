const handlePreToolUse = (input, ctx) => {
  const tool = String(input.tool_name || "").toLowerCase()
  const toolInput = input.tool_input || {}
  const fp = ctx.getToolFilePath(toolInput)

  if (fp && typeof fp === "string") {
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(ctx.cwd, {
      event: "ignored_pretooluse_file_path",
      input: ctx.summarizeInput(input),
      tool,
      file: fp,
    })
    return
  }

  const questionCheckpoint = ctx.isQuestionCheckpointTool(tool)
  if (questionCheckpoint && !ctx.markToolEvent(ctx.state, ctx.getToolEventKey(input))) {
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(ctx.cwd, {
      event: "ignored_duplicate_checkpoint_event",
      input: ctx.summarizeInput(input),
      tool,
      subagentCheckpoint: false,
      questionCheckpoint,
    })
    return
  }

  const pending = questionCheckpoint
    ? ctx.buildQuestionCheckpointEnforcement(ctx.cwd, ctx.state, ctx.project)
    : null
  ctx.clearSubagentCheckpointNoticeIfResolved(ctx.state, pending)
  if (pending && ctx.shouldEmitSubagentCheckpointNotice(ctx.state, pending)) {
    ctx.markSubagentCheckpointNoticeEmitted(ctx.state, pending, tool)
    ctx.persistAndReport()
    ctx.writeDiagnosticLog(ctx.cwd, {
      event: "emit_question_checkpoint_enforcement",
      input: ctx.summarizeInput(input),
      tool,
      subagentCheckpoint: false,
      questionCheckpoint,
      hydratedFromCheckpointOutput: false,
      pendingType: pending.type,
      pendingSignature: pending.signature,
      messagePreview: ctx.limitString(pending.message, 800),
    })
    ctx.emitEnforcement(input, pending.message)
    return
  }

  ctx.persistAndReport()
  ctx.writeDiagnosticLog(ctx.cwd, {
    event: "ignored_no_file_path",
    input: ctx.summarizeInput(input),
    tool,
    subagentCheckpoint: false,
    questionCheckpoint,
    hydratedFromCheckpointOutput: false,
    pendingCheckpoint: Boolean(pending),
  })
}

module.exports = { handlePreToolUse }
