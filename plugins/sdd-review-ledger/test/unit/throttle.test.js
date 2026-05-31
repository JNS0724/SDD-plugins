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

test("decideReminder: default policy allows repeated reminders for different pending sets", () => {
  const s = decideReminder(emptyThrottle(), { hasNeeds: true, maxReminders: 3, signature: "a@1", nowMs: 1000, dedupeMs: 2000 }).state
  const again = decideReminder(s, { hasNeeds: true, maxReminders: 3, signature: "a@1|b@1", nowMs: 1001, dedupeMs: 2000 })
  assert.equal(again.remind, true, "same-batch code edits should still remind")
  assert.equal(again.state.sent, 2, "sent advances")
})

test("decideReminder: suppresses identical pending-set reminders inside dedupe window", () => {
  const s = decideReminder(emptyThrottle(), { hasNeeds: true, maxReminders: 3, signature: "a@1|b@1", nowMs: 1000, dedupeMs: 2000 }).state
  const duplicate = decideReminder(s, { hasNeeds: true, maxReminders: 3, signature: "a@1|b@1", nowMs: 1500, dedupeMs: 2000 })
  assert.equal(duplicate.remind, false)
  assert.equal(duplicate.state.sent, 1)
  const later = decideReminder(s, { hasNeeds: true, maxReminders: 3, signature: "a@1|b@1", nowMs: 3001, dedupeMs: 2000 })
  assert.equal(later.remind, true)
})

test("decideReminder: batch still records the latest reminded batch", () => {
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
    assert.deepEqual(loadThrottle(dir, "k"), {
      batch: 2,
      sent: 1,
      lastRemindedBatch: 1,
      lastReminderSignature: "",
      lastReminderAtMs: 0,
    })
    fs.writeFileSync(path.join(dir, "throttle-k.json"), "{ corrupt")
    assert.deepEqual(loadThrottle(dir, "k"), emptyThrottle(), "corrupt → empty")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bumpBatch: pure, increments batch only", () => {
  assert.deepEqual(bumpBatch({ batch: 0, sent: 5, lastRemindedBatch: 0 }), { batch: 1, sent: 5, lastRemindedBatch: 0 })
})
