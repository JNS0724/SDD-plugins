const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const rules = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "sdd-rules.js"
))

assert.strictEqual(rules.PROPOSAL_FILE, "proposal.md")
assert.strictEqual(rules.DESIGN_FILE, "design.md")
assert.strictEqual(rules.TASKS_FILE, "tasks.md")
assert.deepStrictEqual(rules.PEER_FILES, ["design.md", "tasks.md"])
assert.deepStrictEqual(rules.REVIEW_FILES, ["design.md", "tasks.md"])
assert.deepStrictEqual(rules.CHANGE_DOC_REQUIREMENTS["proposal.md"], ["design.md"])
assert.deepStrictEqual(rules.CHANGE_DOC_REQUIREMENTS["design.md"], ["tasks.md"])
assert.deepStrictEqual(rules.CHANGE_DOC_REQUIREMENTS["tasks.md"], ["design.md"])
assert.ok(rules.ARCHIVED_CHANGE_DIR_NAMES.has("archive"))
assert.ok(rules.ARCHIVED_CHANGE_DIR_NAMES.has("已归档"))
assert.ok(rules.DOCUMENT_SYNC_RULES.some((rule) => rule.includes("preserve its existing Markdown template")))
assert.ok(rules.DOCUMENT_SYNC_RULES.includes("Do not add new sections."))
assert.ok(rules.DOCUMENT_SYNC_RULES.includes("Do not rewrite the document template."))
assert.ok(
  rules.DOCUMENT_SYNC_RULES.includes("Find the existing section that should change and edit that section only.")
)
assert.ok(rules.ACTIVE_SDD_ALIGNMENT_RULES.some((rule) => rule.includes("live planning records")))
assert.ok(rules.ATTRIBUTION_REVIEW_RULES.some((rule) => rule.includes("Purely mechanical changes")))
assert.match(rules.SUBAGENT_REVIEW_RULE, /read-only review subagent/)
assert.ok(
  rules.RESUME_ORIGINAL_TASK_RULES.includes(
    "SDD review is a checkpoint inside the current task, not the final task."
  )
)
assert.ok(
  rules.RESUME_ORIGINAL_TASK_RULES.includes(
    "After the SDD review or synchronization is complete, return to the original user task."
  )
)

const formatted = rules.formatAttributionReviewRules()
assert.match(formatted[0], /apply these attribution review rules/)
assert.match(formatted[1], /^1\. Purely mechanical changes/)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-rules-"))
const sddRoot = path.join(tmp, "sdd")
const changeDir = path.join(sddRoot, "changes", "feat-a")
fs.mkdirSync(changeDir, { recursive: true })
const designPath = path.join(changeDir, "design.md")
fs.writeFileSync(designPath, "# Design\n")

assert.strictEqual(rules.findSdd(designPath), path.normalize(sddRoot))
assert.deepStrictEqual(
  {
    id: rules.getChangeDoc(designPath).id,
    file: rules.getChangeDoc(designPath).file,
    dir: rules.getChangeDoc(designPath).dir,
  },
  { id: "feat-a", file: "design.md", dir: changeDir }
)
assert.ok(!rules.isArchivedChangeDir(changeDir))
assert.ok(rules.isArchivedChangeDir(path.join(sddRoot, "changes", "archive")))
fs.writeFileSync(path.join(changeDir, ".archived"), "")
assert.ok(rules.isArchivedChangeDir(changeDir))

const statusDir = path.join(sddRoot, "changes", "feat-b")
fs.mkdirSync(statusDir, { recursive: true })
fs.writeFileSync(path.join(statusDir, "status.md"), "status: archived\n")
assert.ok(rules.isArchivedChangeDir(statusDir))

console.log("sdd-drift core SDD rules tests passed")
