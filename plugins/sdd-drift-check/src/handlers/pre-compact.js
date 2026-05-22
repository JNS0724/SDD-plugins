const handlePreCompact = (input, ctx) => {
  const { state, project } = ctx
  if (project) ctx.applySessionToProject(ctx.cwd, project, state, ctx.sessionID)
  const summary = ctx.buildPreCompactSummary(project)
  ctx.persist()
  ctx.writeDiagnosticLog(ctx.cwd, {
    event: summary ? "precompact_summary_emit" : "precompact_no_pending",
    input: ctx.summarizeInput(input),
    messagePreview: summary ? ctx.limitString(summary, 800) : null,
  })
  if (summary) ctx.writeStdout(ctx.buildClaudeCodeOutput("PreCompact", summary))
}

module.exports = { handlePreCompact }
