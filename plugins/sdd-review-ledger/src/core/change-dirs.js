"use strict"

const fs = require("fs")
const path = require("path")
const { toPosix, rel } = require("./paths")

// discoverChangeDirs(repoRoot) -> ChangeDir[]   (detailed-design §6.2)
// Walks {sdd,.sdd}/changes/* directories, drops archived ones, and lists the
// docs each contains plus the first non-empty line of design.md (delivery summary).

const CHANGE_PARENTS = ["sdd/changes", ".sdd/changes"]
const DOC_NAMES = ["proposal.md", "design.md", "tasks.md"]

const firstNonEmptyLine = (absFile) => {
  let text
  try {
    text = fs.readFileSync(absFile, "utf8")
  } catch {
    return ""
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ""
}

// isArchived: ported intent from sibling isArchivedChangeDir — dir name marker,
// an explicit ARCHIVED marker file, or `status: archived` in design.md frontmatter.
const isArchived = (absDir) => {
  const base = path.basename(absDir).toLowerCase()
  if (base.startsWith("archived") || base.startsWith("_archived") || base.endsWith(".archived")) return true
  if (fs.existsSync(path.join(absDir, "ARCHIVED")) || fs.existsSync(path.join(absDir, ".archived"))) return true
  try {
    const design = fs.readFileSync(path.join(absDir, "design.md"), "utf8").slice(0, 400)
    if (/^\s*status:\s*archived\s*$/im.test(design)) return true
  } catch {
    /* no design.md / unreadable → not archived by this signal */
  }
  return false
}

const listChangeDirs = (repoRoot) => {
  const dirs = []
  for (const parentRel of CHANGE_PARENTS) {
    const parentAbs = path.join(repoRoot, parentRel)
    let entries
    try {
      entries = fs.readdirSync(parentAbs, { withFileTypes: true })
    } catch {
      continue // parent missing → no change dirs there
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(parentAbs, entry.name))
    }
  }
  return dirs
}

const discoverChangeDirs = (repoRoot) => {
  const out = []
  for (const absDir of listChangeDirs(repoRoot)) {
    if (isArchived(absDir)) continue
    const docs = DOC_NAMES.filter((name) => {
      try {
        return fs.statSync(path.join(absDir, name)).isFile()
      } catch {
        return false
      }
    })
    out.push({
      relDir: toPosix(rel(repoRoot, absDir)),
      absDir,
      docs,
      designFirstLine: firstNonEmptyLine(path.join(absDir, "design.md")),
    })
  }
  // Stable order: by relDir so compute output is deterministic.
  out.sort((a, b) => (a.relDir < b.relDir ? -1 : a.relDir > b.relDir ? 1 : 0))
  return out
}

module.exports = {
  CHANGE_PARENTS,
  DOC_NAMES,
  discoverChangeDirs,
  firstNonEmptyLine,
  isArchived,
}
