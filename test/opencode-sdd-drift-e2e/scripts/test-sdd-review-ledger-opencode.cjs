const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { pathToFileURL } = require("url")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const artifact = path.join(repoRoot, "plugins", "sdd-review-ledger", "sdd-review-ledger-opencode.js")
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-review-ledger-native-"))

const write = (fp, content = "") => {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}

const makeClient = () => {
  const logs = []
  return {
    logs,
    app: {
      log: async (entry) => logs.push(entry),
    },
  }
}

const pluginFn = (native) => {
  if (typeof native === "function") return native
  if (typeof native.default === "function") return native.default
  return native.SddReviewLedgerOpenCode
}

const installPlugin = async (cwd) => {
  const pluginDir = path.join(cwd, ".opencode", "plugins")
  fs.mkdirSync(pluginDir, { recursive: true })
  const installed = path.join(pluginDir, "sdd-review-ledger-opencode.js")
  fs.copyFileSync(artifact, installed)
  const previousExpose = process.env.SDD_REVIEW_LEDGER_EXPOSE_PRIVATE
  process.env.SDD_REVIEW_LEDGER_EXPOSE_PRIVATE = "1"
  try {
    return await import(`${pathToFileURL(installed).href}?t=${Date.now()}-${Math.random()}`)
  } finally {
    if (previousExpose === undefined) {
      delete process.env.SDD_REVIEW_LEDGER_EXPOSE_PRIVATE
    } else {
      process.env.SDD_REVIEW_LEDGER_EXPOSE_PRIVATE = previousExpose
    }
  }
}

const makeSddRepo = (name) => {
  const cwd = path.join(tmpRoot, name)
  write(path.join(cwd, "sdd", "changes", "alpha", "design.md"), "# Alpha design\n")
  write(path.join(cwd, "sdd", "changes", "alpha", "tasks.md"), "# Alpha tasks\n")
  write(path.join(cwd, "src", "app.ts"), "export const app = 1\n")
  return cwd
}

const run = async () => {
  assert.ok(fs.statSync(artifact).isFile(), `missing built artifact: ${artifact}`)

  {
    const cwd = makeSddRepo("installed-artifact")
    const native = await installPlugin(cwd)
    const createPlugin = pluginFn(native)
    assert.strictEqual(typeof createPlugin, "function")
    assert.deepStrictEqual(Object.keys(native), ["SddReviewLedgerOpenCode"])
    assert.strictEqual(typeof createPlugin._private.normalizeToolName, "function")
    assert.strictEqual(Object.prototype.propertyIsEnumerable.call(createPlugin, "_private"), false)

    const client = makeClient()
    const hooks = await createPlugin({ directory: cwd, worktree: cwd, client })

    const firstOutput = { title: "edit", output: "baseline edit", metadata: {} }
    await hooks["tool.execute.after"](
      {
        tool: "edit",
        sessionID: "ledger-session-1",
        callID: "call-baseline",
        args: { filePath: "src/app.ts" },
      },
      firstOutput
    )
    assert.strictEqual(firstOutput.output, "baseline edit", "cold start auto-baseline should not remind")

    write(path.join(cwd, "src", "app.ts"), "export const app = 2\n")
    const secondOutput = { title: "edit", output: "updated app", metadata: {} }
    await hooks["tool.execute.before"](
      {
        tool: "edit",
        sessionID: "ledger-session-1",
        callID: "call-edit",
      },
      { args: { filePath: "src/app.ts" } }
    )
    await hooks["tool.execute.after"](
      {
        tool: "edit",
        sessionID: "ledger-session-1",
        callID: "call-edit",
      },
      secondOutput
    )

    assert.match(secondOutput.output, /updated app/)
    assert.match(secondOutput.output, /\[SDD-REVIEW: NEEDS-REVIEW\]/)
    assert.match(secondOutput.output, /src\/app\.ts/)
    assert.strictEqual(secondOutput.metadata.sddReviewLedger.injected, true)
    assert.strictEqual(secondOutput.metadata.sddReviewLedger.channel, "tool.execute.after")
    assert.match(fs.readFileSync(path.join(cwd, ".sdd-review-todo.md"), "utf8"), /src\/app\.ts/)
  }

  {
    const cwd = makeSddRepo("chat-batch")
    const native = await installPlugin(cwd)
    const hooks = await pluginFn(native)({ directory: cwd, worktree: cwd, client: makeClient() })

    await hooks["tool.execute.after"](
      {
        tool: "write",
        sessionID: "ledger-session-2",
        callID: "call-baseline",
        args: { filePath: "src/app.ts" },
      },
      { title: "write", output: "baseline", metadata: {} }
    )

    write(path.join(cwd, "src", "app.ts"), "export const app = 3\n")
    const first = { title: "write", output: "updated app", metadata: {} }
    await hooks["tool.execute.after"](
      {
        tool: "write",
        sessionID: "ledger-session-2",
        callID: "call-1",
        args: { filePath: "src/app.ts" },
      },
      first
    )
    assert.match(first.output, /\[SDD-REVIEW/)

    write(path.join(cwd, "src", "other.ts"), "export const other = 1\n")
    const sameBatch = { title: "write", output: "updated other", metadata: {} }
    await hooks["tool.execute.after"](
      {
        tool: "write",
        sessionID: "ledger-session-2",
        callID: "call-2",
        args: { filePath: "src/other.ts" },
      },
      sameBatch
    )
    assert.match(sameBatch.output, /\[SDD-REVIEW/, "second code edit in same batch should remind too")

    const chat = {
      message: { role: "user", content: "继续" },
      parts: [{ type: "text", text: "继续" }],
      metadata: {},
    }
    await hooks["chat.message"]({ sessionID: "ledger-session-2", messageID: "msg-1" }, chat)
    assert.deepStrictEqual(chat.metadata, {})
    assert.deepStrictEqual(chat.parts, [{ type: "text", text: "继续" }])

    write(path.join(cwd, "src/fresh.ts"), "export const fresh = 1\n")
    const nextBatch = { title: "write", output: "updated fresh", metadata: {} }
    await hooks["tool.execute.after"](
      {
        tool: "write",
        sessionID: "ledger-session-2",
        callID: "call-3",
        args: { filePath: "src/fresh.ts" },
      },
      nextBatch
    )
    assert.match(nextBatch.output, /\[SDD-REVIEW/, "new chat turn should reopen active reminder")
  }

  {
    const cwd = path.join(tmpRoot, "no-sdd")
    write(path.join(cwd, "notes.md"), "# Notes\n")
    const native = await installPlugin(cwd)
    const hooks = await pluginFn(native)({ directory: cwd, worktree: cwd, client: makeClient() })
    const output = { title: "edit", output: "updated notes", metadata: {} }
    await hooks["tool.execute.after"](
      {
        tool: "edit",
        sessionID: "ledger-no-sdd",
        callID: "call-no-sdd",
        args: { filePath: "notes.md" },
      },
      output
    )
    assert.strictEqual(output.output, "updated notes")
    assert.strictEqual(output.metadata.sddReviewLedger, undefined)
    assert.strictEqual(fs.existsSync(path.join(cwd, ".sdd-review-todo.md")), false)
  }

  {
    const cwd = makeSddRepo("idle-refresh")
    const native = await installPlugin(cwd)
    const hooks = await pluginFn(native)({ directory: cwd, worktree: cwd, client: makeClient() })
    await hooks["tool.execute.after"](
      {
        tool: "write",
        sessionID: "ledger-session-idle",
        callID: "call-baseline",
        args: { filePath: "src/app.ts" },
      },
      { title: "write", output: "baseline", metadata: {} }
    )
    write(path.join(cwd, "src/app.ts"), "export const app = 99\n")
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ledger-session-idle", status: { type: "idle" } },
      },
    })
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "ledger-session-idle" },
      },
    })
    assert.match(fs.readFileSync(path.join(cwd, ".sdd-review-todo.md"), "utf8"), /src\/app\.ts/)
  }

  console.log("sdd-review-ledger native OpenCode plugin tests passed")
}

run()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })
