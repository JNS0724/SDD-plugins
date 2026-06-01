"use strict"

const { readConfig } = require("../core/config")
const { resolveStateDir } = require("../core/state-dir")
const { resolveSessionKey } = require("../core/session-key")
const { loadThrottle, saveThrottle, decideReminder } = require("../core/throttle")
const { discoverChangeDirs } = require("../core/change-dirs")
const { selectActiveNeeds } = require("../core/compute")
const { classifyPath } = require("../core/classify")
const { buildReminder, buildCompactReminder } = require("../core/prompts")
const { run } = require("../pipeline")

// The active-reminder dedupe key is the pending PATH-SET, not path@hash (改进一).
const reminderPathSet = (needs) => [...new Set(needs.map((item) => item.path))].sort()

// on-edit (§9.1): main channel. Run the pipeline (writes ledger + todo, always),
// then decide whether to ALSO emit an active reminder on this edit's tool result.
// 改进一：同回合内 pending 路径集无增长 → 抑制；路径集增长或新回合 → 提醒。
// 改进二：每回合首条提醒发完整协议，同回合后续（仅在路径集增长时触发）发精简体。
// Housekeeping writes like .sdd-review-todo.md still ingest/refresh state, but do
// not trigger an active reminder.
const onEdit = (ctx) => {
  const result = run(ctx) // pipeline is fail-open; never throws
  if (result.action === "silent") return { deliver: false, text: "", result }

  const needs = result.needs || []
  // 改进 B: only CODE changes drive the active reminder. A doc change (design/tasks
  // ahead of code) is a plan, not a build order — it rides in the passive todo (already
  // written by run()) but never actively nags here. The full `needs` still backs the todo.
  const activeNeeds = selectActiveNeeds(needs)
  const env = ctx.env || process.env
  const cfg = readConfig(env)

  // disabled is already handled inside run(); guard the active channel too.
  if (cfg.disabled) return { deliver: false, text: "", result }

  const stateDir = resolveStateDir(ctx.repoRoot)
  const sessionKey = resolveSessionKey(ctx.event || {}, env, ctx.repoRoot)
  let throttle = loadThrottle(stateDir, sessionKey)

  // Active-channel invariant: a path leaves the active set only when it is reviewed/acked
  // (checkoff) or gone. Prune such paths from lastRemindedPathSet BEFORE deciding, so
  // a later same-turn re-edit of a checked-off file counts as growth and re-fires —
  // rather than being masked as a no-growth re-hash (which is the suppressed case).
  const pendingPaths = reminderPathSet(activeNeeds)
  const pendingSet = new Set(pendingPaths)
  const reminded = throttle.lastRemindedPathSet || []
  const prunedReminded = reminded.filter((p) => pendingSet.has(p))
  if (prunedReminded.length !== reminded.length) {
    throttle = { ...throttle, lastRemindedPathSet: prunedReminded }
    saveThrottle(stateDir, sessionKey, throttle)
  }

  if (activeNeeds.length === 0) return { deliver: false, text: "", result }
  if (ctx.editedPath && classifyPath(ctx.editedPath) === "other") {
    return { deliver: false, text: "", result }
  }

  // First active reminder of THIS turn → full protocol; a later same-turn growth → compact.
  const firstThisTurn = throttle.lastRemindedBatch !== throttle.batch
  const decision = decideReminder(throttle, {
    hasNeeds: true,
    maxReminders: cfg.sessionMaxReminders,
    pathSet: pendingPaths,
    mode: cfg.reminderMode,
    nowMs: ctx.nowMs || Date.now(),
  })
  if (!decision.remind) return { deliver: false, text: "", result }

  saveThrottle(stateDir, sessionKey, decision.state)

  if (!firstThisTurn) {
    // Already showed the full protocol earlier this turn; a growth re-fire is lean.
    return { deliver: true, text: buildCompactReminder(activeNeeds), result }
  }

  // design first-line context for referenced change-dirs (full reminder only).
  const designFirstLineByDir = {}
  for (const d of discoverChangeDirs(ctx.repoRoot)) {
    if (d.designFirstLine) designFirstLineByDir[d.relDir] = d.designFirstLine
  }
  return { deliver: true, text: buildReminder(activeNeeds, designFirstLineByDir), result }
}

module.exports = { onEdit, reminderPathSet }
