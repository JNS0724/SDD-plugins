const { handlePreCompact } = require("./handlers/pre-compact")
const { handlePreToolUse } = require("./handlers/pre-tool-use")
const { handlePostToolUse } = require("./handlers/post-tool-use")
const { handleStop } = require("./handlers/stop")
const { handleUserPromptSubmit } = require("./handlers/user-prompt-submit")

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

const HookHandlers = createHookHandlers({
  PreCompact: handlePreCompact,
  PostToolUse: handlePostToolUse,
  PreToolUse: handlePreToolUse,
  Stop: handleStop,
  UserPromptSubmit: handleUserPromptSubmit,
})

module.exports = {
  HookHandlers,
  createHookHandlers,
}
