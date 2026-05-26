const handleUserPromptSubmit = (input, ctx) => {
  const { state, project } = ctx
  const isFirstEvent = !state.firstEventAt
  if (isFirstEvent) state.firstEventAt = new Date().toISOString()
  if (project) ctx.applySessionToProject(ctx.cwd, project, state, ctx.sessionID)
  const reminder =
    isFirstEvent && !ctx.isDtsContextActive(state) && ctx.shouldEmitCarryOverNotice(state, project)
      ? ctx.formatCarryOverReminder(project)
      : ""
  if (reminder) ctx.markCarryOverNoticeEmitted(state, project, input.hook_event_name)
  ctx.persist()
  ctx.writeDiagnosticLog(ctx.cwd, {
    event: reminder ? "carry_over_emitted" : "user_prompt_context_captured",
    input: ctx.summarizeInput(input),
    firstEvent: isFirstEvent,
    messagePreview: reminder ? ctx.limitString(reminder, 800) : null,
  })
  if (reminder && input.hook_event_name === "UserPromptSubmit") {
    ctx.writeStdout(ctx.buildClaudeCodeOutput("UserPromptSubmit", reminder))
  }
}

module.exports = { handleUserPromptSubmit }
