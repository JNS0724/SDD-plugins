"use strict"

const fs = require("fs")
const path = require("path")
const { readConfig } = require("../core/config")
const { serializeLedger } = require("../core/ledger")
const { writeTextAtomic } = require("../core/atomic")
const { ledgerPathFor, todoPathFor, STATE_DIRNAME, TODO_FILENAME } = require("../core/state-dir")
const { renderTodo } = require("../core/todo")
const { computeNeedsReview } = require("../core/compute")
const { bootstrapIfEmpty, loadLedgerFile, runInner } = require("../pipeline")

// .gitignore lines that must be kept consistent (§四 hard rule): ledger state dir
// and the todo file. init appends whichever is missing.
const GITIGNORE_LINES = [`.${STATE_DIRNAME}/`, TODO_FILENAME]

const ensureGitignore = (repoRoot) => {
  const gitignorePath = path.join(repoRoot, ".gitignore")
  let existing = ""
  try {
    existing = fs.readFileSync(gitignorePath, "utf8")
  } catch {
    /* no .gitignore yet */
  }
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()))
  const toAdd = GITIGNORE_LINES.filter((l) => !present.has(l))
  if (toAdd.length === 0) return { changed: false, added: [] }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
  const block = `${prefix}# sdd-review-ledger\n${toAdd.join("\n")}\n`
  try {
    fs.appendFileSync(gitignorePath, block)
    return { changed: true, added: toAdd }
  } catch {
    return { changed: false, added: [] }
  }
}

// init: cold-start baseline of the current work tree + write .gitignore lines.
// Does NOT surface anything (honest "do not retro-judge existing", not "verified").
const init = (ctx) => {
  const env = ctx.env || process.env
  const cfg = readConfig(env)
  const repoRoot = ctx.repoRoot
  const now = ctx.now || new Date().toISOString()

  const ledgerPath = ledgerPathFor(repoRoot)
  const todoPath = todoPathFor(repoRoot)

  const current = loadLedgerFile(ledgerPath)
  const boot = bootstrapIfEmpty(repoRoot, current, cfg, now)
  const ledger = boot.ledger

  // After baseline, nothing should be pending — render the (empty) todo for visibility.
  const needs = computeNeedsReview(repoRoot, ledger, cfg)
  writeTextAtomic(ledgerPath, serializeLedger(ledger))
  writeTextAtomic(todoPath, renderTodo(needs.items, ledger))
  const gi = ensureGitignore(repoRoot)

  return {
    action: "init",
    bootstrapped: boot.bootstrapped,
    baselineCount: boot.count,
    pending: needs.items.length,
    gitignore: gi,
    ledgerPath,
    todoPath,
  }
}

// status: read-only — show what currently needs review (no writes).
const status = (ctx) => {
  const env = ctx.env || process.env
  const cfg = readConfig(env)
  const repoRoot = ctx.repoRoot
  const ledger = loadLedgerFile(ledgerPathFor(repoRoot))
  const needs = computeNeedsReview(repoRoot, ledger, cfg)
  return { action: "status", needs: needs.items, meta: needs.meta }
}

module.exports = {
  GITIGNORE_LINES,
  ensureGitignore,
  init,
  status,
  run: runInner,
}
