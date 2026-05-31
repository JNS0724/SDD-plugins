"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const { resolveSessionKey, sanitizeSessionKey } = require("../../src/core/session-key")

test("resolveSessionKey: stable for same session_id, sanitized", () => {
  const a = resolveSessionKey({ session_id: "sess-123" }, {})
  const b = resolveSessionKey({ session_id: "sess-123" }, {})
  assert.equal(a, b)
  assert.equal(a, "sess-123")
})

test("resolveSessionKey: different ids do not collide", () => {
  assert.notEqual(resolveSessionKey({ session_id: "a" }, {}), resolveSessionKey({ session_id: "b" }, {}))
})

test("resolveSessionKey: falls back to CLAUDE_SESSION_ID, then transcript, then repoRoot", () => {
  assert.equal(resolveSessionKey({}, { CLAUDE_SESSION_ID: "env-sess" }), "env-sess")
  assert.match(resolveSessionKey({ transcript_path: "/tmp/t.jsonl" }, {}), /^tx-[a-f0-9]{24}$/)
  assert.match(resolveSessionKey({}, {}, "/repo/root"), /^proj-[a-f0-9]{24}$/)
})

test("resolveSessionKey: empty/blank candidates are skipped", () => {
  assert.equal(resolveSessionKey({ session_id: "  " }, { CLAUDE_SESSION_ID: "real" }), "real")
})

test("sanitizeSessionKey: long/illegal → bounded sid hash; short illegal → underscored", () => {
  assert.match(sanitizeSessionKey("x".repeat(120)), /^sid-[a-f0-9]{24}$/)
  assert.equal(sanitizeSessionKey("a/b c"), "a_b_c")
})

test("resolveSessionKey: same repoRoot → same proj key (stable throttle dimension)", () => {
  assert.equal(resolveSessionKey({}, {}, "/r"), resolveSessionKey({}, {}, "/r"))
})
