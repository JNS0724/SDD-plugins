"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const {
  findRepoRoot,
  resolveStateDir,
  ledgerPathFor,
  todoPathFor,
  STATE_DIRNAME,
  TODO_FILENAME,
} = require("../../src/core/state-dir")

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdd-sd-")))

test("findRepoRoot: finds nearest ancestor with .git", () => {
  const root = mk()
  try {
    fs.mkdirSync(path.join(root, ".git"))
    const deep = path.join(root, "a", "b", "c")
    fs.mkdirSync(deep, { recursive: true })
    assert.equal(findRepoRoot(deep), root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("findRepoRoot: works with NO git — sdd/ marker (R1 §6.2)", () => {
  const root = mk()
  try {
    fs.mkdirSync(path.join(root, "sdd"))
    const deep = path.join(root, "x")
    fs.mkdirSync(deep)
    assert.equal(findRepoRoot(deep), root)
    assert.equal(fs.existsSync(path.join(root, ".git")), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("findRepoRoot: package.json marker also works", () => {
  const root = mk()
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}")
    assert.equal(findRepoRoot(root), root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveStateDir: inside .git when present", () => {
  const root = mk()
  try {
    fs.mkdirSync(path.join(root, ".git"))
    const sd = resolveStateDir(root)
    assert.equal(sd, path.join(root, ".git", STATE_DIRNAME))
    assert.ok(fs.existsSync(sd), "created")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("resolveStateDir: dotted at repo root when no .git", () => {
  const root = mk()
  try {
    const sd = resolveStateDir(root)
    assert.equal(sd, path.join(root, `.${STATE_DIRNAME}`))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("ledgerPathFor / todoPathFor", () => {
  const root = mk()
  try {
    assert.equal(path.basename(ledgerPathFor(root)), "ledger.json")
    assert.equal(todoPathFor(root), path.join(root, TODO_FILENAME))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
