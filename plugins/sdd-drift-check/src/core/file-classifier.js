const path = require("path")
const { toPosix } = require("./paths")

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)$/i

const isSddPath = (fp) => {
  const normalized = toPosix(path.resolve(fp))
  return normalized.includes("/sdd/") || normalized.includes("/.sdd/")
}

const isSddChangePath = (fp) => {
  const normalized = toPosix(path.resolve(fp))
  return normalized.includes("/sdd/changes/") || normalized.includes("/.sdd/changes/")
}

const isCodePath = (fp) => CODE_EXT.test(fp) && !isSddPath(fp)

module.exports = {
  CODE_EXT,
  isCodePath,
  isSddChangePath,
  isSddPath,
}
