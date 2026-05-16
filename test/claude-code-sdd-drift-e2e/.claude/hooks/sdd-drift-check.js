const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const explicit = process.env.SDD_DRIFT_HOOK_SCRIPT
const candidates = [
  explicit,
  path.resolve(projectDir, "../../plugins/sdd-drift-check/sdd-drift-check-hook.js"),
  path.resolve(projectDir, "../../../../plugins/sdd-drift-check/sdd-drift-check-hook.js"),
].filter(Boolean)

const hookPath = candidates.find((candidate) => fs.existsSync(candidate))
if (!hookPath) {
  if (process.env.SDD_DRIFT_DEBUG === "1") {
    process.stderr.write(
      `[sdd-drift-check] unable to resolve hook script from ${projectDir}\n`
    )
  }
  process.exit(0)
}

const result = spawnSync(process.execPath, [hookPath], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
})

process.exit(typeof result.status === "number" ? result.status : 0)
