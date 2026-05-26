const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const rules = require(path.join(
  repoRoot,
  "plugins",
  "sdd-drift-check",
  "src",
  "core",
  "sdd-rules.js"
))

assert.strictEqual(rules.PROPOSAL_FILE, "proposal.md")
assert.strictEqual(rules.PROMPT_RULES_FILE, "sdd-drift-check-rules.md")
assert.strictEqual(rules.DESIGN_FILE, "design.md")
assert.strictEqual(rules.TASKS_FILE, "tasks.md")
assert.deepStrictEqual(rules.PEER_FILES, ["design.md", "tasks.md"])
assert.deepStrictEqual(rules.REVIEW_FILES, ["design.md", "tasks.md"])
assert.deepStrictEqual(rules.CHANGE_DOC_REQUIREMENTS["proposal.md"], ["design.md"])
assert.deepStrictEqual(rules.CHANGE_DOC_REQUIREMENTS["design.md"], ["tasks.md"])
assert.deepStrictEqual(rules.CHANGE_DOC_REQUIREMENTS["tasks.md"], ["design.md"])
assert.ok(rules.ARCHIVED_CHANGE_DIR_NAMES.has("archive"))
assert.ok(rules.ARCHIVED_CHANGE_DIR_NAMES.has("已归档"))
assert.ok(rules.DOCUMENT_SYNC_RULES.some((rule) => rule.includes("保留它已有的 Markdown 模板")))
assert.ok(rules.DOCUMENT_SYNC_RULES.includes("不要新增章节。"))
assert.ok(rules.DOCUMENT_SYNC_RULES.includes("不要重写文档模板。"))
assert.ok(
  rules.DOCUMENT_SYNC_RULES.includes("找到最应该变更的已有章节，只修改该位置。")
)
assert.ok(rules.ACTIVE_SDD_ALIGNMENT_RULES.some((rule) => rule.includes("实时计划记录")))
assert.ok(rules.ATTRIBUTION_REVIEW_RULES.some((rule) => rule.includes("纯机械改动")))
assert.match(rules.SUBAGENT_REVIEW_RULE, /只读评审 subagent/)
assert.ok(
  rules.RESUME_ORIGINAL_TASK_RULES.includes(
    "SDD 评审是当前任务中的检查点，不是最终任务本身。"
  )
)
assert.ok(
  rules.RESUME_ORIGINAL_TASK_RULES.includes(
    "SDD 评审或同步完成后，回到原始用户任务。"
  )
)

const formatted = rules.formatAttributionReviewRules()
assert.match(formatted[0], /归属评审规则/)
assert.match(formatted[1], /^1\. 纯机械改动/)
const parsedPromptRules = rules.parsePromptRulesMarkdown([
  "## SDD EDIT RULES",
  "- Custom edit",
  "## Active SDD Alignment Rules",
  "1. Custom alignment",
  "## Subagent Review Rule",
  "Custom subagent",
].join("\n"))
assert.deepStrictEqual(parsedPromptRules.DOCUMENT_SYNC_RULES, ["Custom edit"])
assert.deepStrictEqual(parsedPromptRules.ACTIVE_SDD_ALIGNMENT_RULES, ["Custom alignment"])
assert.deepStrictEqual(parsedPromptRules.SUBAGENT_REVIEW_RULE, ["Custom subagent"])
const parsedChinesePromptRules = rules.parsePromptRulesMarkdown([
  "## SDD 编辑规则",
  "- 中文编辑规则",
  "## 活跃 SDD 对齐规则",
  "- 中文对齐规则",
  "## 归属评审规则",
  "- 中文归属规则",
  "## 子代理评审规则",
  "- 中文子代理规则",
  "## 退出标准",
  "- 中文退出标准",
].join("\n"))
assert.deepStrictEqual(parsedChinesePromptRules.DOCUMENT_SYNC_RULES, ["中文编辑规则"])
assert.deepStrictEqual(parsedChinesePromptRules.ACTIVE_SDD_ALIGNMENT_RULES, ["中文对齐规则"])
assert.deepStrictEqual(parsedChinesePromptRules.ATTRIBUTION_REVIEW_RULES, ["中文归属规则"])
assert.deepStrictEqual(parsedChinesePromptRules.SUBAGENT_REVIEW_RULE, ["中文子代理规则"])
assert.deepStrictEqual(parsedChinesePromptRules.RESUME_ORIGINAL_TASK_RULES, ["中文退出标准"])

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-rules-"))
const sddRoot = path.join(tmp, "sdd")
const changeDir = path.join(sddRoot, "changes", "feat-a")
fs.mkdirSync(changeDir, { recursive: true })
const designPath = path.join(changeDir, "design.md")
fs.writeFileSync(designPath, "# Design\n")

assert.strictEqual(rules.findSdd(designPath), path.normalize(sddRoot))
assert.deepStrictEqual(
  {
    id: rules.getChangeDoc(designPath).id,
    file: rules.getChangeDoc(designPath).file,
    dir: rules.getChangeDoc(designPath).dir,
  },
  { id: "feat-a", file: "design.md", dir: changeDir }
)
assert.ok(!rules.isArchivedChangeDir(changeDir))
assert.ok(rules.isArchivedChangeDir(path.join(sddRoot, "changes", "archive")))
fs.writeFileSync(path.join(changeDir, ".archived"), "")
assert.ok(rules.isArchivedChangeDir(changeDir))

const statusDir = path.join(sddRoot, "changes", "feat-b")
fs.mkdirSync(statusDir, { recursive: true })
fs.writeFileSync(path.join(statusDir, "status.md"), "status: archived\n")
assert.ok(rules.isArchivedChangeDir(statusDir))

console.log("sdd-drift core SDD rules tests passed")
