const createOutputHelpers = ({
  isOpenCodeHookInput,
  opencodeStopReportOnly = false,
  strictBlock = false,
  stdout = process.stdout,
  stderr = process.stderr,
  exit = process.exit,
} = {}) => {
  if (typeof isOpenCodeHookInput !== "function") {
    throw new TypeError("isOpenCodeHookInput is required")
  }

  const buildClaudeCodeOutput = (hookEventName, message) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEventName || "PostToolUse",
        additionalContext: message,
      },
    })

  const buildPreToolUseDenyOutput = (message) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
        additionalContext: message,
      },
    })

  const buildStopOutput = (input, message) => {
    if (isOpenCodeHookInput(input)) {
      if (opencodeStopReportOnly) {
        return JSON.stringify({
          decision: "approve",
          stop_hook_active: false,
          sdd_drift_report_only: true,
        })
      }
      return JSON.stringify({
        decision: "block",
        reason:
          "SDD drift check found pending SDD synchronization or review. Attempting OpenCode Stop continuation; see .sdd-drift-report.md if the session does not continue.",
        inject_prompt: message,
        stop_hook_active: true,
      })
    }
    return JSON.stringify({
      decision: "block",
      reason: message,
    })
  }

  const emitEnforcement = (input, message) => {
    if (strictBlock) {
      stderr.write(message)
      exit(2)
      return
    }
    if (input?.hook_event_name === "PreToolUse") {
      stdout.write(buildPreToolUseDenyOutput(message))
      return
    }
    if (isOpenCodeHookInput(input)) {
      stdout.write(message)
      return
    }
    stdout.write(buildClaudeCodeOutput(input?.hook_event_name, message))
  }

  const emitStopEnforcement = (input, message) => {
    if (strictBlock) {
      stderr.write(message)
      exit(2)
      return
    }
    stdout.write(buildStopOutput(input, message))
  }

  return {
    buildClaudeCodeOutput,
    buildPreToolUseDenyOutput,
    buildStopOutput,
    emitEnforcement,
    emitStopEnforcement,
  }
}

module.exports = {
  createOutputHelpers,
}
