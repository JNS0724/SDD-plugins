"use strict"

const crypto = require("crypto")
const path = require("path")

// R2 #2: resolve a STABLE throttle session key with multi-level fallback.
// Ported from GateGuard resolveSessionKey (hook 79-96). This is the throttle
// dimension key (§9.3) — orthogonal to the per-project ledger. A blank/unstable
// key would cross-talk or defeat throttling, so we always return something stable.

const hashKey = (prefix, value) =>
  `${prefix}-${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`

const sanitizeSessionKey = (value) => {
  const raw = String(value == null ? "" : value).trim()
  if (!raw) return ""
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (sanitized && sanitized.length <= 64) return sanitized
  return hashKey("sid", raw)
}

// event: the raw hook event; env: process.env; repoRoot: final fallback fingerprint.
const resolveSessionKey = (event = {}, env = {}, repoRoot) => {
  const direct = [
    event && event.session_id,
    event && event.sessionId,
    event && event.session && event.session.id,
    env.CLAUDE_SESSION_ID,
    env.SDD_REVIEW_SESSION_ID,
  ]
  for (const candidate of direct) {
    const s = sanitizeSessionKey(candidate)
    if (s) return s
  }
  const transcript = (event && (event.transcript_path || event.transcriptPath)) || env.CLAUDE_TRANSCRIPT_PATH
  if (transcript && String(transcript).trim()) {
    return hashKey("tx", path.resolve(String(transcript).trim()))
  }
  const fingerprint = repoRoot || env.CLAUDE_PROJECT_DIR || process.cwd()
  return hashKey("proj", path.resolve(fingerprint))
}

module.exports = { sanitizeSessionKey, hashKey, resolveSessionKey }
