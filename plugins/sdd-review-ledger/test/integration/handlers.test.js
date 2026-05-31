"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { onEdit } = require("../../src/handlers/on-edit")
const { onPrompt } = require("../../src/handlers/on-prompt")
const { dispatch } = require("../../src/dispatch")
const { run } = require("../../src/pipeline")
const { todoPathFor, ledgerPathFor } = require("../../src/core/state-dir")

const mkRepo = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdd-h-")))
  fs.mkdirSync(path.join(root, "sdd", "changes", "greeting"), { recursive: true })
  fs.writeFileSync(path.join(root, "sdd", "changes", "greeting", "design.md"), "# Greeting 行为\n")
  return root
}
const write = (root, rel, c) => {
  const fp = path.join(root, rel)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, c)
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true })
const NOW = "2026-05-31T12:00:00Z"
const SID = { session_id: "sess-A" }
const ectx = (root, extra = {}) => ({ repoRoot: root, env: {}, now: NOW, actor: "agent", event: SID, ...extra })

test("onEdit: first edit with needs delivers a fact-forcing reminder; pipeline wrote todo", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ectx(root)) // baseline (no needs)
    write(root, "src/a.ts", "v2")
    const r = onEdit(ectx(root, { editedPath: path.join(root, "src/a.ts") }))
    assert.equal(r.deliver, true)
    assert.ok(r.text.includes("[SDD-REVIEW: NEEDS-REVIEW]"))
    assert.ok(r.text.includes("src/a.ts"))
    assert.ok(fs.existsSync(todoPathFor(root)), "passive todo always written by pipeline")
  } finally {
    rm(root)
  }
})

test("onEdit: every relevant edit can remind; passive todo still refreshes", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ectx(root))
    write(root, "src/a.ts", "v2")
    assert.equal(onEdit(ectx(root, { editedPath: path.join(root, "src/a.ts") })).deliver, true)
    write(root, "src/b.ts", "v1")
    const r2 = onEdit(ectx(root, { editedPath: path.join(root, "src/b.ts") }))
    assert.equal(r2.deliver, true, "second code edit should remind too")
    assert.ok(fs.readFileSync(todoPathFor(root), "utf8").includes("src/b.ts"), "todo still reflects b.ts")
  } finally {
    rm(root)
  }
})

test("onEdit: todo housekeeping writes ingest but do not actively remind", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ectx(root))
    write(root, "src/a.ts", "v2")
    assert.equal(onEdit(ectx(root, { editedPath: path.join(root, "src/a.ts") })).deliver, true)
    write(root, ".sdd-review-todo.md", fs.readFileSync(todoPathFor(root), "utf8"))
    assert.equal(onEdit(ectx(root, { editedPath: path.join(root, ".sdd-review-todo.md") })).deliver, false)
  } finally {
    rm(root)
  }
})

test("onPrompt keeps carry-over visible and later edits still remind", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ectx(root))
    write(root, "src/a.ts", "v2")
    assert.equal(onEdit(ectx(root, { editedPath: path.join(root, "src/a.ts"), nowMs: 1000 })).deliver, true)
    assert.equal(onEdit(ectx(root, { editedPath: path.join(root, "src/a.ts"), nowMs: 1001 })).deliver, false, "identical pending set is deduped briefly")
    const p = onPrompt(ectx(root))
    assert.equal(p.deliver, true, "carry-over surfaces pending count")
    assert.ok(p.text.includes(".sdd-review-todo.md"))
    write(root, "src/a.ts", "v3")
    assert.equal(onEdit(ectx(root, { editedPath: path.join(root, "src/a.ts"), nowMs: 1002 })).deliver, true, "changed hash reminds again")
  } finally {
    rm(root)
  }
})

test("onEdit: optional session cap (SDD_REVIEW_SESSION_MAX_REMINDERS=1) → only one active reminder", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    const env = { SDD_REVIEW_SESSION_MAX_REMINDERS: "1" }
    run({ ...ectx(root), env })
    write(root, "src/a.ts", "v2")
    assert.equal(onEdit({ ...ectx(root), env, editedPath: path.join(root, "src/a.ts") }).deliver, true)
    onPrompt({ ...ectx(root), env }) // new batch
    write(root, "src/a.ts", "v3")
    assert.equal(onEdit({ ...ectx(root), env, editedPath: path.join(root, "src/a.ts") }).deliver, false, "session cap 1 reached")
  } finally {
    rm(root)
  }
})

test("onEdit: no needs → no delivery", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ectx(root)) // baseline; nothing pending
    assert.equal(onEdit(ectx(root, { editedPath: path.join(root, "src/a.ts") })).deliver, false)
  } finally {
    rm(root)
  }
})

// ─── dispatch (adapter-level) ───
test("dispatch: PostToolUse Edit → additionalContext JSON; Read → empty", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ectx(root))
    write(root, "src/a.ts", "v2")
    const editEvent = {
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(root, "src/a.ts") },
      cwd: root,
      session_id: "sess-A",
    }
    const parsed = JSON.parse(dispatch(editEvent, {}).stdout)
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse")
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes("[SDD-REVIEW"))

    const readEvent = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "x" }, cwd: root, session_id: "s" }
    assert.equal(dispatch(readEvent, {}).stdout, "", "Read is not a write tool → silent")
  } finally {
    rm(root)
  }
})

test("dispatch: UserPromptSubmit → carry-over additionalContext when pending", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    run(ectx(root))
    write(root, "src/a.ts", "v2")
    run(ectx(root)) // make a.ts pending
    const out = dispatch({ hook_event_name: "UserPromptSubmit", cwd: root, session_id: "sess-A" }, {})
    const parsed = JSON.parse(out.stdout)
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit")
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(".sdd-review-todo.md"))
  } finally {
    rm(root)
  }
})

test("dispatch: escape hatch SDD_REVIEW=off → empty stdout, no writes", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "v1")
    const ev = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(root, "src/a.ts") }, cwd: root, session_id: "s" }
    assert.equal(dispatch(ev, { SDD_REVIEW: "off" }).stdout, "")
    assert.equal(fs.existsSync(ledgerPathFor(root)), false)
  } finally {
    rm(root)
  }
})

test("dispatch: unknown event → empty, never throws", () => {
  assert.equal(dispatch({ hook_event_name: "SessionStart" }, {}).stdout, "")
  assert.equal(dispatch({}, {}).stdout, "")
  assert.equal(dispatch(null, {}).stdout, "")
})
