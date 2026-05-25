const fs = require("fs")
const path = require("path")
const { DEFAULT_LOCK_STALE_MS } = require("./runtime-config")

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
      if (err?.code !== "EEXIST") return null
    }

    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath)
    } catch {}

    if (Date.now() >= deadline) return null
    sleepSync(retryMs)
  }
}

const releaseFileLock = (lock) => {
  if (!lock) return
  try {
    fs.closeSync(lock.fd)
  } catch {}
  try {
    fs.unlinkSync(lock.lockPath)
  } catch {}
}

module.exports = {
  acquireFileLock,
  releaseFileLock,
  sleepSync,
}
