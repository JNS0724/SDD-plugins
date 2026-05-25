import fs from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const checkOnly = process.argv.includes("--check")

const artifacts = [
  {
    name: "Claude Code command hook",
    entry: resolve(root, "src/adapters/claude-code/command-hook.js"),
    outfile: resolve(root, "sdd-drift-check-hook.js"),
  },
  {
    name: "OpenCode native plugin adapter",
    entry: resolve(root, "src/adapters/opencode/native-plugin.js"),
    outfile: resolve(root, "sdd-drift-check-opencode.js"),
  },
]

let esbuildPromise = null

const loadEsbuild = async () => {
  if (esbuildPromise) return esbuildPromise
  esbuildPromise = (async () => {
    let esbuild
    try {
      esbuild = await import("esbuild")
    } catch (err) {
      throw new Error("Local module sources require bundling. Run `npm install` in plugins/sdd-drift-check first.", {
        cause: err,
      })
    }
    return esbuild
  })()
  return esbuildPromise
}

const buildArtifact = async ({ name, entry, outfile }) => {
  const buildTarget = checkOnly
    ? resolve(root, `.${basename(outfile)}.${process.pid}.check.js`)
    : outfile

  const source = fs.readFileSync(entry, "utf8")
  const needsBundle = /require\(["']\.{1,2}\//.test(source) || /from\s+["']\.{1,2}\//.test(source)

  if (!needsBundle) {
    fs.writeFileSync(buildTarget, source)
  } else {
    const esbuild = await loadEsbuild()
    await esbuild.build({
      entryPoints: [entry],
      outfile: buildTarget,
      platform: "node",
      target: "node18",
      format: "cjs",
      bundle: true,
      minify: false,
      sourcemap: false,
      legalComments: "none",
    })
  }

  if (!checkOnly) return

  try {
    const expected = fs.readFileSync(outfile)
    const actual = fs.readFileSync(buildTarget)
    if (!expected.equals(actual)) {
      throw new Error(`${basename(outfile)} is out of date. Run \`npm run build\` in plugins/sdd-drift-check. (${name})`)
    }
  } finally {
    try {
      fs.unlinkSync(buildTarget)
    } catch {}
  }
}

for (const artifact of artifacts) {
  await buildArtifact(artifact)
}
