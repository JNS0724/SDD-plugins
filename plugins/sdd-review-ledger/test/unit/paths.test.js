"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const path = require("path")
const { toPosix, rel, sanitizePath, MAX_RENDERED_PATH } = require("../../src/core/paths")

test("toPosix: backslashes to forward slashes", () => {
  assert.equal(toPosix("a\\b\\c"), "a/b/c")
  assert.equal(toPosix(""), "")
  assert.equal(toPosix(null), "")
})

test("rel: repo-relative posix key", () => {
  const root = path.resolve("/tmp/repo")
  assert.equal(rel(root, path.resolve("/tmp/repo/src/greet.ts")), "src/greet.ts")
})

test("sanitizePath: strips newlines and control chars (R2 #8)", () => {
  const out = sanitizePath("src/app.js\ninjected")
  assert.ok(!out.includes("\n"), "no raw newline")
  assert.ok(out.includes("src/app.js"), "keeps visible path")
  assert.ok(out.includes("injected"), "newline replaced by space, text preserved on same line")
})

test("sanitizePath: strips bidi override chars", () => {
  const bidi = String.fromCharCode(0x202e)
  const out = sanitizePath(`src/${bidi}evil.js`)
  assert.ok(!out.includes(bidi), "bidi override removed")
  assert.ok(out.includes("evil.js"))
})

test("sanitizePath: truncates to MAX_RENDERED_PATH", () => {
  const long = "a".repeat(MAX_RENDERED_PATH + 50)
  assert.equal(sanitizePath(long).length, MAX_RENDERED_PATH)
})

test("sanitizePath: empty/nullish safe", () => {
  assert.equal(sanitizePath(""), "")
  assert.equal(sanitizePath(null), "")
})
