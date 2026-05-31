"use strict"

const { classifyPath } = require("./classify")
const { withRecord } = require("./ledger")

// ingestCheckoffs(ledger, todoEntries, now, actor) -> ledger'   (detailed-design §6.5)
// Pure function: turns checked todo entries into verdicts, pinned to the INLINE
// hash (§5.3) — never the current on-disk hash — to stop cross-version false-clean.
// Editing a file never clears anything here (checkoff-only, §8.2): we only process [x].

const RATIONALE_MAX = 200

const clamp = (s, max) => String(s == null ? "" : s).slice(0, max)

// verdict label is display-only. We do NOT parse rationale meaning (§7.3);
// this is a coarse, optional tag derived from obvious keywords, default "reviewed".
const labelFromRationale = (rationale) => {
  const r = String(rationale || "").toLowerCase()
  if (/unrelated/.test(r) || /无关/.test(r)) return "unrelated"
  if (/no[- ]?change|gofmt|format|lint/.test(r) || /仅格式|无需改/.test(r)) return "no-change"
  if (/synced?|updated?/.test(r) || /已同步|已更新/.test(r)) return "synced"
  return "reviewed"
}

const ingestCheckoffs = (ledger, todoEntries, now, actor) => {
  let next = ledger
  for (const e of todoEntries) {
    if (!e.checked) continue // editing/unchecking never clears (checkoff-only)
    if (classifyPath(e.path) === "other") continue // not a tracked element
    next = withRecord(next, e.path, {
      kind: classifyPath(e.path),
      reviewedHash: e.inlineHash, // ★ pin to inline hash, not current hash
      verdict: labelFromRationale(e.rationale),
      rationale: clamp(e.rationale, RATIONALE_MAX),
      reviewedAt: now,
      by: actor || "agent",
    })
  }
  return next
}

module.exports = {
  RATIONALE_MAX,
  clamp,
  labelFromRationale,
  ingestCheckoffs,
}
