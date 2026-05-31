"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { acquireFileLock, releaseFileLock } = require("../../src/core/locks")

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "sdd-lock-"))

test("acquire then release; second acquire fails while held", () => {
  const dir = mk()
  try {
    const target = path.join(dir, "ledger.json")
    const lock = acquireFileLock(target, { waitMs: 0 })
    assert.ok(lock, "first acquire succeeds")
    const second = acquireFileLock(target, { waitMs: 0 })
    assert.equal(second, null, "second acquire fails (held)")
    releaseFileLock(lock)
    const third = acquireFileLock(target, { waitMs: 0 })
    assert.ok(third, "after release, acquire succeeds again")
    releaseFileLock(third)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("stale lock is stolen", () => {
  const dir = mk()
  try {
    const target = path.join(dir, "ledger.json")
    const lockPath = `${target}.lock`
    fs.writeFileSync(lockPath, "99999\nstale\n")
    const old = new Date(Date.now() - 60000) // backdate mtime far past staleMs
    fs.utimesSync(lockPath, old, old)
    const lock = acquireFileLock(target, { waitMs: 50, staleMs: 1000 })
    assert.ok(lock, "stale lock stolen")
    releaseFileLock(lock)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("creates parent dir if missing", () => {
  const dir = mk()
  try {
    const target = path.join(dir, "nested", "deep", "ledger.json")
    const lock = acquireFileLock(target, { waitMs: 0 })
    assert.ok(lock)
    releaseFileLock(lock)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
