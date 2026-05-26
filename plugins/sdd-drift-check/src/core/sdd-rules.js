const fs = require("fs")
const path = require("path")
const { toPosix } = require("./paths")

const STATE_DIR = ".sdd-drift-hook-state"
const PROMPT_RULES_FILE = "sdd-drift-check-rules.md"
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
  "编辑任何 SDD 文档前，先读取当前文件，并保留它已有的 Markdown 模板。",
  "保持所有已有标题行不变，包括 # Design、# Tasks 这类顶层标题，并保持原有标题顺序。",
  "不要把整篇文档替换成摘要、标记或单行结果。",
  "不要新增章节。",
  "不要重写文档模板。",
  "找到最应该变更的已有章节，只修改该位置。",
  "不要为了满足插件提醒而新增章节或重写模板。",
  "同步 drift 时，不要删除无关的已有段落、清单项、示例、需求或备注。",
  "对已有 SDD 文档，优先使用 Edit 或 MultiEdit。如果必须使用 Write，先复制原文件内容，再写回包含全部已有标题、模板文本、段落和清单项的完整文档。",
  "不要在同一批并行工具调用里同时编辑 design.md 和 tasks.md；先更新一个 SDD 文档，等待工具结果和 hook 反馈，再更新需要同步的 peer 文档。",
  "找到最合适的已有标题、段落、列表项或任务项，在那里做最小必要修改。",
  "对 tasks.md，保留任务清单格式；能更新相关已有清单项时，优先更新已有项。",
]
const ACTIVE_SDD_ALIGNMENT_RULES = [
  "变更目录归档前，活跃 SDD 文档都是实时计划记录；最终回复前，要让活跃的 design.md 和 tasks.md 与已实现代码保持一致。",
  "如果优化或重构改变了行为、API 或契约、算法、状态或数据流、数据结构、性能策略、错误处理、安全边界、用户可见结果或实现约束，不要把它当成“无需更新文档”；这些代码事实变化通常需要更新 design.md。",
  "不要只添加标记、完成说明或泛泛摘要来满足 SDD 对齐；应替换具体过期的句子、段落或清单项，让文档描述真实实现的行为、API、错误处理、性能策略或任务状态。",
  "当代码新增或修改导出名称、公共函数签名、字面量返回值、配置默认值、用户可见文案或验收相关常量时，把这些具体事实同步到合适的 design.md/tasks.md 现有文字里，不要只做模糊总结。",
  "编辑 design.md 后，重新检查刚改过的句子，确保没有旧表述仍然与当前代码矛盾。",
  "当代码完成、变更、取消、拆分或使某个实现任务、清单项、计划步骤、验收条件失效时，更新 tasks.md。",
  "只有纯机械改动才适合走“无需改文档”路径，例如仅格式化、仅注释、仅测试脚手架，或不改变活跃 SDD 计划的依赖/配置变更。",
  "如果判断无需修改 SDD，明确说明已评审哪些活跃 design.md/tasks.md，以及为什么本次代码变更没有设计或任务影响。",
  "只修改与当前代码批次相关的内容；不要发明未来需求，也不要扩大范围。",
]
const ATTRIBUTION_REVIEW_RULES = [
  "纯机械改动（格式化、仅注释、测试脚手架、依赖升级、lint 修复）不需要更新 SDD 文档。请在回复里明确说明这个结论，然后继续原任务。",
  "如果代码变更实现的行为已经被某个候选 change-dir 的 design.md 描述，并且该 change-dir 的 tasks.md 也已反映实现状态，则无需 SDD 动作。",
  "如果代码变更新增、修改或移除了任何候选 change-dir 的 design.md 都没有描述的行为，应更新最相关 change-dir 的 design.md，写清实际实现行为。如果某个跟踪任务已完成或失效，也要更新 tasks.md。",
  "如果代码变更确实与任何活跃 change-dir 都无关，请在回复中说明它不属于当前 SDD 范围；如果工作已达到功能级别并值得跟踪，可以创建新的 sdd/changes/<id>/ 目录。",
  "如果多个候选 change-dir 都可能相关，根据 design.md 内容选择最具体的匹配项，并在回复中简要说明理由。不要编辑无关 change-dir。",
]
const SUBAGENT_REVIEW_RULE =
  "如果当前环境支持 subagent，并且允许只读评审 subagent，可以委托它做 SDD 评审；否则由主 agent 使用 read 工具自行评审。最终编辑责任仍由主 agent 承担。"
const RESUME_ORIGINAL_TASK_RULES = [
  "SDD 评审是当前任务中的检查点，不是最终任务本身。",
  "把 SDD 评审/同步视为当前用户任务中的检查点，不要把它当成全部任务。",
  "SDD 评审或同步完成后，回到原始用户任务。",
  "必要的 SDD 工作完成后，如果还有实现、验证、清理或回复工作未完成，从暂停处继续原始用户请求。",
  "只有原始用户任务和必要的 SDD 评审/同步都完成后，才给出最终回复。",
]

const formatAttributionReviewRules = (rules = ATTRIBUTION_REVIEW_RULES) => [
  "判断 SDD 文档是否需要修改时，按顺序应用这些归属评审规则：",
  ...rules.map((rule, index) => `${index + 1}. ${rule}`),
]

const clonePromptRules = () => ({
  DOCUMENT_SYNC_RULES: [...DOCUMENT_SYNC_RULES],
  ACTIVE_SDD_ALIGNMENT_RULES: [...ACTIVE_SDD_ALIGNMENT_RULES],
  ATTRIBUTION_REVIEW_RULES: [...ATTRIBUTION_REVIEW_RULES],
  SUBAGENT_REVIEW_RULE,
  RESUME_ORIGINAL_TASK_RULES: [...RESUME_ORIGINAL_TASK_RULES],
})

const SECTION_ALIASES = new Map([
  ["SDD EDIT RULES", "DOCUMENT_SYNC_RULES"],
  ["DOCUMENT SYNC RULES", "DOCUMENT_SYNC_RULES"],
  ["SDD 编辑规则", "DOCUMENT_SYNC_RULES"],
  ["SDD 編輯規則", "DOCUMENT_SYNC_RULES"],
  ["文档同步规则", "DOCUMENT_SYNC_RULES"],
  ["文檔同步規則", "DOCUMENT_SYNC_RULES"],
  ["ACTIVE SDD ALIGNMENT RULES", "ACTIVE_SDD_ALIGNMENT_RULES"],
  ["ALIGNMENT RULES", "ACTIVE_SDD_ALIGNMENT_RULES"],
  ["活跃 SDD 对齐规则", "ACTIVE_SDD_ALIGNMENT_RULES"],
  ["活躍 SDD 對齊規則", "ACTIVE_SDD_ALIGNMENT_RULES"],
  ["SDD 对齐规则", "ACTIVE_SDD_ALIGNMENT_RULES"],
  ["SDD 對齊規則", "ACTIVE_SDD_ALIGNMENT_RULES"],
  ["对齐规则", "ACTIVE_SDD_ALIGNMENT_RULES"],
  ["對齊規則", "ACTIVE_SDD_ALIGNMENT_RULES"],
  ["ATTRIBUTION REVIEW RULES", "ATTRIBUTION_REVIEW_RULES"],
  ["归属评审规则", "ATTRIBUTION_REVIEW_RULES"],
  ["歸屬評審規則", "ATTRIBUTION_REVIEW_RULES"],
  ["归属判断规则", "ATTRIBUTION_REVIEW_RULES"],
  ["歸屬判斷規則", "ATTRIBUTION_REVIEW_RULES"],
  ["SUBAGENT REVIEW RULE", "SUBAGENT_REVIEW_RULE"],
  ["SUBAGENT REVIEW RULES", "SUBAGENT_REVIEW_RULE"],
  ["子代理评审规则", "SUBAGENT_REVIEW_RULE"],
  ["子代理評審規則", "SUBAGENT_REVIEW_RULE"],
  ["EXIT CRITERIA", "RESUME_ORIGINAL_TASK_RULES"],
  ["RESUME ORIGINAL TASK RULES", "RESUME_ORIGINAL_TASK_RULES"],
  ["退出标准", "RESUME_ORIGINAL_TASK_RULES"],
  ["退出標準", "RESUME_ORIGINAL_TASK_RULES"],
  ["完成标准", "RESUME_ORIGINAL_TASK_RULES"],
  ["完成標準", "RESUME_ORIGINAL_TASK_RULES"],
])

const normalizeSectionTitle = (title) =>
  String(title || "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()

const normalizeRuleLine = (line) => {
  const text = String(line || "").trim()
  if (!text || text.startsWith("<!--")) return ""
  return text
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim()
}

const parsePromptRulesMarkdown = (text) => {
  const parsed = {}
  let current = null

  for (const line of String(text || "").split(/\r?\n/)) {
    const heading = line.match(/^#{2,6}\s+(.+?)\s*#*\s*$/)
    if (heading) {
      current = SECTION_ALIASES.get(normalizeSectionTitle(heading[1])) || null
      continue
    }

    if (!current) continue
    const rule = normalizeRuleLine(line)
    if (!rule) continue
    if (!parsed[current]) parsed[current] = []
    parsed[current].push(rule)
  }

  return parsed
}

const unique = (items) => {
  const seen = new Set()
  return items.filter((item) => {
    if (!item || seen.has(item)) return false
    seen.add(item)
    return true
  })
}

const promptRulePathCandidates = () => {
  const configured = process.env.SDD_DRIFT_RULES_FILE
  const moduleDir = path.resolve(__dirname)
  const sourcePluginRoot =
    path.basename(moduleDir) === "core" && path.basename(path.dirname(moduleDir)) === "src"
      ? path.resolve(moduleDir, "..", "..")
      : ""

  return unique([
    configured ? path.resolve(configured) : "",
    path.join(moduleDir, PROMPT_RULES_FILE),
    sourcePluginRoot ? path.join(sourcePluginRoot, PROMPT_RULES_FILE) : "",
  ])
}

const resolvePromptRulesPath = () => promptRulePathCandidates().find((candidate) => {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
})

const getPromptRules = () => {
  const defaults = clonePromptRules()
  const rulesPath = resolvePromptRulesPath()
  if (!rulesPath) return defaults

  let parsed
  try {
    parsed = parsePromptRulesMarkdown(fs.readFileSync(rulesPath, "utf8"))
  } catch {
    return defaults
  }

  return {
    DOCUMENT_SYNC_RULES: parsed.DOCUMENT_SYNC_RULES?.length
      ? parsed.DOCUMENT_SYNC_RULES
      : defaults.DOCUMENT_SYNC_RULES,
    ACTIVE_SDD_ALIGNMENT_RULES: parsed.ACTIVE_SDD_ALIGNMENT_RULES?.length
      ? parsed.ACTIVE_SDD_ALIGNMENT_RULES
      : defaults.ACTIVE_SDD_ALIGNMENT_RULES,
    ATTRIBUTION_REVIEW_RULES: parsed.ATTRIBUTION_REVIEW_RULES?.length
      ? parsed.ATTRIBUTION_REVIEW_RULES
      : defaults.ATTRIBUTION_REVIEW_RULES,
    SUBAGENT_REVIEW_RULE: parsed.SUBAGENT_REVIEW_RULE?.length
      ? parsed.SUBAGENT_REVIEW_RULE.join(" ")
      : defaults.SUBAGENT_REVIEW_RULE,
    RESUME_ORIGINAL_TASK_RULES: parsed.RESUME_ORIGINAL_TASK_RULES?.length
      ? parsed.RESUME_ORIGINAL_TASK_RULES
      : defaults.RESUME_ORIGINAL_TASK_RULES,
  }
}

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
  PROMPT_RULES_FILE,
  RESUME_ORIGINAL_TASK_RULES,
  REVIEW_FILES,
  STATE_DIR,
  SUBAGENT_REVIEW_RULE,
  TASKS_FILE,
  getPromptRules,
  formatAttributionReviewRules,
  findSdd,
  getChangeDoc,
  hasSddWorkspace,
  isArchiveStatusText,
  isArchivedChangeDir,
  isArchivedChangeDirName,
  parsePromptRulesMarkdown,
  resolvePromptRulesPath,
}
