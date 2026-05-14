import type { Plugin } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"

const CODE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs)$/
const MAX_FOLLOWUP_ATTEMPTS = 3
const FOLLOWUP_RETRY_MS = 3000
const SHOW_WARNINGS = process.env.SDD_DRIFT_SHOW_WARNINGS === "1"
const DEBUG_LOGS = SHOW_WARNINGS || process.env.SDD_DRIFT_DEBUG === "1"
const debug = (message: string) => {
  if (DEBUG_LOGS) console.error(message)
}

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
  followupAttempts: Map<string, number>
  followupLastSent: Map<string, number>
  retryTimer?: ReturnType<typeof setTimeout>
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
        followupAttempts: new Map(),
        followupLastSent: new Map(),
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

  const buildPeerFollowup = (gaps: PeerGap[], attempt?: number) => {
    const detail = gaps
      .map(
        (gap) =>
          `- ${gap.relDir}: edited [${gap.edited.join(", ")}], missing [${gap.missing.join(", ")}]`
      )
      .join("\n")
    const label = attempt
      ? `SDD drift check follow-up (attempt ${attempt}/${MAX_FOLLOWUP_ATTEMPTS}).`
      : "SDD drift check follow-up."

    return [
      label,
      "This is an automatic plugin enforcement message, not a final-answer request.",
      "Some SDD change documents were edited, but their peer documents were not synchronized:",
      detail,
      "",
      "Continue now. Do not answer with only a summary.",
      "Use the read tool on the missing peer file(s), then use edit or write to synchronize them with the edited SDD change document(s). Do not modify unrelated files.",
    ].join("\n")
  }

  const sendPeerFollowup = async (
    sessionID: string,
    gaps: PeerGap[],
    attempt: number,
    reason: string
  ) => {
    debug(
      `[sdd-drift-check] requesting peer follow-up for ${sessionID}, attempt ${attempt}, reason ${reason}`
    )
    await client.session.promptAsync({
      sessionID,
      directory,
      parts: [{ type: "text", text: buildPeerFollowup(gaps, attempt) }],
    })
  }

  const schedulePeerRetry = (sessionID: string, delay = FOLLOWUP_RETRY_MS) => {
    const st = sessions.get(sessionID)
    if (!st || st.retryTimer) return

    st.retryTimer = setTimeout(() => {
      st.retryTimer = undefined
      void (async () => {
        await requestPeerFollowup(sessionID, "retry")
      })()
    }, delay)
  }

  const requestPeerFollowup = async (sessionID: string, reason: string) => {
    const st = sessions.get(sessionID)
    if (!st) return false

    const now = Date.now()
    const gaps = collectPeerGaps(st)
    const retryableGaps = gaps.filter(
      (gap) =>
        (st.followupAttempts.get(gap.key) || 0) < MAX_FOLLOWUP_ATTEMPTS
    )
    if (!retryableGaps.length) return false

    const sendableGaps = retryableGaps.filter(
      (gap) => now - (st.followupLastSent.get(gap.key) || 0) >= FOLLOWUP_RETRY_MS
    )
    if (!sendableGaps.length) {
      schedulePeerRetry(sessionID)
      return true
    }

    let attempt = 1
    for (const gap of sendableGaps) {
      const next = (st.followupAttempts.get(gap.key) || 0) + 1
      st.followupAttempts.set(gap.key, next)
      st.followupLastSent.set(gap.key, now)
      attempt = Math.max(attempt, next)
    }

    try {
      await sendPeerFollowup(sessionID, sendableGaps, attempt, reason)
      schedulePeerRetry(sessionID)
      return true
    } catch (err) {
      for (const gap of sendableGaps) {
        st.followupAttempts.set(
          gap.key,
          Math.max(0, (st.followupAttempts.get(gap.key) || 1) - 1)
        )
        st.followupLastSent.delete(gap.key)
      }
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[sdd-drift-check] peer follow-up failed: ${message}`)
      schedulePeerRetry(sessionID)
      return false
    }
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
        if (SHOW_WARNINGS && warnings.length) {
          output.output =
            (output.output || "") + "\n\n---\n" + warnings.join("\n")
        }
        if (collectPeerGaps(st).length) {
          await requestPeerFollowup(input.sessionID, "tool.execute.after")
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
      debug(
        `[sdd-drift-check] messages.transform injected peer follow-up for ${sessionID}`
      )
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
      const retryablePeerGaps = peerGaps.filter(
        (gap) => (st.followupAttempts.get(gap.key) || 0) < MAX_FOLLOWUP_ATTEMPTS
      )
      if (retryablePeerGaps.length) {
        await requestPeerFollowup(sessionID, "session.idle")
        return
      }

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
        const report = `SDD session drift (${ts})\n${lines.join("\n")}\n`
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
