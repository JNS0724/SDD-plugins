const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const session = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "session-state.js"
))
const { normalizeKey } = require(path.join(repoRoot, "plugins", "sdd-drift-check", "src", "core", "paths.js"))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-session-"))
fs.mkdirSync(path.join(tmp, ".git"), { recursive: true })
const changeDir = path.join(tmp, "sdd", "changes", "feat-a")
fs.mkdirSync(changeDir, { recursive: true })
const designPath = path.join(changeDir, "design.md")
const tasksPath = path.join(changeDir, "tasks.md")
fs.writeFileSync(designPath, "# Design\n")
fs.writeFileSync(tasksPath, "# Tasks\n")

const state = session.emptyState()
assert.strictEqual(state.noEditSession, true)
assert.strictEqual(session.applyToolRecord(tmp, state, "Read", { file_path: designPath }), true)
assert.strictEqual(session.touchedSeq(state, designPath), 1)

assert.strictEqual(session.applyToolRecord(tmp, state, "Edit", { file_path: designPath }), true)
assert.strictEqual(state.noEditSession, false)
const req = session.getRequirementBucket(state, changeDir, false)
assert.ok(req.files["tasks.md"])
assert.strictEqual(req.files["tasks.md"].sourceFile, "design.md")

assert.strictEqual(session.applyToolRecord(tmp, state, "Edit", { file_path: tasksPath }), true)
assert.strictEqual(session.getRequirementBucket(state, changeDir, false), undefined)
const sync = session.getPeerSyncBucket(state, changeDir, false)
assert.strictEqual(sync.files["tasks.md"].sourceFile, "design.md")
assert.ok(session.hasEditedSddChange(state))

assert.strictEqual(session.markToolEvent(state, "event-1"), true)
assert.strictEqual(session.markToolEvent(state, "event-1"), false)
assert.strictEqual(session.markTranscriptEvent(state, "transcript-1"), true)
assert.strictEqual(session.markTranscriptEvent(state, "transcript-1"), false)

session.saveState(tmp, "session-a", state)
const loaded = session.loadState(tmp, "session-a")
assert.ok(loaded.files[normalizeKey(designPath)])
assert.ok(loaded.files[normalizeKey(tasksPath)])

session.clearPeerSyncs(loaded)
assert.deepStrictEqual(loaded.peerSyncs, {})

console.log("sdd-drift core session-state tests passed")
