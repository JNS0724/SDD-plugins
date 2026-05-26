const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const pluginRoot = path.join(repoRoot, "plugins", "sdd-drift-check")

const claudeSource = path.join(pluginRoot, "src", "adapters", "claude-code", "command-hook.js")
const opencodeSource = path.join(pluginRoot, "src", "adapters", "opencode", "native-plugin.js")
const legacySource = path.join(pluginRoot, "src", "index.js")
const claudeArtifact = path.join(pluginRoot, "sdd-drift-check-hook.js")
const opencodeArtifact = path.join(pluginRoot, "sdd-drift-check-opencode.js")
const rulesArtifact = path.join(pluginRoot, "sdd-drift-check-rules.md")

for (const fp of [claudeSource, opencodeSource, legacySource, claudeArtifact, opencodeArtifact, rulesArtifact]) {
  assert.ok(fs.statSync(fp).isFile(), `expected adapter path to exist: ${fp}`)
}

const legacy = require(legacySource)
const claude = require(claudeSource)
const claudeDist = require(claudeArtifact)
const opencode = require(opencodeSource)
const opencodeDist = require(opencodeArtifact)
const opencodeArtifactText = fs.readFileSync(opencodeArtifact, "utf8")

assert.strictEqual(legacy.handleStop, claude.handleStop)
assert.strictEqual(typeof claudeDist.handleStop, "function")
assert.strictEqual(typeof claudeDist.handlePostToolUse, "function")
assert.strictEqual(typeof claudeDist.runHookInput, "function")
assert.strictEqual(typeof opencode.SddDriftCheckOpenCode, "function")
assert.strictEqual(typeof opencodeDist.SddDriftCheckOpenCode, "function")
assert.strictEqual(typeof opencodeDist._private.buildPostToolUseInput, "function")
assert.strictEqual(typeof opencodeDist._private.runNativeHook, "function")
assert.ok(!opencodeArtifactText.includes("node:child_process"))
assert.ok(!opencodeArtifactText.includes("SDD_DRIFT_HOOK_SCRIPT"))

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-dist-rules-"))
const isolatedDir = path.join(isolatedRoot, "arbitrary", "opencode", "plugin-dir")
const isolatedArtifact = path.join(isolatedDir, "sdd-drift-check-hook.js")
const isolatedRules = path.join(isolatedDir, "sdd-drift-check-rules.md")
const parentBaitRules = path.join(isolatedRoot, "sdd-drift-check-rules.md")
const previousRulesFile = process.env.SDD_DRIFT_RULES_FILE
delete process.env.SDD_DRIFT_RULES_FILE

try {
  fs.mkdirSync(isolatedDir, { recursive: true })
  fs.writeFileSync(
    parentBaitRules,
    [
      "# 父级诱饵规则",
      "## SDD 编辑规则",
      "- DIST BAIT RULE SHOULD NOT LOAD",
      "",
    ].join("\n")
  )
  fs.copyFileSync(claudeArtifact, isolatedArtifact)
  const isolatedDist = require(isolatedArtifact)
  const peerGaps = [
    {
      relDir: "sdd/changes/isolated",
      edited: ["design.md"],
      sourceFiles: ["design.md"],
      stageOnly: false,
      absent: [],
      unsynced: ["tasks.md"],
      stale: [],
      required: ["tasks.md"],
    },
  ]

  const defaultPrompt = isolatedDist.buildToolEnforcement(peerGaps)
  assert.match(defaultPrompt, /不要新增章节。/)
  assert.match(defaultPrompt, /不要重写文档模板。/)
  assert.doesNotMatch(defaultPrompt, /DIST BAIT RULE SHOULD NOT LOAD/)

  fs.writeFileSync(
    isolatedRules,
    [
      "# 自定义规则",
      "## SDD 编辑规则",
      "- DIST CUSTOM RULE ONE",
      "## 退出标准",
      "- DIST CUSTOM EXIT ONE",
      "",
    ].join("\n")
  )
  const firstCustomPrompt = isolatedDist.buildToolEnforcement(peerGaps)
  assert.match(firstCustomPrompt, /DIST CUSTOM RULE ONE/)
  assert.match(firstCustomPrompt, /DIST CUSTOM EXIT ONE/)
  assert.doesNotMatch(firstCustomPrompt, /不要新增章节。/)

  fs.writeFileSync(
    isolatedRules,
    [
      "# 自定义规则",
      "## SDD 编辑规则",
      "- DIST CUSTOM RULE TWO",
      "## 退出标准",
      "- DIST CUSTOM EXIT TWO",
      "",
    ].join("\n")
  )
  const secondCustomPrompt = isolatedDist.buildToolEnforcement(peerGaps)
  assert.match(secondCustomPrompt, /DIST CUSTOM RULE TWO/)
  assert.match(secondCustomPrompt, /DIST CUSTOM EXIT TWO/)
  assert.doesNotMatch(secondCustomPrompt, /DIST CUSTOM RULE ONE/)
} finally {
  if (previousRulesFile === undefined) {
    delete process.env.SDD_DRIFT_RULES_FILE
  } else {
    process.env.SDD_DRIFT_RULES_FILE = previousRulesFile
  }
  fs.rmSync(isolatedRoot, { recursive: true, force: true })
}

console.log("sdd-drift adapter structure tests passed")
