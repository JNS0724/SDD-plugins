"use strict"

// Claude Code hook output. For UserPromptSubmit / PostToolUse, inject text as
// additionalContext (model-visible). Otherwise fall back to systemMessage.
// Ported from sibling sdd-drift-check/src/core/output.js.

const ADDITIONAL_CONTEXT_EVENTS = new Set(["UserPromptSubmit", "PostToolUse"])

const buildHookOutput = (event, text) => {
  if (!text) return ""
  const hookEventName = (event && (event.hook_event_name || event.hookEventName)) || ""
  if (ADDITIONAL_CONTEXT_EVENTS.has(hookEventName)) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } })
  }
  return JSON.stringify({ systemMessage: text })
}

module.exports = { ADDITIONAL_CONTEXT_EVENTS, buildHookOutput }
