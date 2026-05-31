"use strict"

const path = require("path")
const { toPosix } = require("./paths")

// classifyPath: code | sdd-doc | other  (detailed-design §三, §八)
// - sdd-doc: proposal.md / design.md / tasks.md under a sdd|.sdd /changes/ tree
// - code:    source extensions (ported from sibling file-classifier) but NOT under sdd tree
// - other:   everything else (lockfiles, binaries, non-source, config)

// Ported CODE_EXT from sibling sdd-drift-check/src/core/file-classifier.js.
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)$/i

const SDD_DOC_NAMES = new Set(["proposal.md", "design.md", "tasks.md"])

const inSddTree = (posix) =>
  posix.includes("/sdd/") || posix.includes("/.sdd/") || posix.startsWith("sdd/") || posix.startsWith(".sdd/")

const inSddChanges = (posix) =>
  posix.includes("/sdd/changes/") ||
  posix.includes("/.sdd/changes/") ||
  posix.startsWith("sdd/changes/") ||
  posix.startsWith(".sdd/changes/")

// Accepts a repo-relative OR absolute path; classification is by shape, not IO.
const classifyPath = (fp) => {
  const posix = toPosix(fp)
  const base = path.posix.basename(posix).toLowerCase()

  if (inSddChanges(posix) && SDD_DOC_NAMES.has(base)) return "sdd-doc"
  // A source-extension file outside the sdd tree is code.
  if (CODE_EXT.test(posix) && !inSddTree(posix)) return "code"
  return "other"
}

module.exports = {
  CODE_EXT,
  SDD_DOC_NAMES,
  classifyPath,
  inSddChanges,
  inSddTree,
}
