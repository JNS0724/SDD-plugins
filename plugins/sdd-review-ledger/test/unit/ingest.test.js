"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const { ingestCheckoffs, labelFromRationale } = require("../../src/core/ingest")
const { emptyLedger, getRecord } = require("../../src/core/ledger")

const NOW = "2026-05-31T12:00:00Z"

test("ingestCheckoffs: checked entry → verdict pinned to INLINE hash (§5.3)", () => {
  const entries = [{ checked: true, path: "src/a.ts", inlineHash: "H1", rationale: "无需改" }]
  const led = ingestCheckoffs(emptyLedger(), entries, NOW, "agent")
  const rec = getRecord(led, "src/a.ts")
  assert.equal(rec.reviewedHash, "H1", "pinned to inline hash, not current")
  assert.equal(rec.reviewedAt, NOW)
  assert.equal(rec.by, "agent")
})

test("ingestCheckoffs: unchecked entries never clear (checkoff-only, §8.2)", () => {
  const entries = [{ checked: false, path: "src/a.ts", inlineHash: "H1", rationale: "" }]
  const led = ingestCheckoffs(emptyLedger(), entries, NOW, "agent")
  assert.equal(getRecord(led, "src/a.ts"), undefined, "no record written for unchecked")
})

test("ingestCheckoffs: non-tracked paths (other) ignored", () => {
  const entries = [{ checked: true, path: "package-lock.json", inlineHash: "H1", rationale: "x" }]
  const led = ingestCheckoffs(emptyLedger(), entries, NOW, "agent")
  assert.equal(getRecord(led, "package-lock.json"), undefined)
})

test("ingestCheckoffs: idempotent on repeated identical checkoff", () => {
  const entries = [{ checked: true, path: "src/a.ts", inlineHash: "H1", rationale: "ok" }]
  const once = ingestCheckoffs(emptyLedger(), entries, NOW, "agent")
  const twice = ingestCheckoffs(once, entries, NOW, "agent")
  assert.deepEqual(once.records, twice.records)
})

test("ingestCheckoffs: immutable — input ledger untouched", () => {
  const before = emptyLedger()
  ingestCheckoffs(before, [{ checked: true, path: "src/a.ts", inlineHash: "H1", rationale: "ok" }], NOW, "agent")
  assert.deepEqual(before.records, {})
})

test("ingestCheckoffs: classifies kind for sdd-doc vs code", () => {
  const entries = [
    { checked: true, path: "sdd/changes/x/design.md", inlineHash: "D1", rationale: "synced" },
    { checked: true, path: "src/a.ts", inlineHash: "C1", rationale: "无关" },
  ]
  const led = ingestCheckoffs(emptyLedger(), entries, NOW, "user")
  assert.equal(getRecord(led, "sdd/changes/x/design.md").kind, "sdd-doc")
  assert.equal(getRecord(led, "src/a.ts").kind, "code")
})

test("labelFromRationale: coarse display tags, default reviewed", () => {
  assert.equal(labelFromRationale("无关 hotfix"), "unrelated")
  assert.equal(labelFromRationale("仅 gofmt"), "no-change")
  assert.equal(labelFromRationale("已同步 design"), "synced")
  assert.equal(labelFromRationale("looked at it"), "reviewed")
})
