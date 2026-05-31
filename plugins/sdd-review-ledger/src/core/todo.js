"use strict"

const { sanitizePath } = require("./paths")

// .sdd-review-todo.md parse + render (format contract §8.6, R2 #4b/#8).
// The tool reads ONLY the structured checkbox + path + inline @hash. The rationale
// is free text, stored verbatim, never semantically parsed.

const TODO_HEADER = "勾选 [x] 表示已评审（编辑文档/代码后仍需勾）；勾选下次运行生效。"
const PENDING_HEADING = "## 待评审"
const REVIEWED_HEADING = "## 已评审（近 N，审计用）"
const DEFAULT_REVIEWED_LIMIT = 50

// Line contract: - [ ] <path>@<hash>  (候选: ...)   |   - [x] <path>@<hash> — <rationale>
// We accept an optional "  (候选: ...)" tail on pending lines and an optional
// " — rationale" tail on any line. Only checkbox + path + inline hash are structural.
const TODO_LINE = /^- \[( |x)\] (\S+)@([0-9a-f]+)(?:\s+\(候选:[^)]*\))?(?: — (.*))?$/

// Section-aware: ONLY pending-section lines are ingestable checkoffs. The "已评审"
// audit section is display-only (§8.2: the sole ack is ticking a box in the pending
// list). If we re-parsed audit `[x]` lines, a stale audit entry (old hash) could
// re-pin / clobber a fresh pending checkoff (new hash) → wrong stay-pending. So we
// stop collecting once we enter the reviewed section. Default section = pending, so
// a flat list with no headings is still treated as ingestable (the safe direction).
const parseTodo = (text) => {
  const entries = []
  if (typeof text !== "string") return entries
  let inReviewed = false
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("## ")) {
      inReviewed = line.includes("已评审")
      continue
    }
    if (inReviewed) continue // audit section is inert
    const m = TODO_LINE.exec(line)
    if (!m) continue // malformed / prose → skipped, never guessed
    entries.push({
      checked: m[1] === "x",
      path: m[2],
      inlineHash: m[3],
      rationale: (m[4] || "").trim(),
    })
  }
  return entries
}

// R2 #4b: display-only marker when a checkoff rationale is too thin.
// Pure function of the rationale text; never affects clearing, never parses meaning.
const THIN_RATIONALES = new Set(["", "无关", "ok", "n/a", "na", "无", "skip"])
const isThinRationale = (rationale) => THIN_RATIONALES.has(String(rationale || "").trim().toLowerCase())
const THIN_MARK = "（理由过简，建议补充）"

// renderTodo(needs, ledger, opts) -> text. Idempotent: same inputs → same bytes.
// needs: NeedsReviewItem[] (sorted by path). ledger: for the reviewed section.
const renderTodo = (needs, ledger, opts = {}) => {
  const reviewedLimit = opts.reviewedLimit || DEFAULT_REVIEWED_LIMIT
  const lines = [TODO_HEADER, ""]

  // —— 待评审 ——
  lines.push(PENDING_HEADING)
  const pending = [...needs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const item of pending) {
    const candidates = Array.isArray(item.candidates) ? item.candidates.join(", ") : ""
    const tail = candidates ? `  (候选: ${candidates})` : ""
    lines.push(`- [ ] ${sanitizePath(item.path)}@${item.currentHash}${tail}`)
  }

  // —— 已评审 (reviewed = records whose reviewedHash is set; newest first by reviewedAt) ——
  lines.push("", REVIEWED_HEADING)
  const records = ledger && ledger.records ? ledger.records : {}
  const reviewed = Object.entries(records)
    .filter(([, r]) => r && r.reviewedHash)
    .sort((a, b) => {
      const ta = a[1].reviewedAt || ""
      const tb = b[1].reviewedAt || ""
      if (ta !== tb) return ta < tb ? 1 : -1 // newest first
      return a[0] < b[0] ? -1 : 1 // tiebreak by path for determinism
    })
    .slice(0, reviewedLimit)
  for (const [p, r] of reviewed) {
    const mark = isThinRationale(r.rationale) ? ` ${THIN_MARK}` : ""
    const rationale = r.rationale ? ` — ${r.rationale}` : " —"
    lines.push(`- [x] ${sanitizePath(p)}@${r.reviewedHash}${rationale}${mark}`)
  }

  return lines.join("\n") + "\n"
}

module.exports = {
  TODO_HEADER,
  PENDING_HEADING,
  REVIEWED_HEADING,
  DEFAULT_REVIEWED_LIMIT,
  THIN_MARK,
  TODO_LINE,
  parseTodo,
  renderTodo,
  isThinRationale,
}
