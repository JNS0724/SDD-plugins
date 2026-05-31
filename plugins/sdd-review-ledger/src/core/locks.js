"use strict"

const fs = require("fs")
const path = require("path")

// File lock ported from sibling sdd-drift-check/src/core/locks.js.
// O_EXCL ("wx") create + bounded retry + stale-mtime steal to avoid deadlock.

const DEFAULT_LOCK_STALE_MS = 30000

const sleepSync = (ms) => {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const acquireFileLock = (target, options = {}) => {
  const staleMs = options.staleMs || DEFAULT_LOCK_STALE_MS
  const waitMs = options.waitMs || 0
  const retryMs = options.retryMs || 25
  const lockPath = `${target}.lock`

  const openLock = () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const fd = fs.openSync(lockPath, "wx")
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
    return { fd, lockPath }
  }

  const deadline = Date.now() + waitMs
  while (true) {
    try {
      return openLock()
    } catch (err) {
      if (err && err.code !== "EEXIST") return null
    }
    // holder may be dead: steal if the lock file is stale.
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath)
    } catch {
      /* race on stat/unlink → retry */
    }
    if (Date.now() >= deadline) return null
    sleepSync(retryMs)
  }
}

const releaseFileLock = (lock) => {
  if (!lock) return
  try {
    fs.closeSync(lock.fd)
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lock.lockPath)
  } catch {
    /* ignore */
  }
}

module.exports = {
  DEFAULT_LOCK_STALE_MS,
  acquireFileLock,
  releaseFileLock,
  sleepSync,
}
