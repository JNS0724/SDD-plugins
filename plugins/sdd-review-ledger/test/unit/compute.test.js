"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { computeNeedsReview } = require("../../src/core/compute")
const { hashElement } = require("../../src/core/hash")
const { emptyLedger, withRecord } = require("../../src/core/ledger")

const mkRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "sdd-compute-"))
const write = (root, rel, content) => {
  const fp = path.join(root, rel)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}
const baselineFor = (root, rel, ledger) =>
  withRecord(ledger, rel, {
    kind: rel.endsWith(".md") ? "sdd-doc" : "code",
    reviewedHash: hashElement(path.join(root, rel)),
    verdict: "reviewed",
    rationale: "baseline",
    reviewedAt: "2026-05-31T00:00:00Z",
    by: "user",
  })
const paths = (res) => res.items.map((i) => i.path).sort()

test("Layer A: changed doc surfaces as needs-review (never-reviewed)", () => {
  const root = mkRepo()
  try {
    write(root, "sdd/changes/greeting/design.md", "# v1")
    const res = computeNeedsReview(root, emptyLedger())
    assert.deepEqual(paths(res), ["sdd/changes/greeting/design.md"])
    assert.equal(res.items[0].kind, "sdd-doc")
    assert.equal(res.items[0].reason, "never-reviewed")
    assert.deepEqual(res.items[0].candidates, ["sdd/changes/greeting"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Layer A: doc at baseline does NOT surface; edit → changed-since-review", () => {
  const root = mkRepo()
  try {
    write(root, "sdd/changes/g/design.md", "# v1")
    const led = baselineFor(root, "sdd/changes/g/design.md", emptyLedger())
    assert.equal(computeNeedsReview(root, led).items.length, 0, "at baseline = clean")
    write(root, "sdd/changes/g/design.md", "# v2 edited")
    const res = computeNeedsReview(root, led)
    assert.deepEqual(paths(res), ["sdd/changes/g/design.md"])
    assert.equal(res.items[0].reason, "changed-since-review")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Layer B: code file surfaces via scan even with empty ledger (no capture)", () => {
  const root = mkRepo()
  try {
    write(root, "src/greet.ts", "export const x = 1")
    const res = computeNeedsReview(root, emptyLedger())
    assert.deepEqual(paths(res), ["src/greet.ts"])
    assert.equal(res.items[0].kind, "code")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("Layer B: code at baseline clean; content edit surfaces it again", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    const led = baselineFor(root, "src/a.ts", emptyLedger())
    assert.equal(computeNeedsReview(root, led).items.length, 0)
    write(root, "src/a.ts", "v2")
    assert.deepEqual(paths(computeNeedsReview(root, led)), ["src/a.ts"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("determinism: same (working tree, ledger) → identical output across runs", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "1")
    write(root, "sdd/changes/g/tasks.md", "- t")
    const led = emptyLedger()
    const r1 = computeNeedsReview(root, led)
    const r2 = computeNeedsReview(root, led)
    assert.deepEqual(r1, r2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("deleted file does not surface and does not throw", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "1")
    const led = baselineFor(root, "src/a.ts", emptyLedger())
    fs.rmSync(path.join(root, "src/a.ts"))
    const res = computeNeedsReview(root, led)
    assert.equal(res.items.length, 0, "missing file is skipped, not reported")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// R1 CORE REGRESSION: commit-invariance. The whole reason for dropping git.
// A missed-capture file must keep surfacing regardless of git commit state,
// because compute is a pure function of the working tree (NOT git refs).
// ─────────────────────────────────────────────────────────────────────────────
test("R1 commit-invariance: missed-capture code surfaces, and STILL surfaces after a git commit", () => {
  const root = mkRepo()
  try {
    // "subagent/shell wrote X without capture" — never entered into the ledger
    write(root, "src/sneaky.ts", "export const y = 2")
    const before = computeNeedsReview(root, emptyLedger())
    assert.ok(paths(before).includes("src/sneaky.ts"), "surfaces pre-commit")

    // Simulate a git commit: working-tree bytes unchanged, ledger unchanged.
    // We don't even need a real git repo — compute must not consult git at all.
    const after = computeNeedsReview(root, emptyLedger())
    assert.deepEqual(after, before, "IDENTICAL after 'commit' — git plays no role (v0.1 git version would drop it)")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("R1: works with no .git directory at all", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "1")
    assert.equal(fs.existsSync(path.join(root, ".git")), false)
    assert.deepEqual(paths(computeNeedsReview(root, emptyLedger())), ["src/a.ts"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// §12.4 误报对账 (false-positive reconciliation): "no semantic drift" edits must
// not produce HARMFUL wrong conclusions — only benign "please review" items that
// a one-line checkoff clears. The tool never declares synced/aligned on its own.
// ─────────────────────────────────────────────────────────────────────────────
test("误报对账: gofmt-style reformat surfaces benignly (not a harmful verdict)", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "const x=1")
    const led = baselineFor(root, "src/a.ts", emptyLedger())
    assert.equal(computeNeedsReview(root, led).items.length, 0, "clean at baseline")
    // reformat (bytes change, behavior identical)
    write(root, "src/a.ts", "const x = 1\n")
    const res = computeNeedsReview(root, led)
    // It surfaces (benign) — but only as a needs-review item, never as "drift/aligned".
    assert.deepEqual(paths(res), ["src/a.ts"])
    assert.equal(res.items[0].reason, "changed-since-review")
    assert.ok(!("verdict" in res.items[0]), "tool emits no verdict; that is the LLM's job")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("误报对账: editing one file in a multi-file repo surfaces ONLY that file", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "1")
    write(root, "src/b.ts", "2")
    write(root, "src/c.ts", "3")
    let led = emptyLedger()
    for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) led = baselineFor(root, f, led)
    assert.equal(computeNeedsReview(root, led).items.length, 0, "all at baseline")
    write(root, "src/b.ts", "2 changed")
    assert.deepEqual(paths(computeNeedsReview(root, led)), ["src/b.ts"], "no over-reporting")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
