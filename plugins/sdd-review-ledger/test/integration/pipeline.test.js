"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { run } = require("../../src/pipeline")
const { init, status, ensureGitignore } = require("../../src/handlers/cli")
const { parseLedger } = require("../../src/core/ledger")
const { ledgerPathFor, todoPathFor } = require("../../src/core/state-dir")
const { acquireFileLock, releaseFileLock } = require("../../src/core/locks")
const { hashElement } = require("../../src/core/hash")

// realpath: macOS tmpdir is a symlink; keep repoRoot canonical so rel() keys match.
const mkRepo = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdd-pipe-")))
  fs.mkdirSync(path.join(root, "sdd", "changes", "greeting"), { recursive: true })
  fs.writeFileSync(path.join(root, "sdd", "changes", "greeting", "design.md"), "# Greeting v1\n")
  return root
}
const write = (root, rel, content) => {
  const fp = path.join(root, rel)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true })
const readLedger = (root) => parseLedger(fs.readFileSync(ledgerPathFor(root), "utf8"))
const readTodo = (root) => fs.readFileSync(todoPathFor(root), "utf8")
const NOW = "2026-05-31T12:00:00Z"
const ctx = (root, extra = {}) => ({ repoRoot: root, env: {}, now: NOW, actor: "agent", ...extra })

test("cold start: auto-baseline records existing, surfaces 0; then an edit surfaces only that file", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "const a = 1")
    write(root, "src/b.ts", "const b = 2")
    const first = run(ctx(root))
    assert.equal(first.action, "bootstrap", "first run is a silent baseline")
    assert.equal(first.needs.length, 0, "nothing surfaces on cold start")
    assert.ok(first.bootstrapCount >= 3, "design.md + 2 code files baselined")

    write(root, "src/a.ts", "const a = 999")
    const second = run(ctx(root, { editedPath: path.join(root, "src/a.ts") }))
    assert.deepEqual(second.needs.map((i) => i.path), ["src/a.ts"], "only the edited file surfaces")
  } finally {
    rm(root)
  }
})

test("ingest-before-render: a checkoff lands as reviewed and is NOT bounced back to pending", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ctx(root)) // baseline
    write(root, "src/a.ts", "v2") // now a.ts is pending
    const r1 = run(ctx(root))
    assert.ok(r1.needs.some((i) => i.path === "src/a.ts"), "pending after edit")
    const h2 = hashElement(path.join(root, "src/a.ts"))

    // user checks it off in the pending list with the CURRENT inline hash
    const checked = readTodo(root).replace(`- [ ] src/a.ts@${h2}`, `- [x] src/a.ts@${h2} — 仅重构，无需改文档`)
    fs.writeFileSync(todoPathFor(root), checked)

    const r2 = run(ctx(root))
    assert.ok(!r2.needs.some((i) => i.path === "src/a.ts"), "no longer pending after checkoff")
    assert.equal(readLedger(root).records["src/a.ts"].reviewedHash, h2, "verdict pinned to checked hash")
    const r3 = run(ctx(root))
    assert.ok(!r3.needs.some((i) => i.path === "src/a.ts"), "stays cleared (audit line does not bounce it)")
  } finally {
    rm(root)
  }
})

test("hash-pinning: checkoff@H2 then edit to H3 → re-pending (no cross-version false-clean)", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ctx(root))
    write(root, "src/a.ts", "v2")
    run(ctx(root))
    const h2 = hashElement(path.join(root, "src/a.ts"))
    fs.writeFileSync(todoPathFor(root), readTodo(root).replace(`- [ ] src/a.ts@${h2}`, `- [x] src/a.ts@${h2} — ok`))
    run(ctx(root)) // ingest the checkoff @H2

    write(root, "src/a.ts", "v3") // edit again → H3
    const r = run(ctx(root))
    assert.ok(r.needs.some((i) => i.path === "src/a.ts"), "re-pending: H3 not covered by H2 verdict")
  } finally {
    rm(root)
  }
})

test("checkoff-only: editing a doc to sync does NOT clear a pending code item", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ctx(root))
    write(root, "src/a.ts", "v2") // code pending
    run(ctx(root))
    write(root, "sdd/changes/greeting/design.md", "# Greeting v2 synced") // real sync action
    const r = run(ctx(root))
    assert.ok(r.needs.some((i) => i.path === "src/a.ts"), "code still pending until explicitly checked")
  } finally {
    rm(root)
  }
})

test("escape hatch: SDD_REVIEW=off → silent, writes nothing (R2 #1)", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    const r = run({ repoRoot: root, env: { SDD_REVIEW: "off" }, now: NOW })
    assert.equal(r.action, "silent")
    assert.equal(r.reason, "disabled")
    assert.equal(fs.existsSync(todoPathFor(root)), false, "no todo written")
    assert.equal(fs.existsSync(ledgerPathFor(root)), false, "no ledger written")
  } finally {
    rm(root)
  }
})

test("non-sdd project with empty ledger → silent", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdd-nonsdd-")))
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}")
    fs.writeFileSync(path.join(root, "app.ts"), "const x = 1")
    const r = run(ctx(root))
    assert.equal(r.action, "silent")
    assert.equal(r.reason, "not-sdd")
  } finally {
    rm(root)
  }
})

test("fail-open: cannot get lock → deliver read-only, wrote:false, no ledger written", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    const held = acquireFileLock(ledgerPathFor(root), { waitMs: 0 }) // hold lock externally
    assert.ok(held)
    const r = run(ctx(root))
    assert.equal(r.wrote, false, "did not write while lock held")
    assert.equal(r.action, "deliver")
    assert.equal(fs.existsSync(ledgerPathFor(root)), false, "ledger not created under contention")
    releaseFileLock(held)
    const r2 = run(ctx(root))
    assert.equal(r2.wrote, true)
    assert.ok(fs.existsSync(ledgerPathFor(root)))
  } finally {
    rm(root)
  }
})

test("corruption self-heal: garbage ledger.json → treated as empty, no throw", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ctx(root)) // create state dir + ledger
    fs.writeFileSync(ledgerPathFor(root), "{ totally not json")
    const r = run(ctx(root))
    assert.notEqual(r.action, "silent", "still runs")
    assert.ok(Array.isArray(r.needs))
  } finally {
    rm(root)
  }
})

test("determinism: two runs with no change between them → identical needs", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ctx(root))
    write(root, "src/a.ts", "v2")
    const r1 = run(ctx(root))
    const r2 = run(ctx(root))
    assert.deepEqual(r1.needs.map((i) => i.path), r2.needs.map((i) => i.path))
  } finally {
    rm(root)
  }
})

// ─── CLI ───
test("init: baselines existing, 0 pending, writes both .gitignore lines", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    const r = init(ctx(root))
    assert.equal(r.action, "init")
    assert.equal(r.pending, 0, "init never surfaces existing")
    assert.ok(r.baselineCount >= 2)
    const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf8")
    assert.ok(gi.includes(".sdd-review-ledger-state/"))
    assert.ok(gi.includes(".sdd-review-todo.md"))
  } finally {
    rm(root)
  }
})

test("ensureGitignore: idempotent — second call adds nothing", () => {
  const root = mkRepo()
  try {
    assert.equal(ensureGitignore(root).changed, true)
    assert.equal(ensureGitignore(root).changed, false, "already present")
  } finally {
    rm(root)
  }
})

test("status: read-only, reports pending without writing", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ctx(root)) // baseline
    write(root, "src/a.ts", "v2")
    try { fs.rmSync(todoPathFor(root)) } catch {}
    const s = status(ctx(root))
    assert.equal(s.action, "status")
    assert.ok(s.needs.some((i) => i.path === "src/a.ts"))
    assert.equal(fs.existsSync(todoPathFor(root)), false, "status wrote nothing")
  } finally {
    rm(root)
  }
})
