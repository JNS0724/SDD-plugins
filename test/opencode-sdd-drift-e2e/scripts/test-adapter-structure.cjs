const assert = require("assert")
const fs = require("fs")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const pluginRoot = path.join(repoRoot, "plugins", "sdd-drift-check")

const claudeSource = path.join(pluginRoot, "src", "adapters", "claude-code", "command-hook.js")
const opencodeSource = path.join(pluginRoot, "src", "adapters", "opencode", "native-plugin.js")
const legacySource = path.join(pluginRoot, "src", "index.js")
const claudeArtifact = path.join(pluginRoot, "sdd-drift-check-hook.js")
const opencodeArtifact = path.join(pluginRoot, "sdd-drift-check-opencode.js")

for (const fp of [claudeSource, opencodeSource, legacySource, claudeArtifact, opencodeArtifact]) {
  assert.ok(fs.statSync(fp).isFile(), `expected adapter path to exist: ${fp}`)
}

const legacy = require(legacySource)
const claude = require(claudeSource)
const claudeDist = require(claudeArtifact)
const opencode = require(opencodeSource)
const opencodeDist = require(opencodeArtifact)

assert.strictEqual(legacy.handleStop, claude.handleStop)
assert.strictEqual(typeof claudeDist.handleStop, "function")
assert.strictEqual(typeof claudeDist.handlePostToolUse, "function")
assert.strictEqual(typeof opencode.SddDriftCheckOpenCode, "function")
assert.strictEqual(typeof opencodeDist.SddDriftCheckOpenCode, "function")
assert.strictEqual(typeof opencodeDist._private.buildPostToolUseInput, "function")

console.log("sdd-drift adapter structure tests passed")
