const assert = require("assert")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const config = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "runtime-config.js"
))

assert.strictEqual(config.STOP_MAX_BLOCKS, 2)
assert.strictEqual(config.CODE_REVIEW_STOP_MAX_BLOCKS, 1)
assert.strictEqual(config.CODE_REVIEW_TOOL_MAX_REMINDERS, 1)
assert.strictEqual(config.CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS, 1)
assert.strictEqual(config.DIAGNOSTIC_LOG, true)
assert.strictEqual(config.DIAGNOSTIC_LOG_RETENTION_DAYS, 3)
assert.strictEqual(config.TOOL_EVENT_CAP, 200)
assert.strictEqual(config.TRANSCRIPT_EVENT_CAP, 2000)
assert.strictEqual(config.CODE_REVIEW_CONFIRMATION_CAP, 50)
assert.strictEqual(config.CHECKPOINT_OUTPUT_TEXT_MAX_BYTES, 64 * 1024)
assert.strictEqual(config.STATE_LOCK_STALE_MS, 30 * 1000)
assert.strictEqual(config.PROJECT_LOCK_WAIT_MS, 2 * 1000)
assert.strictEqual(config.OUTPUT_MODE, String(process.env.SDD_DRIFT_OUTPUT || "").toLowerCase())

console.log("sdd-drift core runtime-config tests passed")
