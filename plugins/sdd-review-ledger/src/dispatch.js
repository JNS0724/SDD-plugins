"use strict"

const { findRepoRoot } = require("./core/state-dir")
const { onEdit } = require("./handlers/on-edit")
const { onPrompt } = require("./handlers/on-prompt")
const { buildHookOutput } = require("./core/output")

// Map a Claude Code hook event → handler → stdout string. Given the event + env,
// returns { stdout }. Fail-open: any error → "" (silent), and the entry exits 0.

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"])

const editedPathFromEvent = (event) => {
  const ti = (event && event.tool_input) || {}
  if (ti.file_path) return ti.file_path
  if (Array.isArray(ti.edits) && ti.edits.length && ti.edits[0].file_path) return ti.edits[0].file_path
  return undefined
}

const dispatch = (event, env = process.env) => {
  try {
    const hookName = (event && (event.hook_event_name || event.hookEventName)) || ""
    const cwd = (event && event.cwd) || env.CLAUDE_PROJECT_DIR || process.cwd()
    const repoRoot = findRepoRoot(cwd)
    const baseCtx = { repoRoot, event, env, actor: "agent" }

    let res
    if (hookName === "PostToolUse") {
      const toolName = (event && event.tool_name) || ""
      if (!WRITE_TOOLS.has(toolName)) return { stdout: "" } // Read etc. → silent
      res = onEdit({ ...baseCtx, editedPath: editedPathFromEvent(event) })
    } else if (hookName === "UserPromptSubmit") {
      res = onPrompt(baseCtx)
    } else {
      return { stdout: "" }
    }

    if (!res || !res.deliver || !res.text) return { stdout: "" }
    return { stdout: buildHookOutput(event, res.text) }
  } catch {
    return { stdout: "" } // NFR: never throw to the user
  }
}

module.exports = { WRITE_TOOLS, editedPathFromEvent, dispatch }
