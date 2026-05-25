const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { normalizeKey } = require("./paths")
const { STATE_RETENTION_MS } = require("./runtime-config")
const { STATE_DIR } = require("./sdd-rules")

const sanitize = (value) => String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_")

const hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12)

const stateDirCache = new Map()

const findNearestGitDir = (cwd) => {
  let dir = path.resolve(cwd)
  while (dir !== path.dirname(dir)) {
    const gitPath = path.join(dir, ".git")
    try {
      const stat = fs.statSync(gitPath)
      if (stat.isDirectory()) return gitPath
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, "utf8").trim()
        const match = content.match(/^gitdir:\s*(.+)$/i)
        if (match) return path.resolve(dir, match[1].trim())
      }
    } catch {}
    dir = path.dirname(dir)
  }
  return null
}

const canUseStateDir = (dir) => {
  const probeBase = `.probe.${process.pid}.${Date.now()}`
  const tmp = path.join(dir, `${probeBase}.tmp`)
  const target = path.join(dir, probeBase)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, "")
    fs.renameSync(tmp, target)
    fs.unlinkSync(target)
    return true
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    try {
      fs.unlinkSync(target)
    } catch {}
    return false
  }
}

const stateDir = (cwd) => {
  const cacheKey = normalizeKey(cwd)
  const cached = stateDirCache.get(cacheKey)
  if (cached) return cached

  const gitDir = findNearestGitDir(cwd)
  if (gitDir) {
    const gitStateDir = path.join(gitDir, "sdd-drift-hook-state")
    if (canUseStateDir(gitStateDir)) {
      stateDirCache.set(cacheKey, gitStateDir)
      return gitStateDir
    }
  }

  const localStateDir = path.join(cwd, STATE_DIR)
  if (canUseStateDir(localStateDir)) {
    stateDirCache.set(cacheKey, localStateDir)
    return localStateDir
  }

  const tempStateDir = path.join(os.tmpdir(), "sdd-drift-check", hash(path.resolve(cwd)))
  stateDirCache.set(cacheKey, tempStateDir)
  return tempStateDir
}

const statePath = (cwd, sessionID) =>
  path.join(stateDir(cwd), `${hash(path.resolve(cwd))}-${sanitize(sessionID)}.json`)

const projectStatePath = (cwd) => path.join(stateDir(cwd), "project.json")

const diagnosticLogPath = (cwd) =>
  process.env.SDD_DRIFT_LOG_PATH || path.join(stateDir(cwd), "sdd-drift-check.log.jsonl")

const writeTextAtomic = (target, text) => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, text)
  try {
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      fs.writeFileSync(target, text)
    } catch {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw err
    }
    try {
      fs.unlinkSync(tmp)
    } catch {}
  }
}

const cleanupOldState = (cwd) => {
  const dir = stateDir(cwd)
  try {
    const now = Date.now()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const fp = path.join(dir, entry.name)
      const stat = fs.statSync(fp)
      if (now - stat.mtimeMs > STATE_RETENTION_MS) fs.unlinkSync(fp)
    }
  } catch {}
}

module.exports = {
  canUseStateDir,
  cleanupOldState,
  diagnosticLogPath,
  findNearestGitDir,
  hash,
  projectStatePath,
  sanitize,
  stateDir,
  statePath,
  writeTextAtomic,
}
