const fs = require("fs")
const path = require("path")
const { toPosix } = require("./paths")

const STATE_DIR = ".sdd-drift-hook-state"
const PEER_FILES = ["design.md", "tasks.md"]
const PROPOSAL_FILE = "proposal.md"
const DESIGN_FILE = "design.md"
const TASKS_FILE = "tasks.md"
const REVIEW_FILES = [DESIGN_FILE, TASKS_FILE]
const ARCHIVED_CHANGE_DIR_NAMES = new Set(["archive", "archives", "archived", ".archive", ".archived", "已归档"])
const ARCHIVE_MARKER_FILES = [".archived", ".archive", "ARCHIVED", "archived.md", "archive.md", "已归档.md"]
const ARCHIVE_STATUS_FILES = ["status.md", "state.md", "metadata.md", ".status"]
const CHANGE_DOC_REQUIREMENTS = {
  [PROPOSAL_FILE]: [DESIGN_FILE],
  [DESIGN_FILE]: [TASKS_FILE],
  [TASKS_FILE]: [DESIGN_FILE],
}
const DOCUMENT_SYNC_RULES = [
  "Before editing any SDD document, read the current file and preserve its existing Markdown template.",
  "Keep every existing heading line exactly as-is, including the top-level title such as # Design or # Tasks, and keep the original heading order.",
  "Do not replace the whole document with a summary, marker, or single-line result.",
  "Do not add new sections.",
  "Do not rewrite the document template.",
  "Find the existing section that should change and edit that section only.",
  "Do not add a new section or rewrite the template just to satisfy this enforcement.",
  "Do not remove unrelated existing paragraphs, checklist items, examples, requirements, or notes while synchronizing drift.",
  "For existing SDD documents, prefer Edit or MultiEdit. If Write is necessary, copy the original file content first and write the full document including all existing headings, template text, paragraphs, and checklist items.",
  "Do not edit design.md and tasks.md in the same parallel tool batch; update one SDD document, wait for its tool result and hook feedback, then update the required peer.",
  "Find the most appropriate existing heading, paragraph, list item, or task item, and make the smallest needed update there.",
  "For tasks.md, preserve the task-list format and update the relevant existing checklist item when possible.",
]
const ACTIVE_SDD_ALIGNMENT_RULES = [
  "Active SDD documents are live planning records until their change directory is archived; before the final answer, keep active design.md and tasks.md aligned with the implemented code.",
  "Do not treat an optimization or refactor as documentation-free if it changes behavior, API or contracts, algorithms, state or data flow, data structures, performance strategy, error handling, security boundaries, user-visible results, or implementation constraints; update design.md when any of those code facts changed.",
  "Do not satisfy SDD alignment by only adding a marker, completion note, or generic summary; replace the specific stale sentence, paragraph, or checklist item so the document states the actual implemented behavior, API, error handling, performance strategy, or task status.",
  "When a changed code file adds or changes exported names, public function signatures, literal return values, config defaults, user-visible strings, or acceptance-relevant constants, carry those concrete facts into the appropriate existing design.md/tasks.md wording instead of summarizing them vaguely.",
  "After editing design.md, re-read the changed sentence mentally and ensure no old wording still contradicts the code you just wrote.",
  "Update tasks.md when the code completes, changes, cancels, splits, or invalidates an implementation task, checklist item, planned step, or acceptance condition.",
  "The no-document-change path is only valid for purely mechanical edits with no design or task impact, such as formatting-only changes, comment-only edits, test-only scaffolding, or dependency/config churn that does not change the active SDD plan.",
  "If you choose no SDD edit, explicitly state which active design.md/tasks.md files you reviewed and why the code change has no design or task impact.",
  "Modify only content relevant to the current code batch; do not invent future requirements or broaden the scope.",
]
const ATTRIBUTION_REVIEW_RULES = [
  "Purely mechanical changes (formatting, comment-only edits, test-scaffolding, dependency bumps, lint fixes) do not require any SDD document update. State this conclusion explicitly in your response and continue.",
  "If the code change implements behavior already described in a candidate change-dir's design.md, and that change-dir's tasks.md already reflects the implementation, no SDD action is needed.",
  "If the code change adds, changes, or removes behavior not described in any candidate change-dir's design.md, update the most relevant change-dir's design.md to state the actual implemented behavior. Update tasks.md if a tracked task item is now complete or invalidated.",
  "If the code change is genuinely unrelated to any active change-dir, acknowledge it as out-of-SDD scope in your response, or create a new sdd/changes/<id>/ directory when the work is feature-sized and warrants tracking.",
  "If multiple candidate change-dirs could apply, choose the most specific match based on design.md content and briefly document the reasoning in your response. Do not edit unrelated change-dirs.",
]
const SUBAGENT_REVIEW_RULE =
  "If the current environment supports subagents and a read-only review subagent is allowed, you may delegate SDD review to it; otherwise perform the review yourself with the read tool. The main agent remains responsible for any final edits."
const RESUME_ORIGINAL_TASK_RULES = [
  "SDD review is a checkpoint inside the current task, not the final task.",
  "Treat SDD review/synchronization as a checkpoint inside the current user task, not as the whole task.",
  "After the SDD review or synchronization is complete, return to the original user task.",
  "After the required SDD work is complete, resume the original user task/request from where you paused if any implementation, verification, cleanup, or response work remains.",
  "Only give the final answer when both the original user task and the required SDD review/synchronization are complete.",
]

const formatAttributionReviewRules = () => [
  "When deciding whether SDD documents need edits, apply these attribution review rules in order:",
  ...ATTRIBUTION_REVIEW_RULES.map((rule, index) => `${index + 1}. ${rule}`),
]

const findSdd = (fp) => {
  const parts = toPosix(path.resolve(fp)).split("/")
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part !== "sdd" && part !== ".sdd") continue

    const rel = parts.slice(index + 1).join("/")
    if (rel === "" || rel.startsWith("changes/") || rel.startsWith("specs/")) {
      return path.normalize(parts.slice(0, index + 1).join("/"))
    }
  }
  return null
}

const getChangeDoc = (fp) => {
  const root = findSdd(fp)
  const rawRel = root ? path.relative(root, fp) : ""
  if (!root || rawRel.startsWith("..")) return null

  const rel = toPosix(rawRel)
  const match = rel.match(/^changes\/([^/]+)\/([^/]+\.md)$/)
  if (!match) return { root, rel }

  const [, id, file] = match
  return {
    root,
    rel,
    id,
    file,
    dir: path.join(root, "changes", id),
  }
}

const isArchivedChangeDirName = (dir) => {
  const name = path.basename(path.normalize(dir)).toLowerCase()
  return ARCHIVED_CHANGE_DIR_NAMES.has(name) || /(^|[-_.])(archived|已归档)($|[-_.])/.test(name)
}

const isArchiveStatusText = (text) =>
  /^\s*(status|state)\s*[:：]\s*(archived|archive|closed)\s*$/im.test(text || "") ||
  /^\s*(状态|阶段)\s*[:：]\s*(已归档|归档)\s*$/im.test(text || "")

const readSmallText = (fp) => {
  try {
    return fs.readFileSync(fp, "utf8").slice(0, 4096)
  } catch {
    return ""
  }
}

const isArchivedChangeDir = (dir) => {
  if (!dir || isArchivedChangeDirName(dir)) return true

  for (const marker of ARCHIVE_MARKER_FILES) {
    if (fs.existsSync(path.join(dir, marker))) return true
  }

  for (const statusFile of ARCHIVE_STATUS_FILES) {
    const text = readSmallText(path.join(dir, statusFile))
    if (text && isArchiveStatusText(text)) return true
  }

  return false
}

const hasSddWorkspace = (cwd) => {
  for (const name of ["sdd", ".sdd"]) {
    try {
      if (fs.statSync(path.join(cwd, name)).isDirectory()) return true
    } catch {}
  }
  return false
}

module.exports = {
  ACTIVE_SDD_ALIGNMENT_RULES,
  ARCHIVED_CHANGE_DIR_NAMES,
  ARCHIVE_MARKER_FILES,
  ARCHIVE_STATUS_FILES,
  ATTRIBUTION_REVIEW_RULES,
  CHANGE_DOC_REQUIREMENTS,
  DESIGN_FILE,
  DOCUMENT_SYNC_RULES,
  PEER_FILES,
  PROPOSAL_FILE,
  RESUME_ORIGINAL_TASK_RULES,
  REVIEW_FILES,
  STATE_DIR,
  SUBAGENT_REVIEW_RULE,
  TASKS_FILE,
  formatAttributionReviewRules,
  findSdd,
  getChangeDoc,
  hasSddWorkspace,
  isArchiveStatusText,
  isArchivedChangeDir,
  isArchivedChangeDirName,
}
