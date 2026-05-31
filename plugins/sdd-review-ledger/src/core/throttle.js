"use strict"

const fs = require("fs")
const path = require("path")

// Active reminder state.
// Default policy is intentionally simple: every relevant code / SDD-doc edit may
// remind. A missed review is worse than a repeated nudge. We only suppress an
// identical pending-set reminder inside a tiny time window, which avoids duplicate
// output from near-simultaneous multi-file writes without muting later changes.
// The optional SDD_REVIEW_SESSION_MAX_REMINDERS env var still acts as a hard cap
// for teams that explicitly want a quieter mode; 0 means passive todo only.

const emptyThrottle = () => ({
  batch: 0,
  sent: 0,
  lastRemindedBatch: null,
  lastReminderSignature: "",
  lastReminderAtMs: 0,
})

const throttlePath = (stateDir, sessionKey) => path.join(stateDir, `throttle-${sessionKey}.json`)

const loadThrottle = (stateDir, sessionKey) => {
  try {
    const data = JSON.parse(fs.readFileSync(throttlePath(stateDir, sessionKey), "utf8"))
    return {
      batch: Number.isFinite(data.batch) ? data.batch : 0,
      sent: Number.isFinite(data.sent) ? data.sent : 0,
      lastRemindedBatch: Number.isFinite(data.lastRemindedBatch) ? data.lastRemindedBatch : null,
      lastReminderSignature: typeof data.lastReminderSignature === "string" ? data.lastReminderSignature : "",
      lastReminderAtMs: Number.isFinite(data.lastReminderAtMs) ? data.lastReminderAtMs : 0,
    }
  } catch {
    return emptyThrottle() // missing/corrupt → fresh (throttle loss is benign)
  }
}

const saveThrottle = (stateDir, sessionKey, state) => {
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(throttlePath(stateDir, sessionKey), JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

// Pure: a new user turn opens a new batch.
const bumpBatch = (state) => ({ ...state, batch: (state.batch || 0) + 1 })

// Pure decision for an active reminder. Returns { remind, state }.
// remind iff there is something to review and the optional cap is not reached.
const decideReminder = (state, { hasNeeds, maxReminders, signature = "", nowMs = Date.now(), dedupeMs = 0 }) => {
  const cur = state || emptyThrottle()
  const duplicate =
    signature &&
    signature === cur.lastReminderSignature &&
    dedupeMs > 0 &&
    Number.isFinite(cur.lastReminderAtMs) &&
    nowMs - cur.lastReminderAtMs >= 0 &&
    nowMs - cur.lastReminderAtMs < dedupeMs
  const remind = !!hasNeeds && !duplicate && maxReminders > 0 && (cur.sent || 0) < maxReminders
  if (!remind) return { remind: false, state: cur }
  return {
    remind: true,
    state: {
      ...cur,
      sent: (cur.sent || 0) + 1,
      lastRemindedBatch: cur.batch,
      lastReminderSignature: signature || cur.lastReminderSignature || "",
      lastReminderAtMs: nowMs,
    },
  }
}

module.exports = {
  emptyThrottle,
  throttlePath,
  loadThrottle,
  saveThrottle,
  bumpBatch,
  decideReminder,
}
