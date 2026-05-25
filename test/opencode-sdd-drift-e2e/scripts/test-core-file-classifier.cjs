const assert = require("assert")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const classifier = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "file-classifier.js"
))

const root = path.resolve("tmp-project")
const codeFile = path.join(root, "src", "feature.ts")
const sddDoc = path.join(root, "sdd", "changes", "feat-a", "design.md")
const dotSddDoc = path.join(root, ".sdd", "changes", "feat-a", "tasks.md")

assert.ok(classifier.CODE_EXT.test("feature.ts"))
assert.ok(classifier.CODE_EXT.test("feature.vue"))
assert.ok(classifier.CODE_EXT.test("query.sql"))
assert.ok(classifier.isCodePath(codeFile))
assert.ok(!classifier.isCodePath(sddDoc))
assert.ok(classifier.isSddPath(sddDoc))
assert.ok(classifier.isSddPath(dotSddDoc))
assert.ok(classifier.isSddChangePath(sddDoc))
assert.ok(classifier.isSddChangePath(dotSddDoc))
assert.ok(!classifier.isSddChangePath(path.join(root, "sdd", "specs", "design.md")))

console.log("sdd-drift core file-classifier tests passed")
