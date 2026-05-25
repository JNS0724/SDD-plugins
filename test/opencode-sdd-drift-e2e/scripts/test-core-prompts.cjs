const assert = require("assert")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const prompts = require(path.join(repoRoot, "plugins", "sdd-drift-check", "src", "core", "prompts.js"))

const cwd = path.join("E:", "work", "repo")
const peerGaps = [
  {
    relDir: "sdd/changes/feat-a",
    edited: ["design.md"],
    sourceFiles: ["design.md"],
    stageOnly: false,
    absent: [],
    unsynced: ["tasks.md"],
    stale: [],
    required: ["tasks.md"],
  },
]
const codeGaps = [
  {
    codeFiles: [path.join(cwd, "src", "feature.ts")],
    latestCodeSeq: 3,
    reviewTargets: [
      path.join(cwd, "sdd", "changes", "feat-a", "design.md"),
      path.join(cwd, "sdd", "changes", "feat-a", "tasks.md"),
    ],
    pendingReviewTargets: [path.join(cwd, "sdd", "changes", "feat-a", "design.md")],
    reviewReady: false,
    needsConfirmation: false,
  },
]

const peerPrompt = prompts.buildToolEnforcement(peerGaps)
assert.match(peerPrompt, /SDD drift tool result enforcement/)
assert.match(peerPrompt, /Do not add new sections\./)
assert.match(peerPrompt, /Do not rewrite the document template\./)
assert.match(peerPrompt, /Find the existing section that should change and edit that section only\./)
assert.match(peerPrompt, /SDD review is a checkpoint inside the current task, not the final task\./)
assert.match(
  peerPrompt,
  /After the SDD review or synchronization is complete, return to the original user task\./
)

const codePrompt = prompts.buildCodeEnforcement(cwd, codeGaps)
assert.match(codePrompt, /implementation code/)
assert.match(codePrompt, /src[\\/]feature\.ts/)
assert.match(codePrompt, /Do not add new sections\./)
assert.match(codePrompt, /read-only review subagent/)

const checkpoint = prompts.buildQuestionCheckpointMessage("inner reminder")
assert.match(checkpoint, /SDD drift question checkpoint/)
assert.match(checkpoint, /inner reminder/)
assert.match(checkpoint, /return to the original user task/)

const signatureA = prompts.peerDriftSignature(peerGaps)
const signatureB = prompts.peerDriftSignature([
  {
    ...peerGaps[0],
    required: ["tasks.md"],
    unsynced: ["tasks.md"],
  },
])
assert.strictEqual(signatureA, signatureB)

console.log("sdd-drift core prompt tests passed")
