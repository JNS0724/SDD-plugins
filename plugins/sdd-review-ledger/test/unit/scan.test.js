"use strict"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { scanWorkTree } = require("../../src/core/scan")
const { emptyLedger } = require("../../src/core/ledger")

const mkRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), "sdd-scan-"))
const write = (root, rel, content) => {
  const fp = path.join(root, rel)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}

test("scanWorkTree: finds code files, sorted, posix keys", () => {
  const root = mkRepo()
  try {
    write(root, "src/b.ts", "1")
    write(root, "src/a.ts", "1")
    write(root, "README.md", "x") // not code
    const { codePaths } = scanWorkTree(root, emptyLedger())
    assert.deepEqual(codePaths, ["src/a.ts", "src/b.ts"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("scanWorkTree: ignores default dirs (node_modules, .git, etc.)", () => {
  const root = mkRepo()
  try {
    write(root, "src/app.ts", "1")
    write(root, "node_modules/dep/index.js", "1")
    write(root, ".git/hooks/x.js", "1")
    write(root, "dist/bundle.js", "1")
    const { codePaths } = scanWorkTree(root, emptyLedger())
    assert.deepEqual(codePaths, ["src/app.ts"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("scanWorkTree: respects SDD_REVIEW_IGNORE extra dir globs", () => {
  const root = mkRepo()
  try {
    write(root, "src/app.ts", "1")
    write(root, "generated/big.ts", "1")
    const { codePaths } = scanWorkTree(root, emptyLedger(), { ignoreGlobs: ["generated/"] })
    assert.deepEqual(codePaths, ["src/app.ts"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("scanWorkTree: skips files over maxFileBytes, counts skipped", () => {
  const root = mkRepo()
  try {
    write(root, "src/small.ts", "x")
    write(root, "src/big.ts", "y".repeat(5000))
    const res = scanWorkTree(root, emptyLedger(), { maxFileBytes: 1000 })
    assert.deepEqual(res.codePaths, ["src/small.ts"])
    assert.ok(res.skipped >= 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("scanWorkTree: budget exceeded → truncated true, non-silent (R1 §4.4)", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "1")
    write(root, "src/sub/b.ts", "1")
    // now() that reports past-budget after the first read → trips truncation
    let calls = 0
    const now = () => (calls++ === 0 ? 0 : 999999)
    const res = scanWorkTree(root, emptyLedger(), { scanBudgetMs: 10 }, { now })
    assert.equal(res.truncated, true)
    assert.ok(res.skipped >= 1, "skipped count surfaced, not silent")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("scanWorkTree: hashCache populated unless scanAlwaysHash", () => {
  const root = mkRepo()
  try {
    write(root, "src/a.ts", "1")
    const withCache = scanWorkTree(root, emptyLedger())
    assert.ok(withCache.hashCache["src/a.ts"], "cache hint present")
    const noCache = scanWorkTree(root, emptyLedger(), { scanAlwaysHash: true })
    assert.deepEqual(noCache.hashCache, {}, "always-hash disables skip hint")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
