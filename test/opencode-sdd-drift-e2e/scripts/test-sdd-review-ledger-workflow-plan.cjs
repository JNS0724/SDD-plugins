const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const workflow = path.join(
  repoRoot,
  "test",
  "opencode-sdd-drift-e2e",
  "scripts",
  "run-real-sdd-review-ledger-workflow.ps1",
)
const text = fs.readFileSync(workflow, "utf8")

assert.match(text, /ValidateSet\("single-session", "split-at-04", "split-multi"\)/)
assert.match(text, /P08-vip-design-new-session/)
assert.match(text, /P14-audit-log-long-task/)
assert.match(text, /Scenario -eq "split-multi"/)

for (let i = 1; i <= 18; i += 1) {
  const idPrefix = `P${String(i).padStart(2, "0")}-`
  assert.ok(text.includes(`id = "${idPrefix}`), `missing phase ${idPrefix}`)
}

for (const field of [
  "injectionTypes",
  "pendingAdded",
  "pendingCleared",
  "checkedAdded",
  "readEvidence",
]) {
  assert.ok(text.includes(field), `missing workflow analysis field ${field}`)
}

assert.match(text, /SDD_REVIEW = "off"/)
assert.match(text, /node \.\/scripts\/check\.mjs/)

console.log("sdd-review-ledger workflow plan coverage test passed")
