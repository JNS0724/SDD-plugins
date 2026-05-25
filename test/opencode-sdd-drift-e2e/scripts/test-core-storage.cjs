const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const storage = require(path.join(repoRoot, "plugins", "sdd-drift-check", "src", "core", "state-storage.js"))
const locks = require(path.join(repoRoot, "plugins", "sdd-drift-check", "src", "core", "locks.js"))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-storage-"))
fs.mkdirSync(path.join(tmp, ".git"), { recursive: true })

const dir = storage.stateDir(tmp)
assert.strictEqual(dir, path.join(tmp, ".git", "sdd-drift-hook-state"))

const sessionPath = storage.statePath(tmp, "session/with spaces")
assert.ok(sessionPath.startsWith(dir))
assert.ok(sessionPath.endsWith("-session_with_spaces.json"))
assert.strictEqual(storage.projectStatePath(tmp), path.join(dir, "project.json"))
assert.strictEqual(storage.diagnosticLogPath(tmp), path.join(dir, "sdd-drift-check.log.jsonl"))

const target = path.join(dir, "atomic.txt")
storage.writeTextAtomic(target, "hello")
assert.strictEqual(fs.readFileSync(target, "utf8"), "hello")
assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")))

const lockTarget = path.join(dir, "locked.json")
const lock = locks.acquireFileLock(lockTarget, { waitMs: 0 })
assert.ok(lock)
assert.strictEqual(locks.acquireFileLock(lockTarget, { waitMs: 0 }), null)
locks.releaseFileLock(lock)
assert.ok(!fs.existsSync(`${lockTarget}.lock`))

const oldState = path.join(dir, "old.json")
fs.writeFileSync(oldState, "{}")
const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
fs.utimesSync(oldState, oldTime, oldTime)
storage.cleanupOldState(tmp)
assert.ok(!fs.existsSync(oldState))

console.log("sdd-drift core storage tests passed")
