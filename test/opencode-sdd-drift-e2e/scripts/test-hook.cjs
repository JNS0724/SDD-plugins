const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const hook = require("../../../plugins/sdd-drift-check/sdd-drift-check-hook.js")

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-drift-hook-"))

const write = (fp, content = "") => {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}

const edit = (state, fp) => {
  const seq = hook.recordFile(state, fp, true)
  const doc = hook.getChangeDoc(fp)
  if (doc?.dir && doc.file) hook.updateRequirementsForEdit(state, doc.dir, doc.file, seq)
  return seq
}

try {
  {
    const cwd = path.join(tmpRoot, "existing-peer")
    const dir = path.join(cwd, "sdd", "changes", "alpha")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")

    const state = hook.emptyState()
    edit(state, design)

    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.deepStrictEqual(gaps[0].absent, [])
    assert.deepStrictEqual(gaps[0].unsynced, ["tasks.md"])
    const enforcement = hook.buildToolEnforcement(gaps)
    assert.match(enforcement, /sdd\/changes\/alpha\/tasks\.md/)
    assert.match(enforcement, /unsynced in this session \[tasks\.md\]/)
    assert.match(enforcement, /preserve its existing Markdown template/)
    assert.match(enforcement, /Keep every existing heading line exactly as-is/)
    assert.match(enforcement, /Do not replace the whole document/)
    assert.match(enforcement, /Do not add a new section/)
    assert.match(enforcement, /Do not remove unrelated existing paragraphs/)
    assert.match(enforcement, /most appropriate existing heading, paragraph, list item, or task item/)
    const compact = hook.buildToolEnforcement(gaps, { compact: true })
    assert.match(compact, /SDD drift reminder/)
    assert.doesNotMatch(compact, /This assistant turn is incomplete/)
  }

  {
    const cwd = path.join(tmpRoot, "absent-peer-stage")
    const design = path.join(cwd, "sdd", "changes", "alpha", "design.md")
    write(design, "# Design\n")

    const state = hook.emptyState()
    edit(state, design)

    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 0)
    assert.strictEqual(hook.buildPendingEnforcement(cwd, state), null)
    assert.strictEqual(hook.collectReportLines(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "stale-peer")
    const dir = path.join(cwd, "sdd", "changes", "beta")
    const proposal = path.join(dir, "proposal.md")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(proposal, "# Proposal\n")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")

    const state = hook.emptyState()
    edit(state, tasks)
    edit(state, proposal)

    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.strictEqual(gaps[0].stageOnly, false)
    assert.deepStrictEqual(gaps[0].unsynced, ["design.md"])
    assert.deepStrictEqual(gaps[0].stale, [])
    assert.deepStrictEqual(gaps[0].required, ["design.md"])
    assert.deepStrictEqual(gaps[0].sourceFiles, ["tasks.md"])
  }

  {
    const cwd = path.join(tmpRoot, "no-ping-pong")
    const dir = path.join(cwd, "sdd", "changes", "gamma")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")

    const state = hook.emptyState()
    edit(state, design)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 1)
    edit(state, tasks)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
    edit(state, tasks)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
    edit(state, design)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 1)
  }

  {
    const state = hook.emptyState()
    const first = {
      session_id: "session",
      hook_event_name: "PostToolUse",
      tool_use_id: "tool-call-1",
    }
    assert.strictEqual(hook.markToolEvent(state, hook.getToolEventKey(first)), true)
    assert.strictEqual(hook.markToolEvent(state, hook.getToolEventKey(first)), false)
    assert.strictEqual(
      hook.markToolEvent(
        state,
        hook.getToolEventKey({
          session_id: "session",
          hook_event_name: "PostToolUse",
          tool_use_id: "tool-call-2",
        })
      ),
      true
    )
  }

  {
    const target = path.join(tmpRoot, "state-lock", "session.json")
    const first = hook.acquireFileLock(target, { waitMs: 0 })
    assert.ok(first)
    const second = hook.acquireFileLock(target, { waitMs: 0 })
    assert.strictEqual(second, null)
    hook.releaseFileLock(first)
    const third = hook.acquireFileLock(target, { waitMs: 0 })
    assert.ok(third)
    hook.releaseFileLock(third)
  }

  {
    const cwd = path.join(tmpRoot, "multiedit")
    const state = hook.emptyState()
    const design = path.join(cwd, "sdd", "changes", "kappa", "design.md")
    write(design, "# Design\n")

    assert.strictEqual(
      hook.applyToolRecord(cwd, state, "MultiEdit", {
        file_path: "sdd/changes/kappa/design.md",
        edits: [{ old_string: "# Design\n", new_string: "# Design\n\nUpdated.\n" }],
      }),
      true
    )

    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "design-before-tasks")
    const dir = path.join(cwd, "sdd", "changes", "kappa-stage")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(design, "# Design\n")

    const state = hook.emptyState()
    edit(state, design)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)

    write(tasks, "# Tasks\n")
    edit(state, tasks)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)

    edit(state, tasks)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)

    edit(state, design)
    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.deepStrictEqual(gaps[0].required, ["tasks.md"])
  }

  {
    const cwd = path.join(tmpRoot, "proposal-before-design")
    const dir = path.join(cwd, "sdd", "changes", "delta-stage")
    const proposal = path.join(dir, "proposal.md")
    const design = path.join(dir, "design.md")
    write(proposal, "# Proposal\n")

    const state = hook.emptyState()
    edit(state, proposal)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
    assert.strictEqual(hook.buildPendingEnforcement(cwd, state), null)
    assert.strictEqual(hook.collectReportLines(cwd, state).length, 0)

    write(design, "# Design\n")
    edit(state, proposal)
    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.strictEqual(gaps[0].stageOnly, true)
    assert.deepStrictEqual(gaps[0].required, ["design.md"])
    assert.deepStrictEqual(gaps[0].unsynced, ["design.md"])
  }

  {
    const cwd = path.join(tmpRoot, "proposal")
    const dir = path.join(cwd, "sdd", "changes", "delta")
    const proposal = path.join(dir, "proposal.md")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(proposal, "# Proposal\n")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")

    const state = hook.emptyState()
    edit(state, proposal)
    let gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.strictEqual(gaps[0].stageOnly, true)
    assert.deepStrictEqual(gaps[0].unsynced, ["design.md"])
    assert.deepStrictEqual(gaps[0].required, ["design.md"])
    assert.strictEqual(hook.buildPendingEnforcement(cwd, state, { includeStageOnly: false }), null)
    assert.strictEqual(hook.collectReportLines(cwd, state).length, 0)
    const proposalReminder = hook.buildToolEnforcement(gaps)
    assert.match(proposalReminder, /SDD proposal stage reminder/)
    assert.doesNotMatch(proposalReminder, /This assistant turn is incomplete/)
    assert.match(proposalReminder, /create or edit tasks\.md directly from proposal\.md/)

    edit(state, design)
    gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.strictEqual(gaps[0].stageOnly, false)
    assert.deepStrictEqual(gaps[0].unsynced, ["tasks.md"])
    assert.deepStrictEqual(gaps[0].required, ["tasks.md"])
    edit(state, tasks)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "proposal-stage-code")
    const dir = path.join(cwd, "sdd", "changes", "delta-code")
    const proposal = path.join(dir, "proposal.md")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "app.ts")
    write(proposal, "# Proposal\n")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")

    const state = hook.emptyState()
    edit(state, proposal)
    hook.recordFile(state, code, true)

    assert.strictEqual(hook.collectPeerGaps(cwd, state)[0].stageOnly, true)
    const pending = hook.buildPendingEnforcement(cwd, state, { includeStageOnly: false })
    assert.strictEqual(pending.type, "code")
  }

  {
    const cwd = path.join(tmpRoot, "proposal-stage-mixed")
    const dir = path.join(cwd, "sdd", "changes", "delta-mixed")
    const proposal = path.join(dir, "proposal.md")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    write(proposal, "# Proposal\n")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")

    const state = hook.emptyState()
    edit(state, design)
    edit(state, proposal)

    const hardGaps = hook.collectPeerGaps(cwd, state, { includeStageOnly: false })
    assert.strictEqual(hardGaps.length, 1)
    assert.strictEqual(hardGaps[0].stageOnly, false)
    assert.deepStrictEqual(hardGaps[0].required, ["tasks.md"])

    const stageGaps = hook.collectPeerGaps(cwd, state, { includeHard: false })
    assert.strictEqual(stageGaps.length, 1)
    assert.strictEqual(stageGaps[0].stageOnly, true)
    assert.deepStrictEqual(stageGaps[0].required, ["design.md"])

    const pending = hook.buildPendingEnforcement(cwd, state, { includeStageOnly: false })
    assert.strictEqual(pending.type, "peer")
    assert.match(pending.message, /tasks\.md/)
    assert.doesNotMatch(pending.message, /Synchronize: .*design\.md/)
  }

  {
    const cwd = path.join(tmpRoot, "no-sdd-workspace")
    const state = hook.emptyState()
    const code = path.join(cwd, "src", "app.ts")
    write(code, "export const value = 1\n")

    hook.recordFile(state, code, true)
    assert.strictEqual(hook.hasSddWorkspace(cwd), false)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.deepStrictEqual(hook.drift(cwd, code, state), [])
    assert.strictEqual(hook.buildPendingEnforcement(cwd, state), null)
  }

  {
    const cwd = path.join(tmpRoot, "code")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "epsilon")
    const readOnlyDesign = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "app.ts")
    write(readOnlyDesign, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")
    hook.recordFile(state, readOnlyDesign, false)
    hook.recordFile(state, code, true)
    assert.strictEqual(hook.hasEditedSddChange(state), false)
    assert.match(hook.drift(cwd, code, state).join("\n"), /did not edit any sdd\/changes/)
    const codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    const enforcement = hook.buildCodeEnforcement(cwd, codeGaps)
    assert.match(enforcement, /sdd\/changes\/epsilon\/design\.md/)
    assert.match(enforcement, /sdd\/changes\/epsilon\/tasks\.md/)
    assert.match(enforcement, /deferred review checkpoint/)
    assert.match(enforcement, /Continue implementation work if more code changes are still required/)
    assert.match(enforcement, /update active SDD document\(s\) whenever they no longer match/)
    assert.match(enforcement, /Optimization and refactor work can still require SDD updates/)
    assert.match(enforcement, /Active SDD documents are live planning records/)
    assert.match(enforcement, /Do not treat an optimization or refactor as documentation-free/)
    assert.match(enforcement, /Do not satisfy SDD alignment by only adding a marker/)
    assert.match(enforcement, /document states the actual implemented behavior, API, error handling, performance strategy, or task status/)
    assert.match(enforcement, /no old wording still contradicts the code/)
    assert.match(enforcement, /changes behavior, API or contracts, algorithms, state or data flow/)
    assert.match(enforcement, /Update tasks\.md when the code completes, changes, cancels, splits, or invalidates/)
    assert.match(enforcement, /The no-document-change path is only valid for purely mechanical edits/)
    assert.match(enforcement, /explicitly state which active design\.md\/tasks\.md files you reviewed/)
    assert.match(enforcement, /read-only review subagent/)
    assert.match(enforcement, /preserve its existing Markdown template/)
    assert.match(enforcement, /Keep every existing heading line exactly as-is/)
    assert.match(enforcement, /Do not replace the whole document/)
    assert.match(enforcement, /Do not add a new section/)
    assert.match(enforcement, /most appropriate existing heading, paragraph, list item, or task item/)

    edit(state, readOnlyDesign)
    const afterDesignEditCodeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(afterDesignEditCodeGaps.length, 1)
    assert.deepStrictEqual(afterDesignEditCodeGaps[0].pendingReviewTargets.map((file) => path.basename(file)), [
      "tasks.md",
    ])
    assert.deepStrictEqual(hook.collectPeerGaps(cwd, state)[0].unsynced, ["tasks.md"])
    edit(state, tasks)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.strictEqual(hook.collectReportLines(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "multi-active-change-review")
    const state = hook.emptyState()
    const activeA = path.join(cwd, "sdd", "changes", "active-a")
    const activeB = path.join(cwd, "sdd", "changes", "active-b")
    const archived = path.join(cwd, "sdd", "changes", "done-c")
    const code = path.join(cwd, "src", "app.ts")

    for (const dir of [activeA, activeB, archived]) {
      write(path.join(dir, "design.md"), "# Design\n")
      write(path.join(dir, "tasks.md"), "# Tasks\n")
    }
    write(path.join(archived, ".archived"), "")
    write(code, "export const value = 1\n")

    hook.recordFile(state, code, true)
    const reviewTargets = hook.collectReviewTargets(cwd, state).map((file) => hook.normalizeKey(file))
    assert.strictEqual(reviewTargets.length, 4)
    assert.ok(reviewTargets.some((file) => file.includes("active-a/design.md")))
    assert.ok(reviewTargets.some((file) => file.includes("active-a/tasks.md")))
    assert.ok(reviewTargets.some((file) => file.includes("active-b/design.md")))
    assert.ok(reviewTargets.some((file) => file.includes("active-b/tasks.md")))
    assert.strictEqual(reviewTargets.some((file) => file.includes("done-c")), false)

    let codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.strictEqual(codeGaps[0].pendingReviewTargets.length, 4)

    hook.recordFile(state, path.join(activeA, "design.md"), false)
    hook.recordFile(state, path.join(activeA, "tasks.md"), false)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.deepStrictEqual(
      codeGaps[0].pendingReviewTargets.map((file) => hook.normalizeKey(file).split("changes/")[1]).sort(),
      ["active-b/design.md", "active-b/tasks.md"]
    )

    hook.recordFile(state, path.join(activeB, "design.md"), false)
    hook.recordFile(state, path.join(activeB, "tasks.md"), false)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.strictEqual(codeGaps[0].reviewReady, true)
    assert.strictEqual(hook.markCodeReviewNoEditConfirmation(state, codeGaps), true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.match(hook.collectReportLines(cwd, state).join("\n"), /User confirmation recommended/)

    edit(state, path.join(activeA, "design.md"))
    edit(state, path.join(activeA, "tasks.md"))
    assert.strictEqual(hook.collectReportLines(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "subagent-checkpoint")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "subagent")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "feature.ts")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const feature = true\n")

    hook.recordFile(state, code, true)
    const codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    hook.markCodeDriftNoticeEmitted(cwd, state, codeGaps)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), false)
    assert.strictEqual(hook.isSubagentCheckpointTool("background_output"), true)
    assert.strictEqual(
      hook.isSubagentCheckpointTool("call_omo_agent", { run_in_background: true }),
      false
    )

    const pending = hook.buildSubagentCheckpointEnforcement(cwd, state)
    assert.strictEqual(pending.type, "code")
    assert.match(pending.message, /pending SDD review/)
    assert.match(pending.message, /read-only review subagent/)
    assert.strictEqual(hook.shouldEmitSubagentCheckpointNotice(state, pending), true)
    hook.markSubagentCheckpointNoticeEmitted(state, pending, "background_output")
    assert.strictEqual(hook.shouldEmitSubagentCheckpointNotice(state, pending), false)

    hook.recordFile(state, design, false)
    hook.recordFile(state, tasks, false)
    assert.strictEqual(hook.buildSubagentCheckpointEnforcement(cwd, state), null)
    hook.clearSubagentCheckpointNoticeIfResolved(state, null)
    assert.strictEqual(state.subagentCheckpointNotice, null)
  }

  {
    const cwd = path.join(tmpRoot, "frontend-html-code")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "epsilon-html")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const html = path.join(cwd, "index.html")
    const css = path.join(cwd, "src", "styles.css")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(html, "<!doctype html><script>console.log('snake')</script>\n")
    write(css, "body { margin: 0; }\n")

    hook.recordFile(state, html, true)
    let codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.match(hook.buildCodeEnforcement(cwd, codeGaps), /index\.html/)

    hook.recordFile(state, design, false)
    hook.recordFile(state, tasks, false)
    assert.strictEqual(hook.markStopCodeReviewConfirmation(state, hook.buildPendingEnforcement(cwd, state)), true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)

    hook.recordFile(state, css, true)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.match(hook.buildCodeEnforcement(cwd, codeGaps), /src\/styles\.css/)
  }

  {
    const cwd = path.join(tmpRoot, "dts-context")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "rho")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "app.ts")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")

    assert.strictEqual(
      hook.updateDtsContextFromInput(state, { message: "这是 DTS 问题单修改，只修代码" }, null),
      true
    )
    assert.strictEqual(hook.isDtsContextActive(state), true)
    hook.recordFile(state, code, true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.deepStrictEqual(hook.drift(cwd, code, state), [])
    assert.strictEqual(hook.buildPendingEnforcement(cwd, state), null)
  }

  {
    const cwd = path.join(tmpRoot, "issue-ticket-context")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "rho-ticket")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "ticket-fix.ts")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")

    assert.strictEqual(
      hook.updateDtsContextFromInput(state, { message: "Please fix this issue ticket by changing code only." }, null),
      true
    )
    assert.strictEqual(hook.isDtsContextActive(state), true)
    hook.recordFile(state, code, true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "claude-user-prompt-submit-context")
    const sessionID = "claude-issue-ticket"
    const dir = path.join(cwd, "sdd", "changes", "rho-ticket-command")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "ticket-fix.ts")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")

    const promptState = hook.emptyState()
    assert.strictEqual(
      hook.updateDtsContextFromInput(
        promptState,
        {
          hook_event_name: "UserPromptSubmit",
          session_id: sessionID,
          cwd,
          prompt: "Please fix this issue ticket by changing code only.",
        },
        null
      ),
      true
    )
    hook.saveState(cwd, sessionID, promptState)

    const state = hook.loadState(cwd, sessionID)
    assert.strictEqual(hook.isDtsContextActive(state), true)
    hook.recordFile(state, code, true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.strictEqual(hook.buildPendingEnforcement(cwd, state), null)
  }

  {
    const cwd = path.join(tmpRoot, "code-review-only")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "eta")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "app.ts")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")

    hook.recordFile(state, code, true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 1)
    hook.recordFile(state, design, false)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 1)
    hook.recordFile(state, tasks, false)
    let gaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.strictEqual(gaps[0].needsConfirmation, true)
    assert.strictEqual(gaps[0].reviewReady, true)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, gaps), false)
    assert.strictEqual(hook.markCodeReviewNoEditConfirmation(state, gaps), true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
    const reportLines = hook.collectReportLines(cwd, state).join("\n")
    assert.match(reportLines, /reviewed SDD document\(s\) after code change/)
    assert.match(reportLines, /User confirmation recommended/)
    assert.match(reportLines, /src\/app\.ts/)
  }

  {
    const cwd = path.join(tmpRoot, "report-idempotent")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "eta-report")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "app.ts")
    const report = path.join(cwd, ".sdd-drift-report.md")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")

    hook.recordFile(state, code, true)
    hook.recordFile(state, design, false)
    hook.recordFile(state, tasks, false)
    assert.strictEqual(hook.markStopCodeReviewConfirmation(state, hook.buildPendingEnforcement(cwd, state)), true)
    hook.refreshReport(cwd, state)
    const first = fs.readFileSync(report, "utf8")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    hook.refreshReport(cwd, state)
    assert.strictEqual(fs.readFileSync(report, "utf8"), first)
  }

  {
    const cwd = path.join(tmpRoot, "transcript-hydration-idempotent")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "ticket")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "app.ts")
    const transcript = path.join(cwd, "transcript.jsonl")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")
    write(
      transcript,
      [
        {
          part: {
            type: "tool",
            id: "call-code-write",
            name: "write",
            state: { status: "completed", input: { filePath: code } },
          },
        },
        {
          part: {
            type: "tool",
            id: "call-design-read",
            name: "read",
            state: { status: "completed", input: { filePath: design } },
          },
        },
        {
          part: {
            type: "tool",
            id: "call-tasks-read",
            name: "read",
            state: { status: "completed", input: { filePath: tasks } },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n"
    )

    assert.strictEqual(hook.hydrateStateFromTranscript(cwd, state, transcript), true)
    const clockAfterFirstHydration = state.clock
    const pending = hook.buildPendingEnforcement(cwd, state)
    assert.strictEqual(pending.type, "code")
    assert.strictEqual(pending.gaps[0].needsConfirmation, true)
    assert.strictEqual(hook.hydrateStateFromTranscript(cwd, state, transcript), false)
    assert.strictEqual(state.clock, clockAfterFirstHydration)
    assert.strictEqual(hook.buildPendingEnforcement(cwd, state).signature, pending.signature)
    assert.strictEqual(hook.markStopCodeReviewConfirmation(state, pending), true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "code-tasks-only")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "lambda")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const code = path.join(cwd, "src", "app.ts")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(code, "export const value = 1\n")

    hook.recordFile(state, code, true)
    edit(state, tasks)
    const codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.deepStrictEqual(codeGaps[0].pendingReviewTargets.map((file) => path.basename(file)), ["design.md"])
    assert.deepStrictEqual(hook.collectPeerGaps(cwd, state)[0].unsynced, ["design.md"])
    edit(state, design)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
  }

  {
    const cwd = path.join(tmpRoot, "code-notice-repeats")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "zeta")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const firstCode = path.join(cwd, "src", "first.ts")
    const secondCode = path.join(cwd, "src", "second.ts")
    const thirdCode = path.join(cwd, "src", "third.ts")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(firstCode, "export const first = 1\n")
    write(secondCode, "export const second = 1\n")
    write(thirdCode, "export const third = 1\n")

    hook.recordFile(state, firstCode, true)
    let codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), true)
    hook.markCodeDriftNoticeEmitted(cwd, state, codeGaps)

    hook.recordFile(state, secondCode, true)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), false)
    assert.strictEqual(hook.isCodeDriftNoticeSuppressed(state, codeGaps), true)

    hook.recordFile(state, design, false)
    hook.recordFile(state, tasks, false)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), false)
    assert.strictEqual(codeGaps.length, 1)
    assert.strictEqual(hook.markStopCodeReviewConfirmation(state, hook.buildPendingEnforcement(cwd, state)), true)
    codeGaps = hook.collectCodeGaps(cwd, state)
    hook.clearCodeDriftNoticeIfResolved(state, codeGaps)
    assert.strictEqual(codeGaps.length, 0)
    assert.strictEqual(state.codeDriftNotice, null)

    hook.recordFile(state, thirdCode, true)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), true)
  }

  {
    const cwd = path.join(tmpRoot, "code-notice-limit")
    const state = hook.emptyState()
    const dir = path.join(cwd, "sdd", "changes", "limit")
    const design = path.join(dir, "design.md")
    const tasks = path.join(dir, "tasks.md")
    const firstCode = path.join(cwd, "src", "first.ts")
    const secondCode = path.join(cwd, "src", "second.ts")
    const thirdCode = path.join(cwd, "src", "third.ts")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(firstCode, "export const first = 1\n")
    write(secondCode, "export const second = 1\n")
    write(thirdCode, "export const third = 1\n")

    hook.recordFile(state, firstCode, true)
    let codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), true)
    hook.markCodeDriftNoticeEmitted(cwd, state, codeGaps)

    hook.recordFile(state, secondCode, true)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), false)
    assert.strictEqual(hook.isCodeDriftNoticeSuppressed(state, codeGaps), true)

    hook.recordFile(state, thirdCode, true)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), false)
    assert.strictEqual(hook.isCodeDriftNoticeSuppressed(state, codeGaps), true)
  }

  {
    const nested = path.join(tmpRoot, "repo", "services", "api", "sdd", "changes", "zeta", "design.md")
    write(nested, "# Design\n")
    assert.strictEqual(
      path.normalize(hook.findSdd(nested)),
      path.join(tmpRoot, "repo", "services", "api", "sdd")
    )
  }

  {
    assert.deepStrictEqual(hook.parseHookInput('\uFEFF{"hook_event_name":"PostToolUse"}'), {
      hook_event_name: "PostToolUse",
    })
    assert.strictEqual(hook.isOpenCodeHookInput({ hook_source: "opencode-plugin" }), true)
    assert.strictEqual(hook.isOpenCodeHookInput({ hook_event_name: "PostToolUse" }), false)
    const output = JSON.parse(hook.buildClaudeCodeOutput("PostToolUse", "sync tasks.md"))
    assert.deepStrictEqual(output, {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "sync tasks.md",
      },
    })
  }

  {
    const cwd = path.join(tmpRoot, "diagnostic-log")
    fs.mkdirSync(cwd, { recursive: true })
    hook.writeDiagnosticLog(cwd, {
      event: "unit_test",
      input: { hook_event_name: "PostToolUse", tool_name: "Write" },
    })
    const logPath = hook.diagnosticLogPath(cwd)
    const lines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/)
    const last = JSON.parse(lines[lines.length - 1])
    assert.strictEqual(last.event, "unit_test")
    assert.strictEqual(last.input.tool_name, "Write")
    assert.ok(last.ts)
    assert.ok(last.pid)
  }

  {
    const cwd = path.join(tmpRoot, "diagnostic-log-retention")
    fs.mkdirSync(cwd, { recursive: true })
    const logPath = hook.diagnosticLogPath(cwd)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })

    const now = Date.now()
    const oldLine = JSON.stringify({
      ts: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(),
      event: "old",
    })
    const keepLine = JSON.stringify({
      ts: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      event: "keep",
    })

    fs.writeFileSync(logPath, `${oldLine}\n${keepLine}\n`)
    fs.writeFileSync(`${logPath}.1`, `${oldLine}\n`)
    fs.utimesSync(logPath, new Date(now), new Date(now))
    fs.utimesSync(`${logPath}.1`, new Date(now), new Date(now))

    hook.writeDiagnosticLog(cwd, { event: "current" })

    const events = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line).event)
    assert.deepStrictEqual(events, ["keep", "current"])
    assert.strictEqual(fs.existsSync(`${logPath}.1`), false)
  }

  {
    const cwd = path.join(tmpRoot, "stop")
    const design = path.join(cwd, "sdd", "changes", "theta", "design.md")
    const tasks = path.join(cwd, "sdd", "changes", "theta", "tasks.md")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    const state = hook.emptyState()
    edit(state, design)

    const pending = hook.buildPendingEnforcement(cwd, state)
    assert.strictEqual(pending.type, "peer")
    assert.match(pending.message, /sdd\/changes\/theta\/tasks\.md/)

    const stopPrompt = hook.buildStopEnforcement(pending.message)
    assert.match(stopPrompt, /attempted to stop/)
    assert.match(stopPrompt, /Continue the current task now/)

    const openCodeStop = JSON.parse(hook.buildStopOutput({ hook_source: "opencode-plugin" }, stopPrompt))
    assert.strictEqual(openCodeStop.decision, "block")
    assert.strictEqual(openCodeStop.reason, stopPrompt)
    assert.strictEqual(openCodeStop.inject_prompt, stopPrompt)
    assert.strictEqual(openCodeStop.stop_hook_active, true)

    const claudeStop = JSON.parse(hook.buildStopOutput({ hook_event_name: "Stop" }, stopPrompt))
    assert.deepStrictEqual(claudeStop, {
      decision: "block",
      reason: stopPrompt,
    })
  }

  {
    const cwd = path.join(tmpRoot, "stop-transcript")
    const design = path.join(cwd, "sdd", "changes", "iota", "design.md")
    const tasks = path.join(cwd, "sdd", "changes", "iota", "tasks.md")
    const transcript = path.join(cwd, ".home", ".claude", "transcripts", "session.jsonl")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(
      transcript,
      [
        JSON.stringify({
          type: "tool_result",
          tool_name: "read",
          tool_input: { filePath: design },
          tool_output: { output: "# Design\n" },
        }),
        JSON.stringify({
          type: "tool_result",
          tool_name: "write",
          tool_input: {
            filePath: design,
            content: "# Design\n\n## Updated\n",
          },
          tool_output: { output: "Wrote file successfully." },
        }),
      ].join("\n")
    )

    const state = hook.emptyState()
    assert.strictEqual(
      hook.resolveTranscriptPath({
        session_id: "session",
        todo_path: path.join(cwd, ".home", ".claude", "todos", "session-agent-session.json"),
      }),
      transcript
    )
    assert.strictEqual(hook.hydrateStateFromTranscript(cwd, state, transcript), true)
    const pending = hook.buildPendingEnforcement(cwd, state)
    assert.strictEqual(pending.type, "peer")
    assert.match(pending.message, /sdd\/changes\/iota\/tasks\.md/)
  }

  {
    const cwd = path.join(tmpRoot, "claude-transcript")
    const design = path.join(cwd, "sdd", "changes", "mu", "design.md")
    const tasks = path.join(cwd, "sdd", "changes", "mu", "tasks.md")
    const transcript = path.join(cwd, ".claude", "transcripts", "session.jsonl")
    write(design, "# Design\n")
    write(tasks, "# Tasks\n")
    write(
      transcript,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "read-design",
                name: "Read",
                input: { file_path: design },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-design",
                content: "# Design\n",
              },
            ],
          },
          tool_use_result: {
            type: "text",
            filePath: design,
            content: "# Design\n",
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "write-design",
                name: "Write",
                input: {
                  file_path: design,
                  content: "# Design\n\nUpdated.\n",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "write-design",
                content: "updated",
              },
            ],
          },
          tool_use_result: {
            type: "update",
            filePath: design,
            content: "# Design\n\nUpdated.\n",
          },
        }),
      ].join("\n")
    )

    const state = hook.emptyState()
    assert.strictEqual(hook.hydrateStateFromTranscript(cwd, state, transcript), true)
    assert.strictEqual(state.clock, 2)
    const pending = hook.buildPendingEnforcement(cwd, state)
    assert.strictEqual(pending.type, "peer")
    assert.match(pending.message, /unsynced in this session \[tasks\.md\]/)
  }

  {
    const cwd = path.join(tmpRoot, "failed-transcript-tool")
    const design = path.join(cwd, "sdd", "changes", "nu", "design.md")
    const transcript = path.join(cwd, ".claude", "transcripts", "session.jsonl")
    write(design, "# Design\n")
    write(
      transcript,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "failed-write",
                name: "Write",
                input: {
                  file_path: design,
                  content: "# Design\n\nShould not count.\n",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "failed-write",
                is_error: true,
                content: "permission denied",
              },
            ],
          },
          tool_use_result: {
            type: "update",
            filePath: design,
            is_error: true,
            error: "permission denied",
          },
        }),
      ].join("\n")
    )

    const state = hook.emptyState()
    assert.strictEqual(hook.hydrateStateFromTranscript(cwd, state, transcript), false)
    assert.strictEqual(state.clock, 0)
    assert.strictEqual(hook.buildPendingEnforcement(cwd, state), null)
  }

  console.log("sdd-drift hook unit tests passed")
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
