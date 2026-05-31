"use strict"

const fs = require("fs")
const crypto = require("crypto")
const { DEFAULT_HASH_LEN } = require("./config")

// Whole-file content hash (detailed-design §6.1, §13#3).
// Title/paragraph/format changes are just "this file changed" — zero anchor discipline.
// markdown and code are hashed identically.

// Pure: hash of an in-memory buffer/string. Used by tests and by hashElement.
const hashBuffer = (buf, hashLen = DEFAULT_HASH_LEN) =>
  crypto.createHash("sha256").update(buf).digest("hex").slice(0, hashLen)

// hashElement(absPath) -> string | null  (null = file does not exist / unreadable)
const hashElement = (absPath, hashLen = DEFAULT_HASH_LEN) => {
  let buf
  try {
    buf = fs.readFileSync(absPath)
  } catch {
    return null
  }
  return hashBuffer(buf, hashLen)
}

module.exports = {
  hashBuffer,
  hashElement,
}
