const makeHandlerSpec = (requiresSession, requiresProject, lockPolicy, handle) => ({
  requiresSession,
  requiresProject,
  lockPolicy,
  handle,
})

const createHookHandlers = (handlers = {}) => ({
  PreToolUse: makeHandlerSpec(
    "write",
    "read",
    { sessionWait: 1000, projectWait: 500 },
    handlers.PreToolUse
  ),
  PostToolUse: makeHandlerSpec(
    "write",
    "write",
    { sessionWait: 5000, projectWait: 2000 },
    handlers.PostToolUse
  ),
  Stop: makeHandlerSpec(
    "write",
    "write",
    { sessionWait: 5000, projectWait: 2000 },
    handlers.Stop
  ),
  UserPromptSubmit: makeHandlerSpec(
    "write",
    "read",
    { sessionWait: 1000, projectWait: 500 },
    handlers.UserPromptSubmit
  ),
  PreCompact: makeHandlerSpec(
    "read",
    "read",
    { sessionWait: 500, projectWait: 500 },
    handlers.PreCompact
  ),
})

const HookHandlers = createHookHandlers()

module.exports = {
  HookHandlers,
  createHookHandlers,
}
