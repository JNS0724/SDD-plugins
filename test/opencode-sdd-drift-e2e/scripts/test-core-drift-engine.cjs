const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const driftEngine = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "drift-engine.js"
))
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

const makeWorkspace = (withSdd = true) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-drift-engine-"))
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true })
  const changeDir = path.join(cwd, "sdd", "changes", "feat-a")
  if (withSdd) {
    fs.mkdirSync(changeDir, { recursive: true })
    fs.writeFileSync(path.join(changeDir, "design.md"), "# Design\n")
    fs.writeFileSync(path.join(changeDir, "tasks.md"), "# Tasks\n")
  }
  const codePath = path.join(cwd, "src", "feature.ts")
  fs.mkdirSync(path.dirname(codePath), { recursive: true })
  fs.writeFileSync(codePath, "export const value = 1\n")
  return { cwd, changeDir, codePath }
}

{
  const { cwd, codePath } = makeWorkspace(false)
  const state = sessionState.emptyState()
  sessionState.applyToolRecord(cwd, state, "Edit", { file_path: codePath })
  assert.deepStrictEqual(driftEngine.drift(cwd, codePath, state), [])
  assert.deepStrictEqual(driftEngine.collectCodeGaps(cwd, state), [])
}

{
  const { cwd, changeDir, codePath } = makeWorkspace(true)
  const state = sessionState.emptyState()
  sessionState.applyToolRecord(cwd, state, "Edit", { file_path: codePath })

  assert.match(driftEngine.drift(cwd, codePath, state).join("\n"), /code file feature\.ts/)
  let gaps = driftEngine.collectCodeGaps(cwd, state)
  assert.strictEqual(gaps.length, 1)
  assert.strictEqual(gaps[0].reviewReady, false)
  assert.deepStrictEqual(
    gaps[0].pendingReviewTargets.map((file) => path.basename(file)).sort(),
    ["design.md", "tasks.md"]
  )

  sessionState.applyToolRecord(cwd, state, "Read", { file_path: path.join(changeDir, "design.md") })
  sessionState.applyToolRecord(cwd, state, "Read", { file_path: path.join(changeDir, "tasks.md") })
  gaps = driftEngine.collectCodeGaps(cwd, state)
  assert.strictEqual(gaps.length, 1)
  assert.strictEqual(gaps[0].reviewReady, true)
  assert.strictEqual(gaps[0].needsConfirmation, true)
  assert.strictEqual(driftEngine.markCodeReviewNoEditConfirmation(state, gaps), true)
  assert.deepStrictEqual(driftEngine.collectCodeGaps(cwd, state), [])
}

{
  const { cwd, changeDir } = makeWorkspace(true)
  const state = sessionState.emptyState()
  const designPath = path.join(changeDir, "design.md")
  const tasksPath = path.join(changeDir, "tasks.md")

  sessionState.applyToolRecord(cwd, state, "Edit", { file_path: designPath })
  let gaps = driftEngine.collectPeerGaps(cwd, state)
  assert.strictEqual(gaps.length, 1)
  assert.deepStrictEqual(gaps[0].required, ["tasks.md"])

  sessionState.applyToolRecord(cwd, state, "Edit", { file_path: tasksPath })
  assert.deepStrictEqual(driftEngine.collectPeerGaps(cwd, state), [])
}

{
  const { cwd, codePath } = makeWorkspace(true)
  const state = sessionState.emptyState()
  state.dtsContext = { active: true, matchedAt: new Date().toISOString() }
  sessionState.applyToolRecord(cwd, state, "Edit", { file_path: codePath })
  assert.strictEqual(driftEngine.isDtsContextActive(state), true)
  assert.deepStrictEqual(driftEngine.drift(cwd, codePath, state), [])
  assert.deepStrictEqual(driftEngine.collectCodeGaps(cwd, state), [])
}

{
  const { cwd } = makeWorkspace(true)
  const project = projectState.normalizeProjectState(cwd, {
    changeDirs: {
      "sdd/changes/feat-a": {
        relDir: "sdd/changes/feat-a",
        docs: {
          design: { exists: true, lastEditedMs: 300, lastReviewedMs: 300, lastEditedSession: "s2" },
          tasks: { exists: true, lastEditedMs: 100, lastReviewedMs: 100, lastEditedSession: "s1" },
        },
      },
    },
  })
  const peerGaps = driftEngine.collectProjectPeerGaps(cwd, project)
  assert.strictEqual(peerGaps.length, 1)
  assert.deepStrictEqual(peerGaps[0].required, ["tasks.md"])

  project.changeDirs["sdd/changes/feat-a"].docSyncs = {
    tasks: { sourceFile: "design.md", sourceEditedMs: 300, targetEditedMs: 350 },
  }
  project.changeDirs["sdd/changes/feat-a"].docs.tasks.lastEditedMs = 350
  project.changeDirs["sdd/changes/feat-a"].docs.tasks.lastEditedSession = "s3"
  projectState.recomputeProjectState(project, cwd)
  assert.deepStrictEqual(driftEngine.collectProjectPeerGaps(cwd, project), [])
}

{
  const { cwd } = makeWorkspace(true)
  const project = projectState.normalizeProjectState(cwd, {
    changeDirs: {
      "sdd/changes/feat-a": {
        relDir: "sdd/changes/feat-a",
        docs: {
          design: { exists: true, lastEditedMs: 100, lastReviewedMs: 100, lastEditedSession: "s1" },
          tasks: { exists: true, lastEditedMs: 100, lastReviewedMs: 100, lastEditedSession: "s1" },
        },
        linkedCode: [{ path: "src/feature.ts", lastEditedMs: 500 }],
        alignedAtMs: 0,
      },
    },
  })
  const gaps = driftEngine.collectProjectCodeGaps(cwd, project)
  assert.strictEqual(gaps.length, 1)
  assert.deepStrictEqual(
    gaps[0].reviewTargets.map((file) => path.basename(file)).sort(),
    ["design.md", "tasks.md"]
  )
}

console.log("sdd-drift core drift-engine tests passed")
