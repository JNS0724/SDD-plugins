import fs from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Bundle local source into single-file distributables + byte-check (build:check).
// Mirrors sibling sdd-drift-check/build.mjs.

const root = dirname(fileURLToPath(import.meta.url))
const checkOnly = process.argv.includes("--check")

const artifacts = [
  {
    name: "Claude Code command hook",
    entry: resolve(root, "src/adapters/claude-code/command-hook.js"),
    outfile: resolve(root, "sdd-review-ledger-hook.js"),
    format: "cjs",
  },
  {
    name: "OpenCode native plugin adapter",
    entry: resolve(root, "src/adapters/opencode/native-plugin-entry.js"),
    outfile: resolve(root, "sdd-review-ledger-opencode.js"),
    format: "esm",
  },
]

let esbuildPromise = null
const loadEsbuild = async () => {
  if (esbuildPromise) return esbuildPromise
  esbuildPromise = (async () => {
    try {
      return await import("esbuild")
    } catch (err) {
      throw new Error("Bundling requires esbuild. Run `npm install` in plugins/sdd-review-ledger first.", { cause: err })
    }
  })()
  return esbuildPromise
}

const buildArtifact = async ({ name, entry, outfile, format }) => {
  const buildTarget = checkOnly ? resolve(root, `.${basename(outfile)}.${process.pid}.check.js`) : outfile

  const esbuild = await loadEsbuild()
  await esbuild.build({
    entryPoints: [entry],
    outfile: buildTarget,
    platform: "node",
    target: "node18",
    format,
    bundle: true,
    banner:
      format === "esm"
        ? { js: 'import { createRequire as __sddCreateRequire } from "node:module";\nconst require = __sddCreateRequire(import.meta.url);' }
        : undefined,
    minify: false,
    sourcemap: false,
    legalComments: "none",
  })

  if (!checkOnly) return

  try {
    const expected = fs.readFileSync(outfile)
    const actual = fs.readFileSync(buildTarget)
    if (!expected.equals(actual)) {
      throw new Error(`${basename(outfile)} is out of date. Run \`npm run build\`. (${name})`)
    }
  } finally {
    try {
      fs.unlinkSync(buildTarget)
    } catch {}
  }
}

for (const artifact of artifacts) await buildArtifact(artifact)
