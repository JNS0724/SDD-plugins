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

const makeClient = () => ({
  app: {
    log: async () => {},
  },
})

const makeRunner = (handler) => async (hookScript, hookInput) => {
  assert.ok(hookScript.endsWith("sdd-drift-check-hook.js"))
  return handler(hookInput)
}

const run = async () => {
  {
    const cwd = path.join(tmpRoot, "native-peer")
    const dir = path.join(cwd, "sdd", "changes", "alpha")
    write(path.join(dir, "design.md"), "# Design\n")
    write(path.join(dir, "tasks.md"), "# Tasks\n")

    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunCommandHook: makeRunner(async (hookInput) => {
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
    const cwd = path.join(tmpRoot, "native-no-sdd")
    write(path.join(cwd, "notes.md"), "# Notes\n")

    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunCommandHook: makeRunner(async () => {
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
    const cwd = path.join(tmpRoot, "native-idle")
    write(path.join(cwd, "sdd", "changes", "beta", "design.md"), "# Design\n")
    write(path.join(cwd, "sdd", "changes", "beta", "tasks.md"), "# Tasks\n")

    const hooks = await native.SddDriftCheckOpenCode({
      directory: cwd,
      worktree: cwd,
      client: makeClient(),
      __sddDriftRunCommandHook: makeRunner(async (hookInput) => {
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
