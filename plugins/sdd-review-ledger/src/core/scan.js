"use strict"

const fs = require("fs")
const path = require("path")
const { toPosix, rel } = require("./paths")
const { classifyPath } = require("./classify")

// scanWorkTree(repoRoot, ledger, cfg, opts) -> { codePaths, truncated, skipped, hashCache }
// R1: working-tree filesystem scan replaces gitChangedFiles. Pure function of the
// working tree (NOT git refs) → restores computeNeedsReview as a true pure function.
// mtime is ONLY a "should I re-hash" skip hint (§4.3) — never truth.

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".claude",
  ".home",
  ".opencode",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".gradle",
  ".idea",
  ".cache",
  ".sdd-review-ledger-state",
  "sdd-review-ledger-state",
])

// A directory name is ignored if it's in the default set or matches a user glob.
// Trailing-slash entries (e.g. "vendor/") are treated as dir-name matches; the rest
// as path substrings.
const makeDirIgnored = (ignoreGlobs) => {
  const extraDirs = new Set()
  const extraSubstrings = []
  for (const g of ignoreGlobs || []) {
    const trimmed = g.replace(/^\.\//, "")
    if (trimmed.endsWith("/")) extraDirs.add(trimmed.slice(0, -1))
    else extraSubstrings.push(trimmed)
  }
  return (name, relPosix) => {
    if (DEFAULT_IGNORE_DIRS.has(name) || extraDirs.has(name)) return true
    return extraSubstrings.some((s) => relPosix.includes(s))
  }
}

// Wall clock in ms, injectable for deterministic budget tests.
const defaultNow = () => Number(process.hrtime.bigint() / 1000000n)

const scanWorkTree = (repoRoot, ledger, cfg = {}, opts = {}) => {
  const maxFileBytes = cfg.maxFileBytes || 2 * 1024 * 1024
  const budgetMs = cfg.scanBudgetMs || 1500
  const alwaysHash = !!cfg.scanAlwaysHash
  const now = opts.now || defaultNow
  const dirIgnored = makeDirIgnored(cfg.ignoreGlobs)

  // Scan roots: default repoRoot, or restricted subtrees (§4.2).
  const roots =
    cfg.scanRoots && cfg.scanRoots.length
      ? cfg.scanRoots.map((r) => path.resolve(repoRoot, r))
      : [repoRoot]

  const codePaths = []
  const hashCache = {} // relKey -> { size, mtimeMs } for files we statted (mtime gate)
  let truncated = false
  let skipped = 0
  const start = now()

  const stack = [...roots]
  while (stack.length) {
    if (now() - start > budgetMs) {
      // §4.4: never silent — count what we did not get to (approx: remaining stack).
      truncated = true
      skipped += stack.length
      break
    }
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const relPosix = toPosix(rel(repoRoot, abs))
      if (entry.isDirectory()) {
        if (dirIgnored(entry.name, relPosix)) continue
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (classifyPath(relPosix) !== "code") continue

      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (stat.size > maxFileBytes) {
        skipped += 1
        continue
      }
      codePaths.push(relPosix)
      // mtime/size skip hint for compute: if record matches, compute may reuse hash.
      if (!alwaysHash) hashCache[relPosix] = { size: stat.size, mtimeMs: stat.mtimeMs }
    }
  }

  codePaths.sort()
  return { codePaths, truncated, skipped, hashCache }
}

module.exports = {
  DEFAULT_IGNORE_DIRS,
  makeDirIgnored,
  scanWorkTree,
}
