"use strict"

const { readConfig } = require("../core/config")
const { resolveStateDir } = require("../core/state-dir")
const { resolveSessionKey } = require("../core/session-key")
const { loadThrottle, saveThrottle, decideReminder } = require("../core/throttle")
const { discoverChangeDirs } = require("../core/change-dirs")
const { buildReminder } = require("../core/prompts")
const { run } = require("../pipeline")

// on-edit (§9.1): main channel. Run the pipeline (writes ledger + todo, always),
// then decide — under the throttle + batch boundary — whether to ALSO emit an
// active fact-forcing reminder on this edit's tool result.
const onEdit = (ctx) => {
  const result = run(ctx) // pipeline is fail-open; never throws
  if (result.action === "silent") return { deliver: false, text: "", result }

  const needs = result.needs || []
  const env = ctx.env || process.env
  const cfg = readConfig(env)

  // disabled is already handled inside run(); guard the active channel too.
  if (cfg.disabled || needs.length === 0) return { deliver: false, text: "", result }

  const stateDir = resolveStateDir(ctx.repoRoot)
  const sessionKey = resolveSessionKey(ctx.event || {}, env, ctx.repoRoot)
  const throttle = loadThrottle(stateDir, sessionKey)
  const decision = decideReminder(throttle, { hasNeeds: true, maxReminders: cfg.sessionMaxReminders })
  if (!decision.remind) return { deliver: false, text: "", result }

  saveThrottle(stateDir, sessionKey, decision.state)

  // design first-line context for referenced change-dirs.
  const designFirstLineByDir = {}
  for (const d of discoverChangeDirs(ctx.repoRoot)) {
    if (d.designFirstLine) designFirstLineByDir[d.relDir] = d.designFirstLine
  }
  return { deliver: true, text: buildReminder(needs, designFirstLineByDir), result }
}

module.exports = { onEdit }
