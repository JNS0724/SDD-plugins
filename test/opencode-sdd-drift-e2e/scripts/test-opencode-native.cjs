const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")

const native = require("../../../plugins/sdd-drift-check/sdd-drift-check-opencode.js")

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-drift-native-"))

const write = (fp, content = "") => {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}

const makeClient = () => {
  const prompts = []
  return {
    prompts,
    app: {
      log: async () => {},
    },
    session: {
      prompt: async (input) => {
        prompts.push(input)
      },
    },
  }
}

const makeRunner = (handler) => async (hookInput) => handler(hookInput)

const run = async () => {
  {
    const cwd = path.join(tmpRoot, "native-before-cache")
    const dir = path.join(cwd, "sdd", "changes", "alpha")
    write(path.join(dir, "design.md"), "# Design\n")
    write(path.join(dir, "tasks.md"), "# Tasks\n")

    const calls = []
    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunHookInput: makeRunner(async (hookInput) => {
        calls.push(hookInput)
        assert.strictEqual(hookInput.hook_event_name, "PostToolUse")
        assert.strictEqual(hookInput.tool_name, "edit")
        assert.strictEqual(hookInput.tool_input.file_path, "sdd/changes/alpha/design.md")
        return {
          status: 0,
          stdout: "SDD drift reminder from cached args",
          stderr: "",
        }
      }),
    })
    const output = {
      title: "edited",
      output: "updated design.md",
      metadata: {},
    }

    await hooks["tool.execute.before"](
      {
        tool: "edit",
        sessionID: "session-native-cache",
        callID: "call-cache",
      },
      {
        args: {
          filePath: "sdd/changes/alpha/design.md",
        },
      }
    )
    await hooks["tool.execute.after"](
      {
        tool: "edit",
        sessionID: "session-native-cache",
        callID: "call-cache",
      },
      output
    )

    assert.strictEqual(calls.length, 1)
    assert.match(output.output, /cached args/)
    assert.strictEqual(output.metadata.sddDriftCheck.injected, true)
  }

  {
    const cwd = path.join(tmpRoot, "native-peer")
    const dir = path.join(cwd, "sdd", "changes", "alpha")
    write(path.join(dir, "design.md"), "# Design\n")
    write(path.join(dir, "tasks.md"), "# Tasks\n")

    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunHookInput: makeRunner(async (hookInput) => {
        assert.strictEqual(hookInput.hook_source, "opencode-plugin")
        assert.strictEqual(hookInput.hook_event_name, "PostToolUse")
        assert.strictEqual(hookInput.session_id, "session-native-peer")
        assert.strictEqual(hookInput.tool_use_id, "call-1")
        assert.strictEqual(hookInput.tool_name, "edit")
        assert.strictEqual(hookInput.tool_input.file_path, "sdd/changes/alpha/design.md")
        assert.strictEqual(hookInput.cwd, cwd)
        return {
          status: 0,
          stdout: "SDD drift reminder: update sdd/changes/alpha/tasks.md",
          stderr: "",
        }
      }),
    })
    const output = {
      title: "edited",
      output: "updated design.md",
      metadata: {},
    }
    await hooks["tool.execute.after"](
      {
        tool: "edit",
        sessionID: "session-native-peer",
        callID: "call-1",
        args: {
          filePath: "sdd/changes/alpha/design.md",
        },
      },
      output
    )

    assert.match(output.output, /updated design\.md/)
    assert.match(output.output, /tasks\.md/)
    assert.strictEqual(output.metadata.sddDriftCheck.injected, true)
  }

  {
    const cwd = path.join(tmpRoot, "native-integrated")
    const dir = path.join(cwd, "sdd", "changes", "alpha")
    write(path.join(dir, "design.md"), "# Design\n")
    write(path.join(dir, "tasks.md"), "# Tasks\n")

    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
    })
    const output = {
      title: "edited",
      output: "updated design.md",
      metadata: {},
    }
    await hooks["tool.execute.after"](
      {
        tool: "edit",
        sessionID: "session-native-integrated",
        callID: "call-integrated",
        args: {
          filePath: "sdd/changes/alpha/design.md",
        },
      },
      output
    )

    assert.match(output.output, /updated design\.md/)
    assert.match(output.output, /tasks\.md/)
    assert.strictEqual(output.metadata.sddDriftCheck.injected, true)
  }

  {
    const cwd = path.join(tmpRoot, "native-subagent-checkpoint")
    write(path.join(cwd, "sdd", "changes", "alpha", "design.md"), "# Design\n")
    write(path.join(cwd, "sdd", "changes", "alpha", "tasks.md"), "# Tasks\n")

    const calls = []
    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunHookInput: makeRunner(async (hookInput) => {
        calls.push(hookInput)
        assert.strictEqual(hookInput.hook_source, "opencode-plugin")
        assert.strictEqual(hookInput.hook_event_name, "PostToolUse")
        assert.strictEqual(hookInput.session_id, "session-native-subagent")
        assert.strictEqual(hookInput.tool_name, "background_output")
        assert.deepStrictEqual(hookInput.tool_input, { task_id: "task-1" })
        assert.strictEqual(hookInput.tool_output.output, "subagent says docs need review")
        return {
          status: 0,
          stdout: "SDD drift reminder: review design.md and tasks.md after subagent analysis",
          stderr: "",
        }
      }),
    })
    const output = {
      title: "background output",
      output: "subagent says docs need review",
      metadata: {},
    }
    await hooks["tool.execute.after"](
      {
        tool: "background_output",
        sessionID: "session-native-subagent",
        callID: "call-subagent",
        args: {
          task_id: "task-1",
        },
      },
      output
    )

    assert.strictEqual(calls.length, 1)
    assert.match(output.output, /subagent says docs need review/)
    assert.match(output.output, /SDD drift reminder/)
    assert.strictEqual(output.metadata.sddDriftCheck.injected, true)
  }

  {
    const cwd = path.join(tmpRoot, "native-question-before")
    write(path.join(cwd, "sdd", "changes", "alpha", "design.md"), "# Design\n")
    write(path.join(cwd, "sdd", "changes", "alpha", "tasks.md"), "# Tasks\n")

    const calls = []
    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunHookInput: makeRunner(async (hookInput) => {
        calls.push(hookInput)
        assert.strictEqual(hookInput.hook_event_name, "PreToolUse")
        assert.strictEqual(hookInput.session_id, "session-native-question-before")
        assert.strictEqual(hookInput.tool_name, "question")
        assert.deepStrictEqual(hookInput.tool_input, { prompt: "Commit now?" })
        return {
          status: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason:
                "SDD drift question checkpoint: review design.md and tasks.md before asking.",
            },
          }),
          stderr: "",
        }
      }),
    })

    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          {
            tool: "question",
            sessionID: "session-native-question-before",
            callID: "call-question-before",
          },
          {
            args: {
              prompt: "Commit now?",
            },
          }
        ),
      /SDD drift question checkpoint/
    )
    assert.strictEqual(calls.length, 1)
  }

  {
    const cwd = path.join(tmpRoot, "native-question-checkpoint")
    write(path.join(cwd, "sdd", "changes", "alpha", "design.md"), "# Design\n")
    write(path.join(cwd, "sdd", "changes", "alpha", "tasks.md"), "# Tasks\n")

    assert.strictEqual(native._private.isSupportedToolEvent("question", {}), true)
    assert.strictEqual(native._private.isSupportedToolEvent("askuserquestion", {}), true)

    const calls = []
    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunHookInput: makeRunner(async (hookInput) => {
        calls.push(hookInput)
        assert.strictEqual(hookInput.hook_source, "opencode-plugin")
        assert.strictEqual(hookInput.hook_event_name, "PostToolUse")
        assert.strictEqual(hookInput.session_id, "session-native-question")
        assert.strictEqual(hookInput.tool_name, "question")
        assert.deepStrictEqual(hookInput.tool_input, { prompt: "Commit now?" })
        return {
          status: 0,
          stdout: "SDD drift question checkpoint: review design.md and tasks.md before asking.",
          stderr: "",
        }
      }),
    })
    const output = {
      title: "question",
      output: "Commit now?",
      metadata: {},
    }
    await hooks["tool.execute.after"](
      {
        tool: "question",
        sessionID: "session-native-question",
        callID: "call-question",
        args: {
          prompt: "Commit now?",
        },
      },
      output
    )

    assert.strictEqual(calls.length, 1)
    assert.match(output.output, /Commit now/)
    assert.match(output.output, /SDD drift question checkpoint/)
    assert.strictEqual(output.metadata.sddDriftCheck.injected, true)
  }

  {
    const cwd = path.join(tmpRoot, "native-chat-message")
    const calls = []
    write(path.join(cwd, "sdd", "changes", "ticket", "design.md"), "# Design\n")

    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunHookInput: makeRunner(async (hookInput) => {
        calls.push(hookInput)
        return {
          status: 0,
          stdout: "",
          stderr: "",
        }
      }),
    })

    await hooks["chat.message"](
      {
        sessionID: "session-native-chat",
        messageID: "message-1",
        agent: "build",
      },
      {
        message: {
          role: "user",
          content: "Please fix this issue ticket by changing code only.",
        },
        parts: [
          {
            type: "text",
            text: "Please fix this issue ticket by changing code only.",
          },
        ],
      }
    )

    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].hook_source, "opencode-plugin")
    assert.strictEqual(calls[0].hook_event_name, "ChatMessage")
    assert.strictEqual(calls[0].session_id, "session-native-chat")
    assert.strictEqual(calls[0].message_id, "message-1")
    assert.match(calls[0].parts[0].text, /issue ticket/)
    assert.match(calls[0].message_text, /issue ticket/)
  }

  {
    const cwd = path.join(tmpRoot, "native-no-sdd")
    write(path.join(cwd, "notes.md"), "# Notes\n")

    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunHookInput: makeRunner(async () => {
        return {
          status: 0,
          stdout: "",
          stderr: "",
        }
      }),
    })
    const output = {
      title: "edited",
      output: "updated notes",
      metadata: {},
    }
    await hooks["tool.execute.after"](
      {
        tool: "edit",
        sessionID: "session-native-no-sdd",
        callID: "call-1",
        args: {
          filePath: "notes.md",
        },
      },
      output
    )

    assert.strictEqual(output.output, "updated notes")
    assert.strictEqual(output.metadata.sddDriftCheck, undefined)
  }

  {
    const cwd = path.join(tmpRoot, "native-status-idle")
    write(path.join(cwd, "sdd", "changes", "beta", "design.md"), "# Design\n")
    write(path.join(cwd, "sdd", "changes", "beta", "tasks.md"), "# Tasks\n")

    const client = makeClient()
    let stopCalls = 0
    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client,
      __sddDriftRunHookInput: makeRunner(async (hookInput) => {
        stopCalls += 1
        assert.strictEqual(hookInput.hook_source, "opencode-plugin")
        assert.strictEqual(hookInput.hook_event_name, "Stop")
        assert.strictEqual(hookInput.session_id, "session-native-status")
        return {
          status: 0,
          stdout: JSON.stringify({
            decision: "block",
            inject_prompt: "Continue SDD review before final answer.",
          }),
          stderr: "",
        }
      }),
    })
    await hooks.event({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-native-status",
          status: {
            type: "idle",
          },
        },
      },
    })
    await hooks.event({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "session-native-status",
        },
      },
    })

    assert.strictEqual(stopCalls, 1)
    assert.strictEqual(client.prompts.length, 1)
    assert.strictEqual(client.prompts[0].path.id, "session-native-status")
    assert.strictEqual(client.prompts[0].query.directory, cwd)
    assert.match(client.prompts[0].body.parts[0].text, /Continue SDD review/)
  }

  {
    const cwd = path.join(tmpRoot, "native-idle")
    write(path.join(cwd, "sdd", "changes", "beta", "design.md"), "# Design\n")
    write(path.join(cwd, "sdd", "changes", "beta", "tasks.md"), "# Tasks\n")

    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunHookInput: makeRunner(async (hookInput) => {
        assert.strictEqual(hookInput.hook_source, "opencode-plugin")
        assert.strictEqual(hookInput.hook_event_name, "Stop")
        assert.strictEqual(hookInput.session_id, "session-native-idle")
        assert.strictEqual(hookInput.cwd, cwd)
        return {
          status: 0,
          stdout: "",
          stderr: "",
        }
      }),
    })
    await hooks.event({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "session-native-idle",
        },
      },
    })
  }

  console.log("sdd-drift native OpenCode plugin tests passed")
}

run()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })
