const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const hydration = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "hydration.js"
))
const sessionState = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "session-state.js"
))

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-hydration-"))
fs.mkdirSync(path.join(cwd, ".git"), { recursive: true })
fs.mkdirSync(path.join(cwd, "sdd", "changes", "feat-a"), { recursive: true })
const codePath = path.join(cwd, "src", "feature.ts")
fs.mkdirSync(path.dirname(codePath), { recursive: true })
fs.writeFileSync(codePath, "export const value = 1\n")
fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true })
const ignoredPath = path.join(cwd, "node_modules", "ignored.ts")
fs.writeFileSync(ignoredPath, "export const ignored = 1\n")

const text = hydration.collectCheckpointOutputText({
  tool_result: {
    content: [
      "Files changed:",
      "- src/feature.ts",
      "- node_modules/ignored.ts",
    ],
  },
})
assert.match(text, /src\/feature\.ts/)

const edited = hydration.extractCheckpointEditedPaths(cwd, text)
assert.deepStrictEqual(edited, [path.normalize(codePath)])

{
  const state = sessionState.emptyState()
  const changed = hydration.hydrateStateFromCheckpointOutput(cwd, state, {
    tool_name: "Task",
    tool_result: text,
  })
  assert.strictEqual(changed, true)
  assert.ok(state.edited.some((file) => path.normalize(file) === path.normalize(codePath)))
}

{
  const state = sessionState.emptyState()
  const transcriptPath = path.join(cwd, "transcript.jsonl")
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "tool_result",
      tool_name: "Edit",
      tool_input: { file_path: codePath },
    })}\n`
  )

  assert.strictEqual(hydration.hydrateStateFromTranscript(cwd, state, transcriptPath), true)
  assert.strictEqual(sessionState.editedSeq(state, codePath) > 0, true)
  assert.strictEqual(hydration.hydrateStateFromTranscript(cwd, state, transcriptPath), false)
}

console.log("sdd-drift core hydration tests passed")
