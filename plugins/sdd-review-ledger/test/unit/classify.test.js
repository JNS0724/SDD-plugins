"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const { classifyPath } = require("../../src/core/classify")

test("sdd-doc: design/tasks/proposal under sdd/changes", () => {
  assert.equal(classifyPath("sdd/changes/greeting/design.md"), "sdd-doc")
  assert.equal(classifyPath("sdd/changes/greeting/tasks.md"), "sdd-doc")
  assert.equal(classifyPath(".sdd/changes/x/proposal.md"), "sdd-doc")
  assert.equal(classifyPath("/abs/repo/sdd/changes/y/design.md"), "sdd-doc")
})

test("code: source extensions outside the sdd tree", () => {
  assert.equal(classifyPath("src/greet.ts"), "code")
  assert.equal(classifyPath("index.html"), "code")
  assert.equal(classifyPath("pkg/main.go"), "code")
  assert.equal(classifyPath("app/styles.scss"), "code")
})

test("other: non-source, lockfiles, binaries", () => {
  assert.equal(classifyPath("package-lock.json"), "other")
  assert.equal(classifyPath("assets/logo.png"), "other")
  assert.equal(classifyPath("README.md"), "other")
})

test("sdd tree wins: untracked .md is other, code under sdd is not code", () => {
  // notes.md under changes is not a tracked sdd-doc name → other
  assert.equal(classifyPath("sdd/changes/x/notes.md"), "other")
  // a .ts file living inside the sdd tree is NOT classified as code (design intent: sdd tree is docs)
  assert.equal(classifyPath("sdd/changes/x/snippet.ts"), "other")
})

test("design.md outside changes tree is not sdd-doc", () => {
  assert.equal(classifyPath("docs/design.md"), "other")
})
