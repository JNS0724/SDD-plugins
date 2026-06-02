"use strict"

const fs = require("fs")
const { resolveFile, rel, sanitizePath } = require("./paths")

// Project-level review-rules loading (扩展 A+B). The shipped sdd-review-rules.md is a
// human reference / template; the RUNTIME extension surface is a USER-provided rules
// file resolved here and injected as an optional "项目附加规则" segment (prompts.js),
// so custom rules actually reach the model instead of relying on it to Read a file.
//
// Invariants:
//   §1 fail-open — any miss / fs error / oversize / binary → null (segment absent),
//      never throws, never blocks. Default (no env, no repo-root file) → null → the
//      reminder is byte-identical to before.
//   §2 mechanical only — we read bytes, cap, sanitize, and hand the TEXT to the model.
//      The tool never interprets the rules or judges drift from them; resolution is a
//      fixed mechanical priority, not a semantic choice.
//
// Resolution priority (both are paths the model can also Read, matching the documented
//   "放 repo 根 / 用 SDD_REVIEW_RULES_FILE 指向" override):
//   1) cfg.rulesFile (env SDD_REVIEW_RULES_FILE), absolute or repoRoot-relative
//   2) repoRoot/sdd-review-rules.md

const RULES_DEFAULT_BASENAME = "sdd-review-rules.md"
const MAX_RULES_BYTES = 4096 // hard ceiling on the injected addendum (opt-in cost guard)
const MAX_RULES_LINES = 60
const MAX_RULES_LINE_CHARS = 500

// Mechanical existence check for one candidate. Returns the abs path or null. Fail-open.
const existingFile = (abs) => {
  try {
    return fs.statSync(abs).isFile() ? abs : null
  } catch {
    return null
  }
}

// Resolve the project rules file path by mechanical priority. null if none exists.
const resolveRulesPath = (repoRoot, cfg) => {
  try {
    const fromEnv = cfg && cfg.rulesFile
    if (fromEnv) {
      const hit = existingFile(resolveFile(repoRoot, fromEnv))
      if (hit) return hit
    }
    return existingFile(resolveFile(repoRoot, RULES_DEFAULT_BASENAME))
  } catch {
    return null
  }
}

// Strip ASCII control + bidi-override (→ spaces, keep indentation), and neutralize any
// system-reminder tag so a rules file cannot break out of the injected <system-reminder>
// block. Length-capped. Does NOT trim (preserve markdown indentation).
const sanitizeRulesLine = (line) => {
  const defanged = String(line == null ? "" : line).replace(
    /<\s*\/?\s*system-reminder\b[^>]*>/gi,
    (m) => m.replace(/</g, "＜").replace(/>/g, "＞"),
  )
  let out = ""
  for (const ch of defanged) {
    const code = ch.codePointAt(0)
    const isAsciiControl = code <= 0x1f || code === 0x7f
    const isBidiOverride =
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    out += isAsciiControl || isBidiOverride ? " " : ch
  }
  return out.slice(0, MAX_RULES_LINE_CHARS)
}

// Read at most MAX_RULES_BYTES+1 bytes (the +1 lets us detect truncation) without
// loading a potentially huge file. Returns a Buffer of the bytes read, or null on error.
const readCapped = (abs) => {
  let fd = null
  try {
    fd = fs.openSync(abs, "r")
    const buf = Buffer.alloc(MAX_RULES_BYTES + 1)
    const bytesRead = fs.readSync(fd, buf, 0, MAX_RULES_BYTES + 1, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

// repo-relative posix path when under repoRoot, else the absolute path — both reachable
// to the model. Sanitized so it is safe inside the reminder.
const relPathLabel = (repoRoot, abs) => {
  try {
    const r = rel(repoRoot, abs)
    if (r && !r.startsWith("..")) return sanitizePath(r)
  } catch {
    /* fall through to absolute */
  }
  return sanitizePath(abs)
}

// readProjectRules(repoRoot, cfg) -> { relPath, text, truncated } | null. Fail-open.
const readProjectRules = (repoRoot, cfg) => {
  const abs = resolveRulesPath(repoRoot, cfg)
  if (!abs) return null

  const raw = readCapped(abs)
  if (!raw) return null

  const overByBytes = raw.length > MAX_RULES_BYTES
  const content = raw.subarray(0, Math.min(raw.length, MAX_RULES_BYTES))

  // Binary guard: a NUL byte means this is not a text rules file.
  if (content.includes(0x00)) return null

  let lines = content.toString("utf8").split("\n").map(sanitizeRulesLine)
  // If we cut on a byte boundary mid-file, the last line may be partial → drop it
  // (only when there is more than one line, so a single short rule is not lost).
  if (overByBytes && lines.length > 1) lines = lines.slice(0, -1)

  const overByLines = lines.length > MAX_RULES_LINES
  if (overByLines) lines = lines.slice(0, MAX_RULES_LINES)

  // Trim trailing blank lines for a tidy segment.
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()
  const text = lines.join("\n")
  if (!text.trim()) return null

  return { relPath: relPathLabel(repoRoot, abs), text, truncated: overByBytes || overByLines }
}

module.exports = {
  RULES_DEFAULT_BASENAME,
  MAX_RULES_BYTES,
  MAX_RULES_LINES,
  MAX_RULES_LINE_CHARS,
  resolveRulesPath,
  sanitizeRulesLine,
  readProjectRules,
}
