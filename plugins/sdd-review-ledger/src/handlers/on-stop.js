"use strict"

const { readConfig } = require("../core/config")
const { buildStopBlock } = require("../core/prompts")
const { selectActiveNeeds } = require("../core/compute")
const { run } = require("../pipeline")

// on-stop (改进三 P0): end-of-turn SDD-sync safety net. Always refresh ledger+todo;
// if unreviewed SDD changes remain AND this stop was not already triggered by our own
// block, request a SINGLE block so the model reviews before finishing. stopHookActive
// guarantees at-most-one block per stop chain → no wedge loop. Fail-open: any silent
// pipeline result (non-SDD / disabled / error) → never block.
//
// Platform note: on Claude Code the caller turns { block, text } into a Stop
// `decision:"block"` with `reason=text`. OpenCode cannot reliably force-continue at
// idle (gateguard-lessons §7.1), so its adapter uses this only to refresh + log, and
// enforcement degrades to the next chat.message carry-over.
const onStop = (ctx) => {
  const env = ctx.env || process.env
  const cfg = readConfig(env)
  if (cfg.disabled) return { block: false, text: "" }

  const result = run(ctx) // refresh ledger + todo regardless of whether we block
  if (result.action === "silent") return { block: false, text: "", result }

  const needs = result.needs || []
  // 改进 B: the end-of-turn sweep only blocks on CODE that still needs review. A doc
  // change ahead of code is a plan (recorded in the todo by run() above), so it never
  // blocks the turn end — that would just re-introduce the "editing a design doc nags
  // you" behavior at the boundary.
  const activeNeeds = selectActiveNeeds(needs)
  if (activeNeeds.length === 0) return { block: false, text: "", result }
  if (ctx.stopHookActive) return { block: false, text: "", result } // already blocked once → let it finish

  return { block: true, text: buildStopBlock(activeNeeds), result }
}

module.exports = { onStop }
