import type { Plugin } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"

// Legacy OpenCode plugin entry. The maintained implementation is
// sdd-drift-check-hook.cjs, installed through oh-my-opencode Claude-compatible
// hooks. Keep this file only for older experiments and do not install it for
// current SDD drift enforcement.

const CODE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs)$/
const SHOW_WARNINGS = process.env.SDD_DRIFT_SHOW_WARNINGS === "1"

const toPosix = (fp: string) => fp.replace(/\\/g, "/")
const isSddPath = (fp: string) => {
  const normalized = toPosix(fp)
  return normalized.includes("/sdd/") || normalized.includes("/.sdd/")
}
const isSddChangePath = (fp: string) => {
  const normalized = toPosix(fp)
  return (
    normalized.includes("/sdd/changes/") ||
    normalized.includes("/.sdd/changes/")
  )
}

type State = {
  touched: Set<string>
  edited: Set<string>
  changeDirs: Set<string>
}

type PeerGap = {
  key: string
  relDir: string
  edited: string[]
  missing: string[]
}

export const SddDriftCheck: Plugin = async ({ directory }) => {
  const sessions = new Map<string, State>()

  const ensure = (id: string): State => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        touched: new Set(),
        edited: new Set(),
        changeDirs: new Set(),
      })
    }
    return sessions.get(id)!
  }

  const resolveFile = (fp: string) =>
    path.isAbsolute(fp) ? path.normalize(fp) : path.resolve(directory, fp)

  const collectPeerGaps = (st: State): PeerGap[] => {
    const gaps: PeerGap[] = []

    for (const dir of st.changeDirs) {
      const peers = ["design.md", "tasks.md"].filter((f) =>
        fs.existsSync(path.join(dir, f))
      )
      const edited = peers.filter((f) => st.edited.has(path.join(dir, f)))
      const missing = peers.filter((f) => !st.edited.has(path.join(dir, f)))
      if (edited.length && missing.length) {
        const relDir = toPosix(path.relative(directory, dir))
        gaps.push({
          key: `${relDir}:${missing.join(",")}`,
          relDir,
          edited,
          missing,
        })
      }
    }

    return gaps
  }

  const buildToolEnforcement = (gaps: PeerGap[]) => {
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

  const findSdd = (fp: string): string | null => {
    let dir = path.dirname(fp)
    while (dir !== path.dirname(dir)) {
      for (const n of ["sdd", ".sdd"]) {
        const c = path.join(dir, n)
        try {
          if (fs.statSync(c).isDirectory()) return c
        } catch {}
      }
      dir = path.dirname(dir)
    }
    return null
  }

  const drift = (fp: string, st: State): string[] => {
    const warn: string[] = []
    const root = findSdd(fp)

    const rawRel = root ? path.relative(root, fp) : ""
    if (root && !rawRel.startsWith("..")) {
      const rel = toPosix(rawRel)

      if (rel.startsWith("specs/")) {
        warn.push(
          `SDD DRIFT: ${rel} was changed directly. SDD changes should normally go through sdd/changes/<id>/. If this bypass is intentional, mention it explicitly.`
        )
      }

      const m = rel.match(/^changes\/([^/]+)\/(.+\.md)$/)
      if (m) {
        const [, id, file] = m
        const dir = path.join(root, "changes", id)
        st.changeDirs.add(dir)

        const peers: Record<string, string> = {
          "design.md": "tasks.md",
          "tasks.md": "design.md",
        }
        const peer = peers[file]
        if (peer) {
          const peerPath = path.join(dir, peer)
          if (fs.existsSync(peerPath) && !st.edited.has(peerPath)) {
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
      const touchedChange = [...st.touched].some((f) => isSddChangePath(f))
      if (!touchedChange) {
        warn.push(
          `SDD DRIFT: code file ${path.basename(fp)} was changed, but this session did not touch any sdd/changes/** file. SDD expects a change proposal first.`
        )
      }
    }
    return warn
  }

  return {
    "tool.execute.after": async (input, output) => {
      const tool = input.tool.toLowerCase()
      const fp = (input as any).args?.filePath
      if (!fp || typeof fp !== "string") return

      const abs = resolveFile(fp)
      const st = ensure(input.sessionID)
      st.touched.add(abs)

      if (tool === "edit" || tool === "write") {
        st.edited.add(abs)
        const warnings = drift(abs, st)
        const peerGaps = collectPeerGaps(st)
        if (peerGaps.length) {
          output.output =
            (output.output || "") + "\n\n---\n" + buildToolEnforcement(peerGaps)
        } else if (SHOW_WARNINGS && warnings.length) {
          output.output =
            (output.output || "") + "\n\n---\n" + warnings.join("\n")
        }
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event as any).properties?.sessionID
      if (!sessionID) return
      const st = sessions.get(sessionID)
      if (!st) return

      const lines: string[] = []

      for (const dir of st.changeDirs) {
        const candidates = ["proposal.md", "design.md", "tasks.md"]
        const exists = candidates.filter((f) =>
          fs.existsSync(path.join(dir, f))
        )
        const edited = exists.filter((f) => st.edited.has(path.join(dir, f)))
        const missing = exists.filter((f) => !st.edited.has(path.join(dir, f)))
        if (edited.length && missing.length) {
          const relDir = toPosix(path.relative(directory, dir))
          lines.push(
            `  - ${relDir}: edited [${edited.join(", ")}], missing [${missing.join(", ")}]`
          )
        }
      }

      const codeEdited = [...st.edited].filter(
        (f) => CODE_EXT.test(f) && !isSddPath(f)
      )
      const sddTouched = [...st.touched].some((f) => isSddPath(f))
      if (codeEdited.length && !sddTouched) {
        lines.push(
          `  - edited ${codeEdited.length} code file(s), but did not touch any sdd/ document`
        )
      }

      if (lines.length) {
        const ts = new Date().toISOString()
        try {
          fs.appendFileSync(
            path.join(directory, ".sdd-drift-report.md"),
            "\n## " + ts + "\n" + lines.join("\n") + "\n"
          )
        } catch {}
      }

      sessions.delete(sessionID)
    },
  }
}
