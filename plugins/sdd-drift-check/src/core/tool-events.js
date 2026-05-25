const FILE_TOOL_NAMES = new Set(["read", "edit", "write", "multiedit"])
const SUBAGENT_CHECKPOINT_TOOL_NAMES = new Set([
  "background_output",
  "delegate_task",
  "task",
])
const QUESTION_CHECKPOINT_TOOL_NAMES = new Set([
  "ask_user",
  "ask_user_question",
  "askuser",
  "askuserquestion",
  "confirm",
  "confirmation",
  "question",
])

const getToolFilePath = (args) =>
  args?.file_path || args?.filePath || args?.path || args?.file

const normalizeToolName = (tool) => {
  const name = String(tool || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s.]+/g, "_")
  if (name === "multi_edit" || name === "multi-edit") return "multiedit"
  return name
}

const isSubagentCheckpointTool = (tool) => {
  const normalized = normalizeToolName(tool)
  if (normalized === "background_task") return false
  return SUBAGENT_CHECKPOINT_TOOL_NAMES.has(normalized)
}

const isQuestionCheckpointTool = (tool) =>
  QUESTION_CHECKPOINT_TOOL_NAMES.has(normalizeToolName(tool))

const isSupportedOpenCodeToolEvent = (tool, args) => {
  const normalized = normalizeToolName(tool)
  if (FILE_TOOL_NAMES.has(normalized) && getToolFilePath(args || {})) return true
  if (normalized === "background_task") return false
  if (isQuestionCheckpointTool(normalized)) return true
  return isSubagentCheckpointTool(normalized)
}

const normalizeToolArgs = (args) => {
  const copy = { ...(args || {}) }
  const fp = getToolFilePath(copy)
  if (fp && !copy.file_path) copy.file_path = fp
  return copy
}

module.exports = {
  FILE_TOOL_NAMES,
  SUBAGENT_CHECKPOINT_TOOL_NAMES,
  QUESTION_CHECKPOINT_TOOL_NAMES,
  getToolFilePath,
  isQuestionCheckpointTool,
  isSubagentCheckpointTool,
  isSupportedOpenCodeToolEvent,
  normalizeToolArgs,
  normalizeToolName,
}
