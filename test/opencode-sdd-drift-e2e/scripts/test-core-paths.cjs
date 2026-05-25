const assert = require("assert")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const paths = require(path.join(repoRoot, "plugins", "sdd-drift-check", "src", "core", "paths.js"))

const mixed = path.join("alpha", "beta", "file.ts")
assert.strictEqual(paths.toPosix("alpha\\beta\\file.ts"), "alpha/beta/file.ts")
assert.strictEqual(paths.rel(path.resolve("alpha"), path.resolve("alpha", "beta", "file.ts")), "beta/file.ts")
assert.strictEqual(paths.resolveFile("C:\\repo", "src\\index.ts"), path.resolve("C:\\repo", "src\\index.ts"))
assert.strictEqual(paths.resolveFile(process.cwd(), mixed), path.resolve(process.cwd(), mixed))
assert.ok(paths.samePath(path.resolve("A", "b"), path.resolve("A", "b")))

const key = paths.normalizeKey(path.resolve("A", "B"))
assert.strictEqual(typeof key, "string")
assert.ok(key.includes(paths.toPosix(path.resolve("A")).split("/").pop().toLowerCase()))

console.log("sdd-drift core path tests passed")
