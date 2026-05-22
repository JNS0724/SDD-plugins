import fs from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const entry = resolve(root, "src/index.js")
const outfile = resolve(root, "sdd-drift-check-hook.js")
const checkOnly = process.argv.includes("--check")
const buildTarget = checkOnly ? resolve(root, `.sdd-drift-check-hook.${process.pid}.check.js`) : outfile

const source = fs.readFileSync(entry, "utf8")
const needsBundle = /require\(["']\.{1,2}\//.test(source) || /from\s+["']\.{1,2}\//.test(source)

if (!needsBundle) {
  fs.writeFileSync(buildTarget, source)
} else {
  let esbuild
  try {
    esbuild = await import("esbuild")
  } catch (err) {
    throw new Error("Local module sources require bundling. Run `npm install` in plugins/sdd-drift-check first.", {
      cause: err,
    })
  }

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

if (checkOnly) {
  try {
    const expected = fs.readFileSync(outfile)
    const actual = fs.readFileSync(buildTarget)
    if (!expected.equals(actual)) {
      throw new Error("sdd-drift-check-hook.js is out of date. Run `npm run build` in plugins/sdd-drift-check.")
    }
  } finally {
    try {
      fs.unlinkSync(buildTarget)
    } catch {}
  }
}
