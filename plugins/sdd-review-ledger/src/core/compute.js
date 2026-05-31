"use strict"

const path = require("path")
const { hashElement } = require("./hash")
const { discoverChangeDirs } = require("./change-dirs")
const { scanWorkTree } = require("./scan")
const { getRecord } = require("./ledger")

// computeNeedsReview(repoRoot, ledger, cfg) -> { items, meta }   (detailed-design §6.3)
// THE CORE BET: a true pure function of (working tree, ledger). Same inputs at any
// trigger point → same output. Tool answers only the MECHANICAL question
// "hash(element) ≠ reviewedHash"; all semantic judgement is the LLM's at delivery.

const DOC_NAMES = ["design.md", "tasks.md", "proposal.md"]

const reasonFor = (record) => (record ? "changed-since-review" : "never-reviewed")

// mtime/size skip hint (R1 §4.3): if scan statted the file and (size,mtimeMs)
// match the ledger record, reuse the stored hash instead of re-reading.
// Safe: worst case (mtime lies) is a needless re-read, never a missed change.
const hashWithCache = (repoRoot, relPath, record, hashCache, hashLen) => {
  const hint = hashCache && hashCache[relPath]
  if (
    hint &&
    record &&
    record.reviewedHash &&
    typeof record.size === "number" &&
    typeof record.mtimeMs === "number" &&
    record.size === hint.size &&
    record.mtimeMs === hint.mtimeMs
  ) {
    return record.reviewedHash
  }
  return hashElement(path.join(repoRoot, relPath), hashLen)
}

const computeNeedsReview = (repoRoot, ledger, cfg = {}) => {
  const hashLen = cfg.hashLen || 16
  const items = []
  const changeDirs = discoverChangeDirs(repoRoot)
  const records = (ledger && ledger.records) || {}

  // —— Layer A + reverse: doc elements (found by scanning change dirs, not capture) ——
  for (const dir of changeDirs) {
    for (const docName of DOC_NAMES) {
      const relPath = `${dir.relDir}/${docName}`
      const abs = path.join(repoRoot, relPath)
      const h = hashElement(abs, hashLen)
      if (h === null) continue // doc not present
      const record = getRecord(ledger, relPath)
      if (h !== (record ? record.reviewedHash : undefined)) {
        items.push({
          path: relPath,
          kind: "sdd-doc",
          currentHash: h,
          candidates: [dir.relDir],
          reason: reasonFor(record),
        })
      }
    }
  }

  // —— Layer B: code —— pool = (ledger code keys still on disk) ∪ scanWorkTree ——
  const scan = scanWorkTree(repoRoot, ledger, cfg)
  const pool = new Set(scan.codePaths)
  for (const key of Object.keys(records)) {
    if (records[key] && records[key].kind === "code") {
      // include tracked code keys that still exist (covers ignore-excluded captured files)
      if (hashElement(path.join(repoRoot, key), hashLen) !== null) pool.add(key)
    }
  }

  const nonArchived = changeDirs.map((d) => d.relDir)
  for (const relPath of [...pool].sort()) {
    const record = getRecord(ledger, relPath)
    const h = hashWithCache(repoRoot, relPath, record, scan.hashCache, hashLen)
    if (h === null) continue // deleted between scan and hash → not tracked
    if (h !== (record ? record.reviewedHash : undefined)) {
      items.push({
        path: relPath,
        kind: "code",
        currentHash: h,
        candidates: nonArchived,
        reason: reasonFor(record),
      })
    }
  }

  const meta = scan.truncated ? { scanTruncated: true, skipped: scan.skipped } : {}
  return { items, meta }
}

module.exports = {
  DOC_NAMES,
  computeNeedsReview,
}
