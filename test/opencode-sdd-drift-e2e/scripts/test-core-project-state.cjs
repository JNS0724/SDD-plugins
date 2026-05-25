const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const projectState = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "project-state.js"
))
const sessionState = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "session-state.js"
))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-project-"))
fs.mkdirSync(path.join(tmp, ".git"), { recursive: true })
const changeDir = path.join(tmp, "sdd", "changes", "feat-a")
fs.mkdirSync(changeDir, { recursive: true })
fs.writeFileSync(path.join(changeDir, "proposal.md"), "# Proposal\n")
fs.writeFileSync(path.join(changeDir, "design.md"), "# Design\n")
fs.writeFileSync(path.join(changeDir, "tasks.md"), "# Tasks\n")

const relDir = "sdd/changes/feat-a"
const normalized = projectState.normalizeProjectState(tmp, {
  changeDirs: {
    [relDir]: {
      relDir,
      docs: {
        design: { exists: true, lastEditedMs: 200, lastReviewedMs: 200, lastEditedSession: "s1" },
        tasks: { exists: true, lastEditedMs: 100, lastReviewedMs: 100, lastEditedSession: "s0" },
      },
      peerSyncs: {
        tasks: { sourceFile: "design.md", sourceEditedMs: 200, targetEditedMs: 220 },
      },
    },
  },
})

const dir = normalized.changeDirs[relDir]
assert.ok(dir)
assert.strictEqual(dir.peerSyncs, undefined)
assert.strictEqual(dir.docSyncs.tasks.sourceFile, "design.md")
assert.strictEqual(projectState.computeProjectConditions(dir).designAheadOfTasks, true)

const staleDir = projectState.normalizeProjectChangeDir(tmp, relDir, {
  relDir,
  docs: {
    design: { exists: true, lastEditedMs: 300, lastReviewedMs: 300, lastEditedSession: "s2" },
    tasks: { exists: true, lastEditedMs: 100, lastReviewedMs: 100, lastEditedSession: "s0" },
  },
})
assert.strictEqual(staleDir.conditions.designAheadOfTasks, true)
assert.strictEqual(projectState.computeProjectState(staleDir.conditions, staleDir.archived), "DESIGN_PENDING_TASKS")

assert.deepStrictEqual(
  projectState.collectActiveChangeDirs(tmp, { changeDirs: [changeDir] }),
  [path.normalize(changeDir)]
)

const state = sessionState.emptyState()
const codePath = path.join(tmp, "src", "feature.ts")
fs.mkdirSync(path.dirname(codePath), { recursive: true })
fs.writeFileSync(codePath, "export const value = 1\n")
sessionState.recordFile(state, path.join(changeDir, "design.md"), true)
sessionState.recordFile(state, path.join(changeDir, "tasks.md"), true)
sessionState.recordFile(state, codePath, true)
dir.linkedCode = [{ path: "src/feature.ts", lastEditedMs: 1 }]
dir.docs.design.exists = true
dir.docs.tasks.exists = true
assert.strictEqual(projectState.refreshAlignedBaseline(tmp, normalized, state), true)
assert.ok(Number(normalized.changeDirs[relDir].alignedAtMs) > 0)

projectState.saveProjectState(tmp, normalized)
const loaded = projectState.loadProjectState(tmp)
assert.ok(loaded.changeDirs[relDir])

console.log("sdd-drift core project-state tests passed")
