"use strict"

const { test, afterEach } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { writeTextAtomic } = require("../../src/core/atomic")

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sdd-atomic-"))
const realRename = fs.renameSync

afterEach(() => {
  fs.renameSync = realRename // always restore after a patched test
})

test("writeTextAtomic: writes new file, returns true", () => {
  const dir = mkdir()
  try {
    const fp = path.join(dir, "a.txt")
    assert.equal(writeTextAtomic(fp, "hello"), true)
    assert.equal(fs.readFileSync(fp, "utf8"), "hello")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("writeTextAtomic: overwrites existing file (posix rename-over)", () => {
  const dir = mkdir()
  try {
    const fp = path.join(dir, "a.txt")
    writeTextAtomic(fp, "v1")
    writeTextAtomic(fp, "v2")
    assert.equal(fs.readFileSync(fp, "utf8"), "v2")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("writeTextAtomic: R2 #3b — EEXIST on rename → unlink + retry once → success", () => {
  const dir = mkdir()
  try {
    const fp = path.join(dir, "a.txt")
    fs.writeFileSync(fp, "old")
    let calls = 0
    fs.renameSync = (from, to) => {
      calls += 1
      if (calls === 1) {
        const e = new Error("simulated windows overwrite")
        e.code = "EEXIST"
        throw e
      }
      return realRename(from, to)
    }
    const ok = writeTextAtomic(fp, "new")
    assert.equal(ok, true, "retry after unlink succeeds")
    assert.equal(calls, 2, "rename attempted twice")
    fs.renameSync = realRename
    assert.equal(fs.readFileSync(fp, "utf8"), "new")
  } finally {
    fs.renameSync = realRename
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("writeTextAtomic: non-EEXIST rename error → false, NO non-atomic fallback, no tmp litter", () => {
  const dir = mkdir()
  try {
    const fp = path.join(dir, "a.txt")
    fs.renameSync = () => {
      const e = new Error("disk gone")
      e.code = "EIO"
      throw e
    }
    const ok = writeTextAtomic(fp, "data")
    assert.equal(ok, false, "gives up this round, does not throw")
    fs.renameSync = realRename
    assert.equal(fs.existsSync(fp), false, "target NOT written via non-atomic fallback")
    const leftover = fs.readdirSync(dir).filter((f) => f.includes(".tmp."))
    assert.equal(leftover.length, 0, "tmp cleaned up on failure")
  } finally {
    fs.renameSync = realRename
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
