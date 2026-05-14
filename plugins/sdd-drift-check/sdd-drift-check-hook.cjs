const fs = require("fs")
const path = require("path")

const CODE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs)$/
const SHOW_WARNINGS = process.env.SDD_DRIFT_SHOW_WARNINGS === "1"
const STATE_DIR = ".sdd-drift-hook-state"

const toPosix = (fp) => fp.replace(/\\/g, "/")
const isSddPath = (fp) => {
  const normalized = toPosix(fp)
  return normalized.includes("/sdd/") || normalized.includes("/.sdd/")
}
const isSddChangePath = (fp) => {
  const normalized = toPosix(fp)
  return (
    normalized.includes("/sdd/changes/") ||
    normalized.includes("/.sdd/changes/")
  )
}

const readStdin = () =>
  new Promise((resolve, reject) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", () => resolve(data))
    process.stdin.on("error", reject)
  })

const sanitize = (value) => String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_")
const statePath = (cwd, sessionID) =>
  path.join(cwd, STATE_DIR, `${sanitize(sessionID)}.json`)

const emptyState = () => ({
  touched: [],
  edited: [],
  changeDirs: [],
})

const loadState = (cwd, sessionID) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(cwd, sessionID), "utf8"))
    return {
      touched: Array.isArray(parsed.touched) ? parsed.touched : [],
      edited: Array.isArray(parsed.edited) ? parsed.edited : [],
      changeDirs: Array.isArray(parsed.changeDirs) ? parsed.changeDirs : [],
    }
  } catch {
    return emptyState()
  }
}

const saveState = (cwd, sessionID, state) => {
  fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true })
  fs.writeFileSync(statePath(cwd, sessionID), JSON.stringify(state, null, 2))
}

const deleteState = (cwd, sessionID) => {
  try {
    fs.unlinkSync(statePath(cwd, sessionID))
  } catch {}
}

const addUnique = (items, item) => {
  if (!items.includes(item)) items.push(item)
}

const resolveFile = (cwd, fp) =>
  path.isAbsolute(fp) ? path.normalize(fp) : path.resolve(cwd, fp)

const findSdd = (fp) => {
  let dir = path.dirname(fp)
  while (dir !== path.dirname(dir)) {
    for (const name of ["sdd", ".sdd"]) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate
      } catch {}
    }
    dir = path.dirname(dir)
  }
  return null
}

const drift = (cwd, fp, state) => {
  const warn = []
  const root = findSdd(fp)
  const rawRel = root ? path.relative(root, fp) : ""

  if (root && !rawRel.startsWith("..")) {
    const rel = toPosix(rawRel)

    if (rel.startsWith("specs/")) {
      warn.push(
        `SDD DRIFT: ${rel} was changed directly. SDD changes should normally go through sdd/changes/<id>/. If this bypass is intentional, mention it explicitly.`
      )
    }

    const match = rel.match(/^changes\/([^/]+)\/(.+\.md)$/)
    if (match) {
      const [, id, file] = match
      const dir = path.join(root, "changes", id)
      addUnique(state.changeDirs, dir)

      const peers = {
        "design.md": "tasks.md",
        "tasks.md": "design.md",
      }
      const peer = peers[file]
      if (peer) {
        const peerPath = path.join(dir, peer)
        if (fs.existsSync(peerPath) && !state.edited.includes(peerPath)) {
          warn.push(
            `SDD DRIFT: changed sdd/changes/${id}/${file}, but sdd/changes/${id}/${peer} has not been synchronized in this session. Continue with read + edit/write on the peer file before finalizing.`
          )
        }
      }
      if (file === "proposal.md") {
        warn.push(
          "SDD DRIFT: proposal.md changes usually need matching design.md / tasks.md updates. Check and synchronize them before finalizing."
        )
      }
    }
    return warn
  }

  if (CODE_EXT.test(fp)) {
    const touchedChange = state.touched.some((file) => isSddChangePath(file))
    if (!touchedChange) {
      warn.push(
        `SDD DRIFT: code file ${path.basename(fp)} was changed, but this session did not touch any sdd/changes/** file. SDD expects a change proposal first.`
      )
    }
  }

  return warn
}

const collectPeerGaps = (cwd, state) => {
  const gaps = []

  for (const dir of state.changeDirs) {
    const peers = ["design.md", "tasks.md"].filter((file) =>
      fs.existsSync(path.join(dir, file))
    )
    const edited = peers.filter((file) => state.edited.includes(path.join(dir, file)))
    const missing = peers.filter((file) => !state.edited.includes(path.join(dir, file)))
    if (edited.length && missing.length) {
      const relDir = toPosix(path.relative(cwd, dir))
      gaps.push({
        relDir,
        edited,
        missing,
      })
    }
  }

  return gaps
}

const buildToolEnforcement = (gaps) => {
  const detail = gaps
    .map(
      (gap) =>
        `- ${gap.relDir}: edited [${gap.edited.join(", ")}], missing [${gap.missing.join(", ")}]. Read and update: ${gap.missing
          .map((file) => `${gap.relDir}/${file}`)
          .join(", ")}`
    )
    .join("\n")

  return [
    "SDD drift tool result enforcement.",
    "The preceding tool changed SDD change document(s), but peer document(s) are still unsynchronized:",
    detail,
    "",
    "This assistant turn is incomplete until the missing peer document(s) are synchronized.",
    "Before any final answer, use the read tool on each missing peer file, then use edit or write to synchronize it with the edited SDD change document(s).",
    "Do not stop or summarize completion until the missing peer document(s) are updated.",
  ].join("\n")
}

const collectReportLines = (cwd, state) => {
  const lines = []

  for (const dir of state.changeDirs) {
    const candidates = ["proposal.md", "design.md", "tasks.md"]
    const exists = candidates.filter((file) => fs.existsSync(path.join(dir, file)))
    const edited = exists.filter((file) => state.edited.includes(path.join(dir, file)))
    const missing = exists.filter((file) => !state.edited.includes(path.join(dir, file)))
    if (edited.length && missing.length) {
      const relDir = toPosix(path.relative(cwd, dir))
      lines.push(
        `  - ${relDir}: edited [${edited.join(", ")}], missing [${missing.join(", ")}]`
      )
    }
  }

  const codeEdited = state.edited.filter((file) => CODE_EXT.test(file) && !isSddPath(file))
  const sddTouched = state.touched.some((file) => isSddPath(file))
  if (codeEdited.length && !sddTouched) {
    lines.push(
      `  - edited ${codeEdited.length} code file(s), but did not touch any sdd/ document`
    )
  }

  return lines
}

const refreshReport = (cwd, state) => {
  const reportPath = path.join(cwd, ".sdd-drift-report.md")
  const lines = collectReportLines(cwd, state)

  if (lines.length) {
    try {
      fs.writeFileSync(
        reportPath,
        "## " + new Date().toISOString() + "\n" + lines.join("\n") + "\n"
      )
    } catch {}
    return
  }

  try {
    fs.unlinkSync(reportPath)
  } catch {}
}

const main = async () => {
  const input = JSON.parse((await readStdin()) || "{}")
  const cwd = input.cwd || process.cwd()
  const sessionID = input.session_id || "default"
  const state = loadState(cwd, sessionID)

  if (input.hook_event_name === "Stop") {
    refreshReport(cwd, state)
    deleteState(cwd, sessionID)
    return
  }

  if (input.hook_event_name !== "PostToolUse") return

  const tool = String(input.tool_name || "").toLowerCase()
  const toolInput = input.tool_input || {}
  const fp = toolInput.file_path || toolInput.filePath || toolInput.path
  if (!fp || typeof fp !== "string") return

  const abs = resolveFile(cwd, fp)
  addUnique(state.touched, abs)

  if (tool === "edit" || tool === "write") {
    addUnique(state.edited, abs)
    const warnings = drift(cwd, abs, state)
    const peerGaps = collectPeerGaps(cwd, state)
    saveState(cwd, sessionID, state)
    refreshReport(cwd, state)

    if (peerGaps.length) {
      process.stdout.write(buildToolEnforcement(peerGaps))
    } else if (SHOW_WARNINGS && warnings.length) {
      process.stdout.write(warnings.join("\n"))
    }
    return
  }

  saveState(cwd, sessionID, state)
}

main().catch(() => {
  process.exit(0)
})
