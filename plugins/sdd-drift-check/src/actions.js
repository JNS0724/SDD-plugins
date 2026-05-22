const ACTION_ORDER = ["log", "save_project", "save_session", "refresh_report", "emit_message"]

const Actions = {
  log: (event) => ({ type: "log", event }),
  saveProject: () => ({ type: "save_project" }),
  saveSession: () => ({ type: "save_session" }),
  refreshReport: () => ({ type: "refresh_report" }),
  emitMessage: (payload) => ({ type: "emit_message", payload }),
}

const runOneAction = async (action, ctx) => {
  if (!action || !action.type) return
  switch (action.type) {
    case "log":
      await ctx.log?.(action.event)
      break
    case "save_project":
      await ctx.saveProject?.()
      break
    case "save_session":
      await ctx.saveSession?.()
      break
    case "refresh_report":
      await ctx.refreshReport?.()
      break
    case "emit_message":
      await ctx.emitMessage?.(action.payload)
      break
    default:
      await ctx.unsupportedAction?.(action)
      break
  }
}

const runActions = async (actions, ctx) => {
  const buckets = Object.fromEntries(ACTION_ORDER.map((type) => [type, []]))
  for (const action of actions || []) {
    if (!action || !buckets[action.type]) continue
    buckets[action.type].push(action)
  }

  for (const type of ACTION_ORDER) {
    for (const action of buckets[type]) {
      await runOneAction(action, ctx)
    }
  }
}

module.exports = {
  ACTION_ORDER,
  Actions,
  runActions,
}
