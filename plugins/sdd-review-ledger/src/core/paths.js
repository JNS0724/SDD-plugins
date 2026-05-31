"use strict"

const path = require("path")

// Ported from sibling sdd-drift-check/src/core/paths.js, plus R2 #8 sanitizePath.

const toPosix = (fp) => String(fp == null ? "" : fp).replace(/\\/g, "/")

const isCaseInsensitiveFs = () => process.platform === "win32" || process.platform === "darwin"

const normalizeKey = (fp) => {
  const normalized = toPosix(path.resolve(fp))
  return isCaseInsensitiveFs() ? normalized.toLowerCase() : normalized
}

const samePath = (left, right) => normalizeKey(left) === normalizeKey(right)

// repo-relative posix path (the ledger key form). Always forward slashes.
const rel = (root, fp) => toPosix(path.relative(root, fp))

const resolveFile = (root, fp) => (path.isAbsolute(fp) ? path.normalize(fp) : path.resolve(root, fp))

// R2 #8: render-side path sanitization. Ported from GateGuard hook 245-255.
// Strips ASCII control chars, bidi-override chars, and newlines; truncates to 500.
// Used before a path is written into the human-visible todo or the system-reminder.
const MAX_RENDERED_PATH = 500

const sanitizePath = (fp) => {
  const input = String(fp == null ? "" : fp)
  let out = ""
  for (const ch of input) {
    const code = ch.codePointAt(0)
    const isAsciiControl = code <= 0x1f || code === 0x7f
    const isBidiOverride =
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    out += isAsciiControl || isBidiOverride ? " " : ch
  }
  return out.trim().slice(0, MAX_RENDERED_PATH)
}

module.exports = {
  MAX_RENDERED_PATH,
  isCaseInsensitiveFs,
  normalizeKey,
  rel,
  resolveFile,
  samePath,
  sanitizePath,
  toPosix,
}
