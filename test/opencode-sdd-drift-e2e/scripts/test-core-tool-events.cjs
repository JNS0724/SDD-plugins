const assert = require("assert")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const pluginRoot = path.join(repoRoot, "plugins", "sdd-drift-check")
const core = require(path.join(pluginRoot, "src", "core", "tool-events.js"))
const claude = require(path.join(
  pluginRoot,
  "src",
  "adapters",
  "claude-code",
  "command-hook.js"
))
const opencode = require(path.join(
  pluginRoot,
  "src",
  "adapters",
  "opencode",
  "native-plugin.js"
))

assert.strictEqual(core.normalizeToolName("Multi-Edit"), "multiedit")
assert.strictEqual(core.getToolFilePath({ filePath: "src/app.ts" }), "src/app.ts")
assert.strictEqual(core.getToolFilePath({ file: "src/app.ts" }), "src/app.ts")
assert.strictEqual(core.isQuestionCheckpointTool("AskUserQuestion"), true)
assert.strictEqual(core.isQuestionCheckpointTool("question"), true)
assert.strictEqual(core.isSubagentCheckpointTool("background_output"), true)
assert.strictEqual(core.isSubagentCheckpointTool("background_task"), false)
assert.strictEqual(core.isSubagentCheckpointTool("unknown_agent"), false)
assert.strictEqual(core.isSupportedOpenCodeToolEvent("edit", { filePath: "src/app.ts" }), true)
assert.strictEqual(core.isSupportedOpenCodeToolEvent("edit", {}), false)
assert.strictEqual(core.isSupportedOpenCodeToolEvent("question", {}), true)

assert.strictEqual(claude.isQuestionCheckpointTool, core.isQuestionCheckpointTool)
assert.strictEqual(claude.isSubagentCheckpointTool, core.isSubagentCheckpointTool)
assert.strictEqual(opencode._private.normalizeToolName, core.normalizeToolName)
assert.strictEqual(opencode._private.normalizeToolArgs, core.normalizeToolArgs)
assert.strictEqual(opencode._private.isSupportedToolEvent, core.isSupportedOpenCodeToolEvent)
assert.deepStrictEqual(opencode._private.extractToolArgs({ parameters: { file: "src/params.ts" } }), {
  file: "src/params.ts",
  file_path: "src/params.ts",
})
assert.deepStrictEqual(opencode._private.extractToolArgs({ input: { filePath: "src/input.ts" } }), {
  filePath: "src/input.ts",
  file_path: "src/input.ts",
})
assert.deepStrictEqual(
  opencode._private.extractToolArgs(
    { tool: "edit", sessionID: "s1", callID: "c1" },
    { parameters: { path: "src/from-output.ts" } }
  ),
  {
    path: "src/from-output.ts",
    file_path: "src/from-output.ts",
  }
)
const stopPromptCache = new Map()
assert.strictEqual(opencode._private.shouldInjectStopPrompt(stopPromptCache, "s1", "review sdd", 1000), true)
assert.strictEqual(opencode._private.shouldInjectStopPrompt(stopPromptCache, "s1", "review sdd", 2000), false)
assert.strictEqual(opencode._private.shouldInjectStopPrompt(stopPromptCache, "s1", "review another", 3000), true)
assert.strictEqual(opencode._private.shouldInjectStopPrompt(stopPromptCache, "s1", "review sdd", 31000), true)

console.log("sdd-drift core tool-event tests passed")
