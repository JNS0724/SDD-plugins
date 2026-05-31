"use strict"

const fs = require("fs")
const crypto = require("crypto")

// writeTextAtomic: tmp + renameSync (same dir). Ported from sibling state-storage,
// with two deliberate changes from the design:
//   - CUT the non-atomic writeFileSync fallback (§5.2): a failed rename must NOT
//     degrade to a torn direct write. Losing a write is fail-safe here (re-review).
//   - KEEP a Windows EEXIST/EPERM unlink-retry (R2 #3b): on Windows, renameSync over
//     an existing file throws EEXIST/EPERM. Without unlink+retry, every overwrite
//     fails → fail-open skips the write → ledger frozen at initial state = systemic
//     false-clean. So we unlink the target and retry the rename exactly once.

const writeTextAtomic = (filePath, text) => {
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`
  try {
    fs.writeFileSync(tmp, text)
    try {
      fs.renameSync(tmp, filePath)
    } catch (err) {
      if (err && (err.code === "EEXIST" || err.code === "EPERM")) {
        try {
          fs.unlinkSync(filePath)
        } catch {
          /* ignore */
        }
        fs.renameSync(tmp, filePath) // retry once (Windows overwrite path)
      } else {
        throw err
      }
    }
    return true
  } catch {
    // rename failed for real → give up this round (NO non-atomic fallback).
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore stray tmp */
    }
    return false
  }
}

module.exports = { writeTextAtomic }
