const { toPosix } = require("./paths")

const splitPath = (fp) => toPosix(fp).split("/").filter(Boolean)

const sharedPrefixDepth = (left, right) => {
  const leftParts = splitPath(left)
  const rightParts = splitPath(right)
  let depth = 0
  while (depth < leftParts.length && depth < rightParts.length && leftParts[depth] === rightParts[depth]) {
    depth += 1
  }
  return depth
}

const relFromCwd = (cwd, fp) => {
  const normalizedCwd = toPosix(cwd).replace(/\/+$/, "")
  const normalizedFile = toPosix(fp)
  return normalizedFile.startsWith(`${normalizedCwd}/`)
    ? normalizedFile.slice(normalizedCwd.length + 1)
    : normalizedFile
}

const pathInChangeDir = (cwd, fp, relDir) => {
  const relFile = relFromCwd(cwd, fp)
  const normalizedDir = toPosix(relDir).replace(/\/+$/, "")
  return relFile === normalizedDir || relFile.startsWith(`${normalizedDir}/`)
}

const pathSimilar = (cwd, codeFile, linkedCode = []) => {
  const relCodeFile = relFromCwd(cwd, codeFile)
  return linkedCode.some((item) => {
    const linkedPath = toPosix(item?.path || "")
    if (!linkedPath) return false
    return linkedPath === relCodeFile || sharedPrefixDepth(relCodeFile, linkedPath) >= 2
  })
}

const decide = ({ cwd, session, project, codeFile, now = Date.now() }) => {
  const candidates = Object.values(project?.changeDirs || {}).filter((dir) => !dir.archived)
  if (candidates.length === 0) return { kind: "no-attribution" }
  if (candidates.length === 1) return { kind: "single", target: candidates[0] }

  const sessionTouched = candidates.filter((dir) =>
    (session?.edited || []).some((file) => pathInChangeDir(cwd, file, dir.relDir))
  )
  if (sessionTouched.length === 1) return { kind: "session-touched", target: sessionTouched[0] }

  if (project?.activeChangeDir && now < Number(project.activeUntilMs || 0)) {
    const active = candidates.find((dir) => dir.relDir === project.activeChangeDir)
    if (active && pathSimilar(cwd, codeFile, active.linkedCode)) {
      return { kind: "active-ttl", target: active }
    }
  }

  return { kind: "needs-review", candidates }
}

const targetsForDecision = (decision) => {
  if (decision?.target) return [decision.target]
  return decision?.candidates || []
}

const Attribution = {
  decide,
  pathInChangeDir,
  pathSimilar,
  relFromCwd,
  sharedPrefixDepth,
  targetsForDecision,
}

module.exports = { Attribution }
