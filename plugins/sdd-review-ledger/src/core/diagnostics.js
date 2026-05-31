"use strict"

const fs = require("fs")
const path = require("path")

// Best-effort JSONL diagnostics. Never throws — diagnostics must never break the
// fail-open guarantee. One line per event.

const LOG_FILENAME = "sdd-review.log.jsonl"

const diag = (stateDir, event) => {
  if (!stateDir || !event) return
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"
    fs.appendFileSync(path.join(stateDir, LOG_FILENAME), line)
  } catch {
    /* diagnostics are best-effort; swallow */
  }
}

module.exports = { LOG_FILENAME, diag }
