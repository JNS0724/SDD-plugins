"use strict"

const { readConfig } = require("../core/config")
const { buildStopBlock } = require("../core/prompts")
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
  if (needs.length === 0) return { block: false, text: "", result }
  if (ctx.stopHookActive) return { block: false, text: "", result } // already blocked once → let it finish

  return { block: true, text: buildStopBlock(needs), result }
}

module.exports = { onStop }
