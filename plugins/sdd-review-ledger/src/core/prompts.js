"use strict"

const { sanitizePath } = require("./paths")

// system-reminder templates (§9.2 fact-forcing R2 #4, §9.4 carry-over).
// Byte-stable: same inputs → same bytes (snapshot contract §8.6 / §9.2). Every
// path is run through sanitizePath before being placed in the human/model-visible
// text (R2 #8 render-side sanitization).

const HEADER = "[SDD-REVIEW: NEEDS-REVIEW]"

// The fact-forcing review block (R2 #4): demand evidence BEFORE a verdict. This is
// the only place GateGuard's "force investigation, don't self-evaluate" lesson
// enters the product — it lowers the lowest-effort rubber-stamp path, but carries
// no DENY force (architecture §10#9). Frozen constant for snapshot stability.
const REVIEW_BLOCK = [
  "REVIEW（你是唯一语义裁判；下结论前必须先取证，不接受裸判断）:",
  "  对每一项，先读当前内容，再按此结构给出事实，最后才下结论：",
  "    1. design/tasks 此刻声称什么（引用具体一句/一段）",
  "    2. code 此刻实现什么（引用具体函数/行为）",
  "    3. 二者是否一致（指出冲突点，或写\"经对照无冲突\"）",
  "    4. 结论：需改 → 直接编辑对应 design/tasks（这本身是同步动作）；",
  "             无需改（纯重构/格式化/无关）→ 在 .sdd-review-todo.md 勾掉，理由须含第 3 步的依据",
  "  （Layer A 纯文档对纯文档：第 2 步替换为\"另一篇 doc 此刻声称什么\"，不强求 importer 式取证。）",
  "  规则见 sdd-review-rules.md。",
].join("\n")

const ACTION_LINE =
  "ACTION: 完成上述后回到用户原始任务。无论编辑还是勾选，最终都需在 .sdd-review-todo.md 勾掉你评审过的每一项（编辑文件不自动清除）。"

const changedLine = (item) => {
  const p = sanitizePath(item.path)
  if (item.kind === "code" && Array.isArray(item.candidates) && item.candidates.length) {
    return `  - ${p}  (候选 change-dir: ${item.candidates.map(sanitizePath).join(", ")})`
  }
  return `  - ${p}`
}

// buildReminder(needs, designFirstLineByDir) -> string | "" (empty if no needs).
// designFirstLineByDir: { [relDir]: firstNonEmptyLine } for CONTEXT hints.
const buildReminder = (needs, designFirstLineByDir = {}) => {
  if (!needs || needs.length === 0) return ""
  const items = [...needs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const lines = ["<system-reminder>", HEADER, "", "CHANGED (未评审，本批):"]
  for (const item of items) lines.push(changedLine(item))

  // CONTEXT: design first line per referenced change-dir (sorted, deduped).
  const dirs = new Set()
  for (const item of items) {
    for (const d of item.candidates || []) {
      if (designFirstLineByDir[d]) dirs.add(d)
    }
  }
  const sortedDirs = [...dirs].sort()
  if (sortedDirs.length) {
    lines.push("", "CONTEXT (change-dir design 首行):")
    for (const d of sortedDirs) {
      lines.push(`  - ${sanitizePath(d)}: ${sanitizePath(designFirstLineByDir[d])}`)
    }
  }

  lines.push("", REVIEW_BLOCK, "", ACTION_LINE, "</system-reminder>")
  return lines.join("\n") + "\n"
}

// Compact cross-session carry-over (§9.4): just resurface the count + pointer.
const buildCarryOver = (needs) => {
  if (!needs || needs.length === 0) return ""
  return (
    [
      "<system-reminder>",
      HEADER,
      `有 ${needs.length} 项变更尚未评审（见 .sdd-review-todo.md）。逐项先取证后下结论；评审过的在该文件勾掉。`,
      "</system-reminder>",
    ].join("\n") + "\n"
  )
}

module.exports = {
  HEADER,
  REVIEW_BLOCK,
  ACTION_LINE,
  changedLine,
  buildReminder,
  buildCarryOver,
}
