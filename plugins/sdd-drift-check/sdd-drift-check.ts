import type { Plugin } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"

const CODE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs)$/
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
  followupSent: Set<string>
}

type PeerGap = {
  key: string
  relDir: string
  edited: string[]
  missing: string[]
}

export const SddDriftCheck: Plugin = async ({ directory, client }) => {
  const sessions = new Map<string, State>()

  const ensure = (id: string): State => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        touched: new Set(),
        edited: new Set(),
        changeDirs: new Set(),
        followupSent: new Set(),
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

  const buildPeerFollowup = (gaps: PeerGap[]) => {
    const detail = gaps
      .map(
        (gap) =>
          `- ${gap.relDir}: edited [${gap.edited.join(", ")}], missing [${gap.missing.join(", ")}]`
      )
      .join("\n")
    return [
      "SDD drift check follow-up.",
      "Some SDD change documents were edited, but their peer documents were not synchronized:",
      detail,
      "",
      "Before giving a final answer, continue this same task. Read the missing peer file(s), update them to match the edited SDD change document(s), and do not modify unrelated files.",
    ].join("\n")
  }

  const sendPeerFollowup = async (sessionID: string, gaps: PeerGap[]) => {
    const text = buildPeerFollowup(gaps)
    console.error(`[sdd-drift-check] requesting peer follow-up for ${sessionID}`)
    await client.session.prompt({
      sessionID,
      directory,
      parts: [{ type: "text", text }],
    })
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
          `⚠ 直接修改了 ${rel}。SDD 流程要求通过 sdd/changes/<id>/ 提出变更，确认要绕过？`
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
              `⚠ 改了 sdd/changes/${id}/${file}，本会话未同步 sdd/changes/${id}/${peer}。`
            )
          }
        }
        if (file === "proposal.md") {
          warn.push(
            `⚠ proposal.md 变更通常牵连同目录 design.md / tasks.md，请检查。`
          )
        }
      }
      return warn
    }

    if (CODE_EXT.test(fp)) {
      const touchedChange = [...st.touched].some(
        (f) => isSddChangePath(f)
      )
      if (!touchedChange) {
        warn.push(
          `⚠ 修改了代码 (${path.basename(fp)})，但本会话未读/改任何 sdd/changes/**。SDD 要求先有变更提案。`
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
        if (warnings.length) {
          output.output =
            (output.output || "") + "\n\n---\n" + warnings.join("\n")
        }
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const latest = output.messages[output.messages.length - 1]
      const sessionID = latest?.info.sessionID
      if (!sessionID) return
      const st = sessions.get(sessionID)
      if (!st) return

      const peerGaps = collectPeerGaps(st)
      if (!peerGaps.length) return

      const userMessage = [...output.messages]
        .reverse()
        .find((message) => message.info.role === "user")
      if (!userMessage) return

      const now = Date.now()
      userMessage.parts.push({
        id: `sdd_drift_${now}`,
        sessionID,
        messageID: userMessage.info.id,
        type: "text",
        text: buildPeerFollowup(peerGaps),
        synthetic: true,
        time: { start: now },
      } as any)
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event as any).properties?.sessionID
      if (!sessionID) return
      const st = sessions.get(sessionID)
      if (!st) return

      const peerGaps = collectPeerGaps(st)
      const unsentPeerGaps = peerGaps.filter(
        (gap) => !st.followupSent.has(gap.key)
      )
      if (unsentPeerGaps.length) {
        for (const gap of unsentPeerGaps) st.followupSent.add(gap.key)
        try {
          await sendPeerFollowup(sessionID, unsentPeerGaps)
          return
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[sdd-drift-check] peer follow-up failed: ${message}`)
        }
      }

      const lines: string[] = []

      for (const dir of st.changeDirs) {
        const candidates = ["proposal.md", "design.md", "tasks.md"]
        const exists = candidates.filter((f) =>
          fs.existsSync(path.join(dir, f))
        )
        const edited = exists.filter((f) =>
          st.edited.has(path.join(dir, f))
        )
        const missing = exists.filter(
          (f) => !st.edited.has(path.join(dir, f))
        )
        if (edited.length && missing.length) {
          const relDir = path.relative(directory, dir)
          lines.push(
            `  • ${relDir}: 改了 [${edited.join(", ")}]，未改 [${missing.join(", ")}]`
          )
        }
      }

      const codeEdited = [...st.edited].filter(
        (f) => CODE_EXT.test(f) && !isSddPath(f)
      )
      const sddTouched = [...st.touched].some(
        (f) => isSddPath(f)
      )
      if (codeEdited.length && !sddTouched) {
        lines.push(
          `  • 改了 ${codeEdited.length} 个代码文件但全程未碰任何 sdd/ 文档`
        )
      }

      if (lines.length) {
        const ts = new Date().toISOString()
        const report = `📋 SDD 会话对账 (${ts})\n${lines.join("\n")}\n`
        console.error("\n" + report)
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
