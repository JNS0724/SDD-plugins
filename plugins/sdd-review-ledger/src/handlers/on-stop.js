"use strict"

const { readConfig } = require("../core/config")
const { resolveStateDir } = require("../core/state-dir")
const { resolveSessionKey } = require("../core/session-key")
const { loadThrottle } = require("../core/throttle")
const { buildStopBlock, buildLeftoverStopBlock } = require("../core/prompts")
const { selectActiveNeeds, selectReviewLeftover } = require("../core/compute")
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

  // 改进 B: code that still needs review → full fact-forcing protocol. A doc change ahead
  // of code is a plan (recorded in the todo by run() above), so it does NOT block by itself.
  const activeNeeds = selectActiveNeeds(needs)
  if (activeNeeds.length > 0) return { block: true, text: buildStopBlock(activeNeeds), result }

  // T2 折中兜底: no code pending, but a review fired THIS turn and the model then created
  // NEW pending (e.g. ticked tasks.md mid-review → new hash). Surface a SHORT leftover hint
  // naming only the post-review path@hash. Pure doc planning with no review this turn never
  // reaches here (remindedThisTurn is false), so 改进 B's "planning is quiet" is preserved.
  const throttle = loadThrottle(resolveStateDir(ctx.repoRoot), resolveSessionKey(ctx.event || {}, env, ctx.repoRoot))
  const remindedThisTurn = throttle.lastRemindedBatch !== null && throttle.lastRemindedBatch === throttle.batch
  if (remindedThisTurn) {
    const leftover = selectReviewLeftover(needs, throttle.reviewBaselinePending)
    if (leftover.length > 0) return { block: true, text: buildLeftoverStopBlock(leftover), result }
  }

  return { block: false, text: "", result }
}

module.exports = { onStop }
