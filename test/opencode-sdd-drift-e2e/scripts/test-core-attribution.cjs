const assert = require("assert")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const { Attribution } = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "attribution.js"
))

const cwd = path.resolve("repo")
const alpha = { relDir: "sdd/changes/alpha", archived: false, linkedCode: [{ path: "src/alpha/api.ts" }] }
const beta = { relDir: "sdd/changes/beta", archived: false, linkedCode: [{ path: "src/beta/api.ts" }] }

assert.strictEqual(Attribution.sharedPrefixDepth("src/alpha/api.ts", "src/alpha/model.ts"), 2)
assert.ok(Attribution.pathInChangeDir(cwd, path.join(cwd, "sdd", "changes", "alpha", "design.md"), alpha.relDir))
assert.ok(Attribution.pathSimilar(cwd, path.join(cwd, "src", "alpha", "service.ts"), alpha.linkedCode))

assert.deepStrictEqual(Attribution.decide({ cwd, session: {}, project: {}, codeFile: "src/app.ts" }), {
  kind: "no-attribution",
})
assert.strictEqual(
  Attribution.decide({
    cwd,
    session: {},
    project: { changeDirs: { alpha } },
    codeFile: "src/app.ts",
  }).kind,
  "single"
)
assert.strictEqual(
  Attribution.decide({
    cwd,
    session: { edited: [path.join(cwd, "sdd", "changes", "beta", "tasks.md")] },
    project: { changeDirs: { alpha, beta } },
    codeFile: "src/app.ts",
  }).kind,
  "session-touched"
)
assert.strictEqual(
  Attribution.decide({
    cwd,
    session: {},
    project: {
      changeDirs: { alpha, beta },
      activeChangeDir: alpha.relDir,
      activeUntilMs: Date.now() + 1000,
    },
    codeFile: path.join(cwd, "src", "alpha", "service.ts"),
  }).kind,
  "active-ttl"
)
assert.strictEqual(
  Attribution.decide({
    cwd,
    session: {},
    project: { changeDirs: { alpha, beta } },
    codeFile: "src/gamma.ts",
  }).kind,
  "needs-review"
)

console.log("sdd-drift core attribution tests passed")
