"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const {
  emptyLedger,
  parseLedger,
  serializeLedger,
  withRecord,
  getRecord,
  trackCodePath,
  LEDGER_VERSION,
} = require("../../src/core/ledger")

test("emptyLedger: versioned empty map", () => {
  assert.deepEqual(emptyLedger(), { version: LEDGER_VERSION, records: {} })
})

test("parseLedger: round-trips a valid ledger", () => {
  const led = withRecord(emptyLedger(), "src/a.ts", {
    kind: "code",
    reviewedHash: "a1b2c3d4e5f60718",
    verdict: "synced",
    rationale: "ok",
    reviewedAt: "2026-05-31T10:00:00Z",
    by: "agent",
  })
  const parsed = parseLedger(serializeLedger(led))
  assert.deepEqual(parsed, led)
})

test("parseLedger: corruption self-heals to empty (bad JSON)", () => {
  assert.deepEqual(parseLedger("{ not json"), emptyLedger())
})

test("parseLedger: corruption self-heals to empty (wrong shape)", () => {
  assert.deepEqual(parseLedger(JSON.stringify({ version: 1 })), emptyLedger(), "missing records")
  assert.deepEqual(parseLedger(JSON.stringify([1, 2, 3])), emptyLedger(), "array not object")
  assert.deepEqual(parseLedger(""), emptyLedger(), "empty string")
})

test("withRecord: immutable — does not mutate input", () => {
  const a = emptyLedger()
  const b = withRecord(a, "k", { kind: "code", reviewedHash: "x" })
  assert.deepEqual(a.records, {}, "original untouched")
  assert.equal(getRecord(b, "k").reviewedHash, "x")
})

test("trackCodePath: first sighting → reviewedHash null; never clobbers existing", () => {
  let led = trackCodePath(emptyLedger(), "src/a.ts")
  assert.equal(getRecord(led, "src/a.ts").reviewedHash, null)
  assert.equal(getRecord(led, "src/a.ts").kind, "code")

  // simulate it later getting reviewed
  led = withRecord(led, "src/a.ts", { kind: "code", reviewedHash: "deadbeef", verdict: "synced" })
  // capture again must NOT reset reviewedHash
  const after = trackCodePath(led, "src/a.ts")
  assert.equal(getRecord(after, "src/a.ts").reviewedHash, "deadbeef")
})
