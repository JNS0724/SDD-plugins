"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const { parseTodo, renderTodo, THIN_MARK } = require("../../src/core/todo")
const { emptyLedger, withRecord } = require("../../src/core/ledger")

test("parseTodo: parses checkbox + path + inline hash + rationale (pending section)", () => {
  const text = [
    "## 待评审",
    "- [x] src/greet.ts@a1b2c3 — 仅 gofmt，无需改文档",
    "- [ ] src/other.ts@ff00aa  (候选: greeting, refund)",
  ].join("\n")
  const entries = parseTodo(text)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { checked: true, path: "src/greet.ts", inlineHash: "a1b2c3", rationale: "仅 gofmt，无需改文档" })
  assert.deepEqual(entries[1], { checked: false, path: "src/other.ts", inlineHash: "ff00aa", rationale: "" })
})

test("parseTodo: malformed/prose lines skipped, never guessed", () => {
  const text = ["random prose", "- [x] no-hash-here", "- [x] a.ts@deadbeef"].join("\n")
  const entries = parseTodo(text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].path, "a.ts")
})

test("parseTodo: 已评审 audit section is INERT — its [x] lines are NOT ingestable", () => {
  // Regression: a path pending with new hash + listed in audit with OLD hash must
  // not let the audit entry clobber the fresh checkoff (false stay-pending).
  const text = [
    "## 待评审",
    "- [x] src/a.ts@22222222 — 重构",
    "",
    "## 已评审（近 N，审计用）",
    "- [x] src/a.ts@11111111 — bootstrap",
  ].join("\n")
  const entries = parseTodo(text)
  assert.equal(entries.length, 1, "only the pending-section entry is parsed")
  assert.equal(entries[0].inlineHash, "22222222", "fresh pending hash, not the stale audit hash")
})

test("parseTodo: flat list with no headings is treated as ingestable (safe default)", () => {
  const entries = parseTodo("- [x] a.ts@deadbeef — ok")
  assert.equal(entries.length, 1)
  assert.equal(entries[0].inlineHash, "deadbeef")
})

test("renderTodo: idempotent — same inputs → same bytes", () => {
  const needs = [
    { path: "src/b.ts", currentHash: "bbbb", candidates: ["greeting"] },
    { path: "src/a.ts", currentHash: "aaaa", candidates: ["greeting", "refund"] },
  ]
  const led = emptyLedger()
  const out1 = renderTodo(needs, led)
  const out2 = renderTodo(needs, led)
  assert.equal(out1, out2)
  // sorted by path: a before b regardless of input order
  assert.ok(out1.indexOf("src/a.ts") < out1.indexOf("src/b.ts"))
})

test("renderTodo: round-trips through parseTodo for pending items", () => {
  const needs = [{ path: "src/a.ts", currentHash: "aaaa", candidates: ["greeting"] }]
  const parsed = parseTodo(renderTodo(needs, emptyLedger()))
  const pending = parsed.find((e) => e.path === "src/a.ts")
  assert.ok(pending && !pending.checked && pending.inlineHash === "aaaa")
})

test("renderTodo: reviewed section newest-first, thin rationale marked (R2 #4b)", () => {
  let led = emptyLedger()
  led = withRecord(led, "src/old.ts", { kind: "code", reviewedHash: "0a", rationale: "detailed reason here", reviewedAt: "2026-05-30T10:00:00Z" })
  led = withRecord(led, "src/new.ts", { kind: "code", reviewedHash: "0b", rationale: "无关", reviewedAt: "2026-05-31T10:00:00Z" })
  const out = renderTodo([], led)
  assert.ok(out.indexOf("src/new.ts") < out.indexOf("src/old.ts"), "newest first")
  // thin rationale ("无关") gets the marker; detailed one does not
  const newLine = out.split("\n").find((l) => l.includes("src/new.ts"))
  const oldLine = out.split("\n").find((l) => l.includes("src/old.ts"))
  assert.ok(newLine.includes(THIN_MARK), "thin rationale marked")
  assert.ok(!oldLine.includes(THIN_MARK), "detailed rationale not marked")
})

test("renderTodo: thin mark is display-only, does not change checkbox state", () => {
  let led = withRecord(emptyLedger(), "src/x.ts", { kind: "code", reviewedHash: "0c", rationale: "ok", reviewedAt: "2026-05-31T00:00:00Z" })
  const out = renderTodo([], led)
  const line = out.split("\n").find((l) => l.includes("src/x.ts"))
  assert.ok(line.startsWith("- [x] "), "still checked/cleared despite thin mark")
})
