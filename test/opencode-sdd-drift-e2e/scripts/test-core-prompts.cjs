const assert = require("assert")
const fs = require("fs")
const os = require("os")
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
assert.match(peerPrompt, /<system-reminder>/)
assert.match(peerPrompt, /\[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - PEER SYNC CHECKPOINT\]/)
assert.match(peerPrompt, /\nSTATE\n/)
assert.match(peerPrompt, /\nREQUIRED ACTION\n/)
assert.match(peerPrompt, /\nSDD EDIT RULES\n/)
assert.match(peerPrompt, /\nEXIT CRITERIA\n/)
assert.match(peerPrompt, /SDD drift tool result enforcement/)
assert.match(peerPrompt, /不要新增章节。/)
assert.match(peerPrompt, /不要重写文档模板。/)
assert.match(peerPrompt, /找到最应该变更的已有章节，只修改该位置。/)
assert.match(peerPrompt, /SDD 评审是当前任务中的检查点，不是最终任务本身。/)
assert.match(peerPrompt, /SDD 评审或同步完成后，回到原始用户任务。/)

const codePrompt = prompts.buildCodeEnforcement(cwd, codeGaps)
assert.match(codePrompt, /\[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - CODE REVIEW CHECKPOINT\]/)
assert.match(codePrompt, /\nALIGNMENT RULES\n/)
assert.match(codePrompt, /implementation code/)
assert.match(codePrompt, /src[\\/]feature\.ts/)
assert.match(codePrompt, /不要新增章节。/)
assert.match(codePrompt, /只读评审 subagent/)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-prompt-rules-"))
const customRules = path.join(tmp, "sdd-drift-check-rules.md")
const previousRulesFile = process.env.SDD_DRIFT_RULES_FILE
fs.writeFileSync(
  customRules,
  [
    "# Custom rules",
    "## SDD EDIT RULES",
    "- CUSTOM SDD EDIT RULE: preserve the user-owned template.",
    "## Active SDD Alignment Rules",
    "- CUSTOM ALIGNMENT RULE: code facts must match active SDD.",
    "## Attribution Review Rules",
    "- CUSTOM ATTRIBUTION RULE: choose the closest active change.",
    "## Subagent Review Rule",
    "- CUSTOM SUBAGENT RULE: use a read-only reviewer when available.",
    "## Exit Criteria",
    "- CUSTOM EXIT RULE: return to the original task after SDD review.",
    "",
  ].join("\n")
)
process.env.SDD_DRIFT_RULES_FILE = customRules
try {
  const customPrompt = prompts.buildCodeEnforcement(cwd, codeGaps)
  assert.match(customPrompt, /CUSTOM SDD EDIT RULE/)
  assert.match(customPrompt, /CUSTOM ALIGNMENT RULE/)
  assert.match(customPrompt, /CUSTOM ATTRIBUTION RULE/)
  assert.match(customPrompt, /CUSTOM SUBAGENT RULE/)
  assert.match(customPrompt, /CUSTOM EXIT RULE/)
  assert.doesNotMatch(customPrompt, /不要新增章节。/)
} finally {
  if (previousRulesFile === undefined) {
    delete process.env.SDD_DRIFT_RULES_FILE
  } else {
    process.env.SDD_DRIFT_RULES_FILE = previousRulesFile
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

const checkpoint = prompts.buildQuestionCheckpointMessage("inner reminder")
assert.match(checkpoint, /\[SYSTEM DIRECTIVE: SDD-DRIFT-CHECK - QUESTION CHECKPOINT\]/)
assert.match(checkpoint, /\nPENDING SDD REMINDER\n/)
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
