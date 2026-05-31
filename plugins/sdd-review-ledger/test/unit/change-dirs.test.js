"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { discoverChangeDirs, isArchived } = require("../../src/core/change-dirs")

const mkRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "sdd-cd-"))
const write = (root, rel, content) => {
  const fp = path.join(root, rel)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}

test("discoverChangeDirs: finds dirs under sdd/changes with their docs", () => {
  const root = mkRepo()
  try {
    write(root, "sdd/changes/greeting/design.md", "# Greeting\n行为：根据时段返回问候语\n")
    write(root, "sdd/changes/greeting/tasks.md", "- [ ] t1\n")
    const dirs = discoverChangeDirs(root)
    assert.equal(dirs.length, 1)
    assert.equal(dirs[0].relDir, "sdd/changes/greeting")
    assert.deepEqual(dirs[0].docs.sort(), ["design.md", "tasks.md"])
    assert.equal(dirs[0].designFirstLine, "# Greeting")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("discoverChangeDirs: skips archived dirs (name + marker + frontmatter)", () => {
  const root = mkRepo()
  try {
    write(root, "sdd/changes/archived-old/design.md", "x")
    write(root, "sdd/changes/done/ARCHIVED", "")
    write(root, "sdd/changes/done/design.md", "x")
    write(root, "sdd/changes/legacy/design.md", "status: archived\n# Legacy\n")
    write(root, "sdd/changes/active/design.md", "# Active\n")
    const relDirs = discoverChangeDirs(root).map((d) => d.relDir)
    assert.deepEqual(relDirs, ["sdd/changes/active"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("discoverChangeDirs: deterministic order by relDir; both sdd and .sdd", () => {
  const root = mkRepo()
  try {
    write(root, "sdd/changes/zeta/design.md", "z")
    write(root, ".sdd/changes/alpha/design.md", "a")
    const relDirs = discoverChangeDirs(root).map((d) => d.relDir)
    assert.deepEqual(relDirs, [".sdd/changes/alpha", "sdd/changes/zeta"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("discoverChangeDirs: no sdd tree → empty", () => {
  const root = mkRepo()
  try {
    assert.deepEqual(discoverChangeDirs(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("isArchived: plain active dir is not archived", () => {
  const root = mkRepo()
  try {
    write(root, "sdd/changes/x/design.md", "# normal\n")
    assert.equal(isArchived(path.join(root, "sdd/changes/x")), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
