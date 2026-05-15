const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const hook = require("../../../plugins/sdd-drift-check/sdd-drift-check-hook.cjs")

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-drift-hook-"))

const write = (fp, content = "") => {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}

const edit = (state, fp) => {
  const seq = hook.recordFile(state, fp, true)
  const doc = hook.getChangeDoc(fp)
  if (doc?.dir && doc.file) hook.updateRequirementsForEdit(state, doc.dir, doc.file, seq)
  return seq
}

try {
  {
    const cwd = path.join(tmpRoot, "missing-peer")
    const design = path.join(cwd, "sdd", "changes", "alpha", "design.md")
    write(design, "# Design\n")

    const state = hook.emptyState()
    edit(state, design)

    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.deepStrictEqual(gaps[0].missing, ["tasks.md"])
    assert.match(hook.buildToolEnforcement(gaps), /sdd\/changes\/alpha\/tasks\.md/)
  }

  {
    const cwd = path.join(tmpRoot, "stale-peer")
    const dir = path.join(cwd, "sdd", "changes", "beta")
    const proposal = path.join(dir, "proposal.md")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(proposal, "# Proposal\n")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")

    const state = hook.emptyState()
    edit(state, tasks)
    edit(state, proposal)

    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.deepStrictEqual(gaps[0].missing, ["design.md"])
    assert.deepStrictEqual(gaps[0].stale, ["tasks.md"])
  }

  {
    const cwd = path.join(tmpRoot, "no-ping-pong")
    const dir = path.join(cwd, "sdd", "changes", "gamma")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")

    const state = hook.emptyState()
    edit(state, design)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 1)
    edit(state, tasks)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "proposal")
    const dir = path.join(cwd, "sdd", "changes", "delta")
    const proposal = path.join(dir, "proposal.md")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(proposal, "# Proposal\n")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")

    const state = hook.emptyState()
    edit(state, proposal)
    assert.deepStrictEqual(hook.collectPeerGaps(cwd, state)[0].missing, [
      "design.md",
      "tasks.md",
    ])
    edit(state, design)
    assert.deepStrictEqual(hook.collectPeerGaps(cwd, state)[0].missing, ["tasks.md"])
    edit(state, tasks)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "code")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "epsilon")
    const readOnlyDesign = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "app.ts")
    write(readOnlyDesign, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")
    hook.recordFile(state, readOnlyDesign, false)
    hook.recordFile(state, code, true)
    assert.strictEqual(hook.hasEditedSddChange(state), false)
    assert.match(hook.drift(cwd, code, state).join("\n"), /did not edit any sdd\/changes/)
    const codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.match(hook.buildCodeEnforcement(cwd, codeGaps), /sdd\/changes\/epsilon\/design\.md/)

    edit(state, readOnlyDesign)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.deepStrictEqual(hook.collectPeerGaps(cwd, state)[0].missing, ["tasks.md"])
    edit(state, tasks)
    assert.strictEqual(hook.collectReportLines(cwd, state).length, 0)
  }

  {
    const nested = path.join(tmpRoot, "repo", "services", "api", "sdd", "changes", "zeta", "design.md")
    write(nested, "# Design\n")
    assert.strictEqual(
      path.normalize(hook.findSdd(nested)),
      path.join(tmpRoot, "repo", "services", "api", "sdd")
    )
  }

  console.log("sdd-drift hook unit tests passed")
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
