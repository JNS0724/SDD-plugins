"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { hashBuffer, hashElement } = require("../../src/core/hash")

test("hashBuffer: deterministic, same bytes → same hash", () => {
  assert.equal(hashBuffer("hello"), hashBuffer(Buffer.from("hello")))
})

test("hashBuffer: different bytes → different hash (format change = changed)", () => {
  assert.notEqual(hashBuffer("a = 1"), hashBuffer("a=1"), "whitespace change flips hash (benign trigger source)")
})

test("hashBuffer: respects hashLen prefix length", () => {
  assert.equal(hashBuffer("x", 16).length, 16)
  assert.equal(hashBuffer("x", 8).length, 8)
})

test("hashElement: missing file → null", () => {
  assert.equal(hashElement(path.join(os.tmpdir(), "definitely-missing-xyz-123.txt")), null)
})

test("hashElement: existing file matches hashBuffer of its bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-hash-"))
  try {
    const fp = path.join(dir, "f.txt")
    fs.writeFileSync(fp, "content-v1")
    assert.equal(hashElement(fp), hashBuffer("content-v1"))
    fs.writeFileSync(fp, "content-v2")
    assert.notEqual(hashElement(fp), hashBuffer("content-v1"), "content change flips hash")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
