"use strict"

const fs = require("fs")
const path = require("path")

// Throttle state for active reminders (§9.3 + R2 #11 batch boundary).
//   batch              — increments once per user turn (on-prompt bumps it)
//   sent               — total active reminders this session
//   lastRemindedBatch  — the batch in which we last actively reminded
// "Batch" = the run of consecutive edits within one user turn. Per-batch ≤ 1
// active reminder; per-session ≤ maxReminders. Passive todo is refreshed every
// run regardless (that happens in the pipeline, not here).

const emptyThrottle = () => ({ batch: 0, sent: 0, lastRemindedBatch: null })

const throttlePath = (stateDir, sessionKey) => path.join(stateDir, `throttle-${sessionKey}.json`)

const loadThrottle = (stateDir, sessionKey) => {
  try {
    const data = JSON.parse(fs.readFileSync(throttlePath(stateDir, sessionKey), "utf8"))
    return {
      batch: Number.isFinite(data.batch) ? data.batch : 0,
      sent: Number.isFinite(data.sent) ? data.sent : 0,
      lastRemindedBatch: Number.isFinite(data.lastRemindedBatch) ? data.lastRemindedBatch : null,
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
// remind iff: there is something to review, the session cap isn't reached, and we
// have NOT already reminded in this batch (the R2 #11 batch boundary).
const decideReminder = (state, { hasNeeds, maxReminders }) => {
  const cur = state || emptyThrottle()
  const remind = !!hasNeeds && (cur.sent || 0) < maxReminders && cur.lastRemindedBatch !== cur.batch
  if (!remind) return { remind: false, state: cur }
  return { remind: true, state: { ...cur, sent: (cur.sent || 0) + 1, lastRemindedBatch: cur.batch } }
}

module.exports = {
  emptyThrottle,
  throttlePath,
  loadThrottle,
  saveThrottle,
  bumpBatch,
  decideReminder,
}
