"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const {
  emptyThrottle,
  loadThrottle,
  saveThrottle,
  bumpBatch,
  decideReminder,
} = require("../../src/core/throttle")

test("decideReminder: reminds when needs present, under cap, new batch", () => {
  const { remind, state } = decideReminder(emptyThrottle(), { hasNeeds: true, maxReminders: 3 })
  assert.equal(remind, true)
  assert.equal(state.sent, 1)
  assert.equal(state.lastRemindedBatch, 0)
})

test("decideReminder: per-batch ≤ 1 — second call same batch does not remind (R2 #11)", () => {
  const s = decideReminder(emptyThrottle(), { hasNeeds: true, maxReminders: 3 }).state
  const again = decideReminder(s, { hasNeeds: true, maxReminders: 3 })
  assert.equal(again.remind, false, "already reminded in batch 0")
  assert.equal(again.state.sent, 1, "sent not advanced")
})

test("decideReminder: new batch re-enables reminding", () => {
  let s = decideReminder(emptyThrottle(), { hasNeeds: true, maxReminders: 3 }).state
  s = bumpBatch(s) // user turn → batch 1
  const next = decideReminder(s, { hasNeeds: true, maxReminders: 3 })
  assert.equal(next.remind, true)
  assert.equal(next.state.sent, 2)
  assert.equal(next.state.lastRemindedBatch, 1)
})

test("decideReminder: respects session cap", () => {
  let s = emptyThrottle()
  for (let i = 0; i < 3; i++) {
    s = decideReminder(s, { hasNeeds: true, maxReminders: 3 }).state
    s = bumpBatch(s)
  }
  assert.equal(decideReminder(s, { hasNeeds: true, maxReminders: 3 }).remind, false, "cap reached")
})

test("decideReminder: maxReminders 0 → never reminds (pure todo)", () => {
  assert.equal(decideReminder(emptyThrottle(), { hasNeeds: true, maxReminders: 0 }).remind, false)
})

test("decideReminder: no needs → never reminds", () => {
  assert.equal(decideReminder(emptyThrottle(), { hasNeeds: false, maxReminders: 3 }).remind, false)
})

test("load/save round-trip; missing/corrupt → empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-thr-"))
  try {
    assert.deepEqual(loadThrottle(dir, "k"), emptyThrottle(), "missing → empty")
    saveThrottle(dir, "k", { batch: 2, sent: 1, lastRemindedBatch: 1 })
    assert.deepEqual(loadThrottle(dir, "k"), { batch: 2, sent: 1, lastRemindedBatch: 1 })
    fs.writeFileSync(path.join(dir, "throttle-k.json"), "{ corrupt")
    assert.deepEqual(loadThrottle(dir, "k"), emptyThrottle(), "corrupt → empty")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bumpBatch: pure, increments batch only", () => {
  assert.deepEqual(bumpBatch({ batch: 0, sent: 5, lastRemindedBatch: 0 }), { batch: 1, sent: 5, lastRemindedBatch: 0 })
})
