"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")

// R1 §6.2: locate repo root WITHOUT requiring git. `.git` is just one marker among
// several; a repo with no `.git` must still work. State dir lives next to it.

const STATE_DIRNAME = "sdd-review-ledger-state"
const TODO_FILENAME = ".sdd-review-todo.md"
const LEDGER_FILENAME = "ledger.json"

// Priority order is informational; we return the NEAREST ancestor containing any.
const REPO_MARKERS = [".git", "sdd", ".sdd", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", `.${STATE_DIRNAME}`]

const hasMarker = (dir) => REPO_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))

const findRepoRoot = (cwd) => {
  let current = path.resolve(cwd)
  while (true) {
    if (hasMarker(current)) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(cwd) // no marker anywhere → use cwd
}

const ensureDir = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

// State dir candidates (§四): inside .git if present, else dotted at repo root,
// else OS temp. Returns the first one we can create.
const stateDirCandidates = (repoRoot) => {
  const candidates = []
  if (fs.existsSync(path.join(repoRoot, ".git"))) {
    candidates.push(path.join(repoRoot, ".git", STATE_DIRNAME))
  }
  candidates.push(path.join(repoRoot, `.${STATE_DIRNAME}`))
  candidates.push(path.join(os.tmpdir(), STATE_DIRNAME))
  return candidates
}

const resolveStateDir = (repoRoot) => {
  const candidates = stateDirCandidates(repoRoot)
  for (const c of candidates) {
    if (ensureDir(c)) return c
  }
  return candidates[candidates.length - 1]
}

const ledgerPathFor = (repoRoot) => path.join(resolveStateDir(repoRoot), LEDGER_FILENAME)
const todoPathFor = (repoRoot) => path.join(repoRoot, TODO_FILENAME)

module.exports = {
  STATE_DIRNAME,
  TODO_FILENAME,
  LEDGER_FILENAME,
  REPO_MARKERS,
  findRepoRoot,
  hasMarker,
  ensureDir,
  stateDirCandidates,
  resolveStateDir,
  ledgerPathFor,
  todoPathFor,
}
