"use strict"

const { readConfig } = require("../core/config")
const { resolveStateDir } = require("../core/state-dir")
const { resolveSessionKey } = require("../core/session-key")
const { loadThrottle, saveThrottle, bumpBatch } = require("../core/throttle")
const { buildCarryOver } = require("../core/prompts")
const { run } = require("../pipeline")

// on-prompt (§9.4): a new user turn. Open a new batch (so the next edit may remind
// again), refresh ledger + todo via the pipeline, and — if anything is pending —
// inject a compact cross-session carry-over summary (this is how历史 unreviewed
// changes resurface in a fresh session; bounded to once per turn).
const onPrompt = (ctx) => {
  const env = ctx.env || process.env
  const cfg = readConfig(env)
  if (cfg.disabled) return { deliver: false, text: "" }

  // bump batch first so an edit later this turn is eligible for an active reminder.
  const stateDir = resolveStateDir(ctx.repoRoot)
  const sessionKey = resolveSessionKey(ctx.event || {}, env, ctx.repoRoot)
  saveThrottle(stateDir, sessionKey, bumpBatch(loadThrottle(stateDir, sessionKey)))

  const result = run(ctx)
  if (result.action === "silent") return { deliver: false, text: "", result }
  const needs = result.needs || []
  if (needs.length === 0) return { deliver: false, text: "", result }
  return { deliver: true, text: buildCarryOver(needs), result }
}

module.exports = { onPrompt }
