const path = require("path")

const toPosix = (fp) => String(fp || "").replace(/\\/g, "/")

const isCaseInsensitiveFs = () => process.platform === "win32" || process.platform === "darwin"

const normalizeKey = (fp) => {
  const normalized = toPosix(path.resolve(fp))
  return isCaseInsensitiveFs() ? normalized.toLowerCase() : normalized
}

const samePath = (left, right) => normalizeKey(left) === normalizeKey(right)

const rel = (cwd, fp) => toPosix(path.relative(cwd, fp))

const resolveFile = (cwd, fp) => (path.isAbsolute(fp) ? path.normalize(fp) : path.resolve(cwd, fp))

module.exports = {
  isCaseInsensitiveFs,
  normalizeKey,
  rel,
  resolveFile,
  samePath,
  toPosix,
}
