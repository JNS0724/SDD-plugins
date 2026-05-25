const fs = require("fs")
const os = require("os")
const path = require("path")
const { isCodePath } = require("./file-classifier")
const { normalizeKey, rel, resolveFile, samePath } = require("./paths")
const {
  CHECKPOINT_MTIME_SCAN,
  CHECKPOINT_MTIME_SCAN_MAX_FILES,
  CHECKPOINT_MTIME_SCAN_MAX_VISITS,
  CHECKPOINT_MTIME_WINDOW_MS,
  CHECKPOINT_OUTPUT_TEXT_MAX_BYTES,
  DTS_CONTEXT_SKIP,
} = require("./runtime-config")
const { hasSddWorkspace } = require("./sdd-rules")
const { applyToolRecord, fileMtimeMs, markTranscriptEvent, recordFile } = require("./session-state")
const { hash } = require("./state-storage")
const { isSubagentCheckpointTool } = require("./tool-events")

const CHECKPOINT_OUTPUT_KEYS = [
  "tool_output",
  "tool_result",
  "tool_response",
  "result",
  "output",
  "response",
]
const CHECKPOINT_EDIT_LINE_RE =
  /\b(changed|modified|edited|updated|created|wrote|written|implemented|generated|patched|touched|saved|added|deleted|removed|renamed|refactored)\b|已修改|已更新|已创建|已写入|已实现|已生成|写入|修改|更新|创建|实现|变更/i
const CHECKPOINT_EDIT_HEADER_RE =
  /\b(files?\s+(changed|modified|edited|updated|created|written)|changed\s+files?|modified\s+files?|updated\s+files?|created\s+files?|implementation\s+changes?)\b|变更文件|修改文件|更新文件|创建文件|已修改文件|已更新文件/i
const CHECKPOINT_COMPLETION_RE =
  /\b(implemented|fixed|updated|created|modified|changed|wrote|patched|refactored|built|generated|saved|completed implementation|implementation complete|feature complete)\b|已完成|完成实现|实现完成|已实现|已修复|已更新|已修改|已创建|已写入|完成修改|修复完成|更新完成|修改完成/i
const CHECKPOINT_PATH_RE =
  /(?:[A-Za-z]:)?(?:[A-Za-z0-9_. -]+[\\/])*(?:[A-Za-z0-9_. -]+\.(?:ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)|(?:proposal|design|tasks)\.md)/gi
const CHECKPOINT_PATH_IGNORE_RE =
  /^(?:node_modules|\.git|\.opencode|\.claude|\.sdd-drift-hook-state|\.real-workspaces)(?:\/|$)/

const limitString = (value, max = 500) => {
  const text = String(value || "")
  return text.length > max ? `${text.slice(0, max)}...` : text
}

const isDtsContextActive = (state) => DTS_CONTEXT_SKIP && Boolean(state.dtsContext?.active)

const resolveTranscriptPath = (input) => {
  const explicit = input?.transcript_path
  if (explicit && typeof explicit === "string" && fs.existsSync(explicit)) {
    return explicit
  }

  const sessionID = input?.session_id
  if (!sessionID || typeof sessionID !== "string") return explicit

  const candidates = []
  const todoPath = input?.todo_path
  if (todoPath && typeof todoPath === "string") {
    const claudeDir = path.dirname(path.dirname(todoPath))
    candidates.push(path.join(claudeDir, "transcripts", `${sessionID}.jsonl`))
  }

  const homes = [process.env.HOME, process.env.USERPROFILE, os.homedir()].filter(Boolean)
  for (const home of homes) {
    candidates.push(path.join(home, ".claude", "transcripts", `${sessionID}.jsonl`))
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || explicit
}

const transcriptContentBlocks = (entry) => {
  const content = entry?.message?.content
  if (Array.isArray(content)) return content
  return []
}

const transcriptToolUseRecord = (block) => {
  const name = block?.name || block?.tool || block?.tool_name
  const input = block?.input || block?.tool_input || block?.state?.input
  if (!name || !input || typeof input !== "object") return null
  return {
    id: block.id || block.tool_use_id || block.callID || block.call_id || null,
    name,
    input,
    source: "tool_use",
    completed: block?.state?.status === "completed",
  }
}

const transcriptToolResultRecord = (entry, block) => {
  const result = entry?.tool_use_result || block?.tool_use_result
  const id = block?.tool_use_id || entry?.parent_tool_use_id || entry?.tool_use_id || null
  const failed = Boolean(entry?.is_error || block?.is_error || result?.is_error || result?.error)
  const fp = result?.filePath || result?.file_path
  if (!fp || typeof fp !== "string") {
    return id ? { id, source: "tool_result", failed } : null
  }

  const type = String(result?.type || "").toLowerCase()
  const name =
    type === "text" && !result?.oldString && !result?.newString && !result?.structuredPatch
      ? "Read"
      : "Edit"
  return {
    id,
    name,
    input: { file_path: fp },
    source: "tool_result",
    failed,
  }
}

const transcriptLegacyToolResultRecord = (entry) => {
  const name = entry?.tool_name
  const input = entry?.tool_input
  if (!name || !input || typeof input !== "object") return null
  return {
    id: entry.tool_use_id || null,
    name,
    input,
    source: "tool_result",
    failed: Boolean(entry?.is_error || entry?.error),
  }
}

const transcriptToolRecords = (entry) => {
  const records = []
  const blocks = transcriptContentBlocks(entry)
  const add = (record) => {
    if (record) records.push(record)
  }

  add(transcriptToolUseRecord(entry))
  if (entry?.part?.type === "tool") add(transcriptToolUseRecord(entry.part))
  if (entry?.type === "tool_result") {
    add(transcriptLegacyToolResultRecord(entry))
  }

  for (const block of blocks) {
    if (block?.type === "tool_use") add(transcriptToolUseRecord(block))
    if (block?.type === "tool_result") add(transcriptToolResultRecord(entry, block))
  }

  if (entry?.type === "user" && !blocks.some((block) => block?.type === "tool_result")) {
    add(transcriptToolResultRecord(entry, null))
  }
  return records
}

const transcriptToolEventKey = (record, lineIndex, recordIndex) => {
  if (record?.id) return `id:${record.id}`
  return `pos:${lineIndex}:${recordIndex}:${hash(
    JSON.stringify({
      name: String(record?.name || "").toLowerCase(),
      input: record?.input || {},
    })
  )}`
}

const countTranscriptLines = (text) => {
  if (!text) return 0
  const newlines = (text.match(/\n/g) || []).length
  return text.endsWith("\n") ? newlines : newlines + 1
}

const readTranscriptChunk = (state, transcriptPath) => {
  const abs = path.resolve(transcriptPath)
  const stat = fs.statSync(abs)
  const sameCursor = state.transcriptCursor?.path === abs
  let offset = sameCursor ? Number(state.transcriptCursor?.offset || 0) : 0
  let lineIndex = sameCursor ? Number(state.transcriptCursor?.lineIndex || 0) : 0

  if (!Number.isFinite(offset) || offset < 0 || offset > stat.size) {
    offset = 0
    lineIndex = 0
  }

  const buffer = fs.readFileSync(abs).subarray(offset)
  if (!buffer.length) {
    state.transcriptCursor = { path: abs, offset, lineIndex }
    return { content: "", lineIndexBase: lineIndex }
  }

  let processLength = buffer.length
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline >= 0) {
    const tail = buffer.subarray(lastNewline + 1).toString("utf8").trim()
    processLength = tail && !(tail.startsWith("{") && tail.endsWith("}")) ? lastNewline + 1 : buffer.length
  } else if (offset > 0) {
    const tail = buffer.toString("utf8").trim()
    processLength = tail.startsWith("{") && tail.endsWith("}") ? buffer.length : 0
  }

  const processBuffer = buffer.subarray(0, processLength)
  const content = processBuffer.toString("utf8")
  const nextOffset = offset + processLength
  const nextLineIndex = lineIndex + countTranscriptLines(content)
  state.transcriptCursor = { path: abs, offset: nextOffset, lineIndex: nextLineIndex }
  return { content, lineIndexBase: lineIndex }
}

const hydrateStateFromTranscript = (cwd, state, transcriptPath) => {
  if (!transcriptPath || typeof transcriptPath !== "string") return false

  let changed = false
  let content = ""
  let lineIndexBase = 0
  const seen = new Set()
  const pendingToolUses = new Map()
  try {
    const chunk = readTranscriptChunk(state, transcriptPath)
    content = chunk.content
    lineIndexBase = chunk.lineIndexBase
  } catch {
    return false
  }
  if (!content) return false

  const lines = content.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    if (!line.trim()) continue

    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    const records = transcriptToolRecords(entry)
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const record = records[recordIndex]
      if (record.source === "tool_use" && record.id && !record.completed) {
        pendingToolUses.set(record.id, record)
        continue
      }

      let finalRecord = record
      if (record.source === "tool_result" && record.id && pendingToolUses.has(record.id)) {
        finalRecord = {
          ...pendingToolUses.get(record.id),
          source: "tool_result",
          failed: record.failed,
        }
      }
      if (finalRecord.failed) continue
      if (finalRecord.source === "tool_use" && !finalRecord.completed) continue

      const key = transcriptToolEventKey(finalRecord, lineIndexBase + lineIndex, recordIndex)
      if (seen.has(key)) continue
      seen.add(key)
      if (!markTranscriptEvent(state, key)) continue
      if (recordToolFromHydration(cwd, state, finalRecord.name, finalRecord.input)) changed = true
    }
  }

  return changed
}

const recordToolFromHydration = (cwd, state, toolName, toolInput) => {
  return applyToolRecord(cwd, state, toolName, toolInput)
}

const collectCheckpointStrings = (value, depth = 0, seen = new Set()) => {
  if (value == null || depth > 4) return []
  if (typeof value === "string") return [limitString(value, CHECKPOINT_OUTPUT_TEXT_MAX_BYTES)]
  if (typeof value !== "object") return []
  if (seen.has(value)) return []
  seen.add(value)

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCheckpointStrings(item, depth + 1, seen))
  }

  const texts = []
  for (const key of [
    "output",
    "content",
    "text",
    "message",
    "summary",
    "result",
    "stdout",
    "value",
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      texts.push(...collectCheckpointStrings(value[key], depth + 1, seen))
    }
  }
  return texts
}

const collectCheckpointOutputText = (input) => {
  const texts = []
  for (const key of CHECKPOINT_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input || {}, key)) {
      texts.push(...collectCheckpointStrings(input[key]))
    }
  }
  return limitString(texts.filter(Boolean).join("\n"), CHECKPOINT_OUTPUT_TEXT_MAX_BYTES)
}

const stripCheckpointPathToken = (token) =>
  String(token || "")
    .replace(/^[\s"'`(<\[\-*]+/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/[\s"'`)>.,;:\]]+$/, "")

const isInsideWorkspace = (cwd, fp) => {
  const relative = path.relative(path.resolve(cwd), path.resolve(fp))
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

const isIgnoredCheckpointPath = (cwd, fp) => {
  const relative = rel(cwd, fp)
  return CHECKPOINT_PATH_IGNORE_RE.test(relative)
}

const checkpointLineMayDescribeEdit = (line, priorHeaderLines) =>
  CHECKPOINT_EDIT_LINE_RE.test(line) || priorHeaderLines > 0

const extractCheckpointEditedPaths = (cwd, text) => {
  const paths = []
  let headerCarry = 0
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      headerCarry = 0
      continue
    }

    if (CHECKPOINT_EDIT_HEADER_RE.test(line)) {
      headerCarry = 4
    }
    const mayDescribeEdit = checkpointLineMayDescribeEdit(line, headerCarry)
    if (headerCarry > 0) headerCarry -= 1
    if (!mayDescribeEdit) continue

    for (const match of line.matchAll(CHECKPOINT_PATH_RE)) {
      const token = stripCheckpointPathToken(match[0])
      if (!token) continue
      const abs = path.isAbsolute(token) ? path.resolve(token) : resolveFile(cwd, token)
      if (!isInsideWorkspace(cwd, abs)) continue
      if (isIgnoredCheckpointPath(cwd, abs)) continue
      if (!fs.existsSync(abs)) continue
      if (!isCodePath(abs)) continue
      if (!paths.some((existing) => samePath(existing, abs))) paths.push(path.normalize(abs))
    }
  }
  return paths
}

const checkpointOutputSuggestsCodeEdit = (text) =>
  CHECKPOINT_EDIT_LINE_RE.test(text || "") || CHECKPOINT_COMPLETION_RE.test(text || "")

const checkpointMtimeWindowMs = () => {
  if (!Number.isFinite(CHECKPOINT_MTIME_WINDOW_MS)) return 10 * 60 * 1000
  return Math.max(0, CHECKPOINT_MTIME_WINDOW_MS)
}

const checkpointMtimeScanMaxFiles = () => {
  if (!Number.isFinite(CHECKPOINT_MTIME_SCAN_MAX_FILES)) return 50
  return Math.max(1, CHECKPOINT_MTIME_SCAN_MAX_FILES)
}

const checkpointMtimeScanMaxVisits = () => {
  if (!Number.isFinite(CHECKPOINT_MTIME_SCAN_MAX_VISITS)) return 2000
  return Math.max(100, CHECKPOINT_MTIME_SCAN_MAX_VISITS)
}

const shouldRecordCheckpointMtimePath = (state, fp, cutoffMs) => {
  const mtimeMs = fileMtimeMs(fp)
  if (!mtimeMs || mtimeMs < cutoffMs) return false
  const existing = state.files[normalizeKey(fp)]
  if (existing?.editedSeq && existing?.mtimeMs && mtimeMs <= Number(existing.mtimeMs) + 1) {
    return false
  }
  return true
}

const scanRecentCheckpointCodePaths = (cwd, state, cutoffMs) => {
  const found = []
  const stack = [path.resolve(cwd)]
  let visited = 0
  const maxFiles = checkpointMtimeScanMaxFiles()
  const maxVisits = checkpointMtimeScanMaxVisits()

  while (stack.length && visited < maxVisits && found.length < maxFiles) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (visited >= maxVisits || found.length >= maxFiles) break
      const fp = path.join(dir, entry.name)
      if (!isInsideWorkspace(cwd, fp) && !samePath(cwd, fp)) continue
      if (isIgnoredCheckpointPath(cwd, fp)) continue
      visited += 1
      if (entry.isDirectory()) {
        stack.push(fp)
        continue
      }
      if (!entry.isFile()) continue
      if (!isCodePath(fp)) continue
      if (!shouldRecordCheckpointMtimePath(state, fp, cutoffMs)) continue
      found.push(path.normalize(fp))
    }
  }

  return found
}

const hydrateStateFromCheckpointMtime = (cwd, state, input, text = collectCheckpointOutputText(input)) => {
  const tool = String(input?.tool_name || "").toLowerCase()
  if (!CHECKPOINT_MTIME_SCAN) return false
  if (!hasSddWorkspace(cwd) || isDtsContextActive(state)) return false
  if (!isSubagentCheckpointTool(tool, input?.tool_input || {})) return false
  const hasText = Boolean(String(text || "").trim())
  if (hasText && !checkpointOutputSuggestsCodeEdit(text)) return false

  const now = Date.now()
  const createdAt = Date.parse(state.createdAt || "") || now
  const cutoffMs = Math.max(createdAt, now - checkpointMtimeWindowMs())
  let changed = false
  for (const fp of scanRecentCheckpointCodePaths(cwd, state, cutoffMs)) {
    recordFile(state, fp, true)
    changed = true
  }
  return changed
}

const hydrateStateFromCheckpointOutput = (cwd, state, input) => {
  const tool = String(input?.tool_name || "").toLowerCase()
  if (!isSubagentCheckpointTool(tool, input?.tool_input || {})) return false

  const text = collectCheckpointOutputText(input)
  if (!text) return hydrateStateFromCheckpointMtime(cwd, state, input, "")

  let changed = false
  for (const fp of extractCheckpointEditedPaths(cwd, text)) {
    recordFile(state, fp, true)
    changed = true
  }
  return changed || hydrateStateFromCheckpointMtime(cwd, state, input, text)
}

module.exports = {
  CHECKPOINT_COMPLETION_RE,
  CHECKPOINT_EDIT_HEADER_RE,
  CHECKPOINT_EDIT_LINE_RE,
  CHECKPOINT_OUTPUT_KEYS,
  CHECKPOINT_PATH_IGNORE_RE,
  CHECKPOINT_PATH_RE,
  checkpointLineMayDescribeEdit,
  checkpointMtimeScanMaxFiles,
  checkpointMtimeScanMaxVisits,
  checkpointMtimeWindowMs,
  checkpointOutputSuggestsCodeEdit,
  collectCheckpointOutputText,
  collectCheckpointStrings,
  countTranscriptLines,
  extractCheckpointEditedPaths,
  hydrateStateFromCheckpointMtime,
  hydrateStateFromCheckpointOutput,
  hydrateStateFromTranscript,
  isIgnoredCheckpointPath,
  isInsideWorkspace,
  readTranscriptChunk,
  recordToolFromHydration,
  resolveTranscriptPath,
  scanRecentCheckpointCodePaths,
  shouldRecordCheckpointMtimePath,
  stripCheckpointPathToken,
  transcriptToolEventKey,
  transcriptToolRecords,
}
