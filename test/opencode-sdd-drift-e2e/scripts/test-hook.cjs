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
    const cwd = path.join(tmpRoot, "missing-peer")
    const design = path.join(cwd, "sdd", "changes", "alpha", "design.md")
    write(design, "# Design\n")

    const state = hook.emptyState()
    edit(state, design)

    const gaps = hook.collectPeerGaps(cwd, state)
    assert.strictEqual(gaps.length, 1)
    assert.deepStrictEqual(gaps[0].missing, ["tasks.md"])
    const enforcement = hook.buildToolEnforcement(gaps)
    assert.match(enforcement, /sdd\/changes\/alpha\/tasks\.md/)
    assert.match(enforcement, /preserve its existing Markdown template/)
    assert.match(enforcement, /Keep every existing heading line exactly as-is/)
    assert.match(enforcement, /Do not replace the whole document/)
    assert.match(enforcement, /Do not add a new section/)
    assert.match(enforcement, /most appropriate existing heading, paragraph, list item, or task item/)
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
    assert.deepStrictEqual(gaps[0].missing, ["design.md"])
    assert.deepStrictEqual(gaps[0].stale, ["tasks.md"])
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
    assert.strictEqual(gaps.length, 1)
    assert.deepStrictEqual(gaps[0].missing, ["tasks.md"])
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
    assert.deepStrictEqual(hook.collectPeerGaps(cwd, state)[0].missing, [
      "design.md",
      "tasks.md",
    ])
    edit(state, design)
    assert.deepStrictEqual(hook.collectPeerGaps(cwd, state)[0].missing, ["tasks.md"])
    edit(state, tasks)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
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
    assert.match(enforcement, /update only the SDD document\(s\) that actually need changes/)
    assert.match(enforcement, /leave design\.md and\/or tasks\.md unchanged/)
    assert.match(enforcement, /read-only review subagent/)
    assert.match(enforcement, /preserve its existing Markdown template/)
    assert.match(enforcement, /Keep every existing heading line exactly as-is/)
    assert.match(enforcement, /Do not replace the whole document/)
    assert.match(enforcement, /Do not add a new section/)
    assert.match(enforcement, /most appropriate existing heading, paragraph, list item, or task item/)

    edit(state, readOnlyDesign)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 1)
    assert.deepStrictEqual(hook.collectPeerGaps(cwd, state)[0].missing, ["tasks.md"])
    edit(state, tasks)
    assert.strictEqual(hook.collectReportLines(cwd, state).length, 0)
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
    let pending = hook.buildPendingEnforcement(cwd, state)
    assert.strictEqual(hook.markStopCodeReviewConfirmation(state, pending), false)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 1)
    pending = hook.buildPendingEnforcement(cwd, state)
    assert.strictEqual(hook.markStopCodeReviewConfirmation(state, pending), true)
    assert.strictEqual(hook.collectCodeGaps(cwd, state).length, 0)
    assert.strictEqual(hook.collectPeerGaps(cwd, state).length, 0)
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
    hook.recordFile(state, design, false)
    edit(state, tasks)
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
    assert.strictEqual(hook.shouldEmitCodeDriftNotice(state, codeGaps), true)
    assert.match(hook.buildCodeEnforcement(cwd, codeGaps, { compact: true }), /SDD drift reminder/)

    hook.recordFile(state, design, false)
    hook.recordFile(state, tasks, false)
    codeGaps = hook.collectCodeGaps(cwd, state)
    assert.strictEqual(codeGaps.length, 1)
    assert.strictEqual(hook.markStopCodeReviewConfirmation(state, hook.buildPendingEnforcement(cwd, state)), false)
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
    write(design, "# Design\n")
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
    const transcript = path.join(cwd, ".home", ".claude", "transcripts", "session.jsonl")
    write(design, "# Design\n")
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

  console.log("sdd-drift hook unit tests passed")
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
