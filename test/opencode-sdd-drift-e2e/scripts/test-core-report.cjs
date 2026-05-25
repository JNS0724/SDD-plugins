const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const report = require(path.join(repoRoot, "plugins", "sdd-drift-check", "src", "core", "report.js"))
const sessionState = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "session-state.js"
))

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-report-"))
fs.mkdirSync(path.join(cwd, ".git"), { recursive: true })
const changeDir = path.join(cwd, "sdd", "changes", "feat-a")
fs.mkdirSync(changeDir, { recursive: true })
const designPath = path.join(changeDir, "design.md")
const tasksPath = path.join(changeDir, "tasks.md")
fs.writeFileSync(designPath, "# Design\n")
fs.writeFileSync(tasksPath, "# Tasks\n")

const state = sessionState.emptyState()
sessionState.applyToolRecord(cwd, state, "Edit", { file_path: designPath })
let lines = report.collectReportLines(cwd, state)
assert.strictEqual(lines.length, 1)
assert.match(lines[0], /required \[tasks\.md\]/)

const reportPath = path.join(cwd, ".sdd-drift-report.md")
report.refreshReport(cwd, state)
assert.ok(fs.existsSync(reportPath))
const first = fs.readFileSync(reportPath, "utf8")
report.refreshReport(cwd, state)
assert.strictEqual(fs.readFileSync(reportPath, "utf8"), first)

sessionState.applyToolRecord(cwd, state, "Edit", { file_path: tasksPath })
assert.deepStrictEqual(report.collectReportLines(cwd, state), [])
report.refreshReport(cwd, state)
assert.ok(!fs.existsSync(reportPath))

state.codeReviewConfirmations.example = {
  confirmed: true,
  userConfirmationRecommended: true,
  codeSeq: 2,
  codeFiles: [path.join(cwd, "src", "feature.ts")],
  reviewTargets: [designPath, tasksPath],
}
lines = report.collectCodeReviewAdvisoryLines(cwd, state)
assert.strictEqual(lines.length, 1)
assert.match(lines[0], /User confirmation recommended/)

sessionState.recordFile(state, designPath, true)
sessionState.recordFile(state, tasksPath, true)
assert.deepStrictEqual(report.collectCodeReviewAdvisoryLines(cwd, state), [])

console.log("sdd-drift core report tests passed")
