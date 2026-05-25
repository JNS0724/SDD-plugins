const assert = require("assert")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const { createOutputHelpers } = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "output.js"
))

const makeWriter = () => {
  const chunks = []
  return {
    chunks,
    write: (chunk) => {
      chunks.push(String(chunk))
      return true
    },
  }
}

{
  const helpers = createOutputHelpers({
    isOpenCodeHookInput: (input) => input?.hook_source === "opencode-plugin",
  })
  const output = JSON.parse(helpers.buildClaudeCodeOutput("PostToolUse", "sync tasks.md"))
  assert.strictEqual(output.hookSpecificOutput.hookEventName, "PostToolUse")
  assert.strictEqual(output.hookSpecificOutput.additionalContext, "sync tasks.md")

  const deny = JSON.parse(helpers.buildPreToolUseDenyOutput("review SDD first"))
  assert.strictEqual(deny.hookSpecificOutput.hookEventName, "PreToolUse")
  assert.strictEqual(deny.hookSpecificOutput.permissionDecision, "deny")
  assert.strictEqual(deny.hookSpecificOutput.permissionDecisionReason, "review SDD first")

  const claudeStop = JSON.parse(helpers.buildStopOutput({ hook_event_name: "Stop" }, "continue"))
  assert.deepStrictEqual(claudeStop, {
    decision: "block",
    reason: "continue",
  })

  const openCodeStop = JSON.parse(
    helpers.buildStopOutput({ hook_source: "opencode-plugin" }, "continue")
  )
  assert.strictEqual(openCodeStop.decision, "block")
  assert.strictEqual(openCodeStop.inject_prompt, "continue")
  assert.strictEqual(openCodeStop.stop_hook_active, true)
}

{
  const helpers = createOutputHelpers({
    isOpenCodeHookInput: () => true,
    opencodeStopReportOnly: true,
  })
  const output = JSON.parse(helpers.buildStopOutput({ hook_source: "opencode-plugin" }, "continue"))
  assert.deepStrictEqual(output, {
    decision: "approve",
    stop_hook_active: false,
    sdd_drift_report_only: true,
  })
}

{
  const stdout = makeWriter()
  const stderr = makeWriter()
  let exitCode = null
  const helpers = createOutputHelpers({
    isOpenCodeHookInput: () => false,
    strictBlock: true,
    stdout,
    stderr,
    exit: (code) => {
      exitCode = code
    },
  })
  helpers.emitEnforcement({ hook_event_name: "PostToolUse" }, "strict message")
  assert.deepStrictEqual(stdout.chunks, [])
  assert.deepStrictEqual(stderr.chunks, ["strict message"])
  assert.strictEqual(exitCode, 2)
}

console.log("sdd-drift core output tests passed")
