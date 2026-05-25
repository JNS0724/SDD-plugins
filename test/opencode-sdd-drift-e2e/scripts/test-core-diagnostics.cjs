const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const diagnostics = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "diagnostics.js"
))

const state = { windowStartMs: 0, counts: {} }
const first = diagnostics.recordDiagnosticSummaryEvent(state, "handler_exception", 1_000, 100)
assert.deepStrictEqual(first, [])
assert.strictEqual(state.counts.handler_exception, 1)
const second = diagnostics.recordDiagnosticSummaryEvent(state, "hook_exception", 1_200, 100)
assert.strictEqual(second.length, 1)
assert.strictEqual(second[0].event, "diagnostic_summary")
assert.strictEqual(second[0].counts.handler_exception, 1)
assert.strictEqual(state.counts.hook_exception, 1)
assert.deepStrictEqual(diagnostics.recordDiagnosticSummaryEvent(state, "ordinary_event", 1_300, 100), [])

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-diagnostics-"))
const target = path.join(tmp, "sdd-drift-check.log.jsonl")
const now = Date.now()
const oldTs = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString()
const freshTs = new Date(now).toISOString()
fs.writeFileSync(
  target,
  [
    JSON.stringify({ ts: oldTs, event: "old" }),
    JSON.stringify({ ts: freshTs, event: "fresh" }),
    "not-json",
    "",
  ].join("\n")
)

assert.strictEqual(diagnostics.parseDiagnosticLogTs(JSON.stringify({ ts: freshTs })), Date.parse(freshTs))
assert.strictEqual(diagnostics.parseDiagnosticLogTs("not-json"), null)

diagnostics.cleanupDiagnosticLogs(target, now)
const cleaned = fs.readFileSync(target, "utf8")
assert.ok(!cleaned.includes("old"))
assert.ok(cleaned.includes("fresh"))
assert.ok(cleaned.includes("not-json"))

fs.writeFileSync(`${target}.1`, JSON.stringify({ ts: oldTs, event: "rotated-old" }) + "\n")
const oldFileTime = new Date(now - 4 * 24 * 60 * 60 * 1000)
fs.utimesSync(`${target}.1`, oldFileTime, oldFileTime)
diagnostics.cleanupDiagnosticLogs(target, now)
assert.ok(!fs.existsSync(`${target}.1`))

console.log("sdd-drift core diagnostics tests passed")
