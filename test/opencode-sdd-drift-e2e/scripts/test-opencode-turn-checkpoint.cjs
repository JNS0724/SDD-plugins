const assert = require("assert")
const { EventEmitter } = require("events")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "..", "..", "..")
const pluginPath = path.join(repoRoot, "plugins", "opencode-turn-checkpoint", "opencode-turn-checkpoint.js")
const examplePath = path.join(repoRoot, "plugins", "opencode-turn-checkpoint", "examples", "notify-console.js")
const checkpoint = require(pluginPath)

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-turn-checkpoint-test-"))

const write = (fp, content) => {
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const captureConsole = (fn) => {
  const previousLog = console.log
  const previousError = console.error
  const logs = []
  const errors = []
  console.log = (...args) => logs.push(args.join(" "))
  console.error = (...args) => errors.push(args.join(" "))
  try {
    return { result: fn(), logs, errors }
  } finally {
    console.log = previousLog
    console.error = previousError
  }
}

const withEnv = async (updates, fn) => {
  const previous = {}
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key]
    if (updates[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = updates[key]
    }
  }
  try {
    await fn()
  } finally {
    for (const key of Object.keys(updates)) {
      if (previous[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous[key]
      }
    }
  }
}

const makeRecorderCli = (target) => {
  const cli = path.join(tmpRoot, `record-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`)
  write(
    cli,
    [
      "const fs = require('fs')",
      "const payloadArgIndex = process.argv.indexOf('-Payload')",
      "const payloadFile = payloadArgIndex >= 0 ? process.argv[payloadArgIndex + 1] : null",
      "const payload = payloadFile ? JSON.parse(fs.readFileSync(payloadFile, 'utf8')) : null",
      `fs.appendFileSync(${JSON.stringify(target)}, JSON.stringify({ payloadFile, payload }) + '\\n')`,
      "",
    ].join("\n")
  )
  return cli
}

const writeConfig = ({ dir, stableIdleMs = 10, callbackTarget, enabled = true, agentOutput } = {}) => {
  const config = path.join(dir, "opencode-turn-checkpoint.json")
  const cli = callbackTarget ? makeRecorderCli(callbackTarget) : null
  write(
    config,
    JSON.stringify(
      {
        version: 1,
        stableIdleMs,
        ...(agentOutput ? { agentOutput } : {}),
        callbacks: cli
          ? [
              {
                id: "record",
                enabled,
                command: process.execPath,
                args: [cli, "-Payload", "{payloadFile}"],
                timeoutMs: 1000,
              },
            ]
          : [],
      },
      null,
      2
    )
  )
  return config
}

const readJsonl = (fp) => {
  if (!fs.existsSync(fp)) return []
  return fs
    .readFileSync(fp, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const waitForRows = async (fp, count, timeoutMs = 2000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const rows = readJsonl(fp)
    if (rows.length >= count) return rows
    await sleep(25)
  }
  return readJsonl(fp)
}

const waitForLogMessage = async (fp, message, count = 1, timeoutMs = 2000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const rows = readJsonl(fp).filter((row) => row.message === message)
    if (rows.length >= count) return rows
    await sleep(25)
  }
  return readJsonl(fp).filter((row) => row.message === message)
}

const makeCtx = (cwd) => ({
  directory: cwd,
  worktree: cwd,
  client: {
    app: {
      log: async () => {},
    },
  },
})

const run = async () => {
  assert.strictEqual(typeof checkpoint.OpenCodeTurnCheckpoint, "function")
  assert.strictEqual(typeof checkpoint._private, "function")
  assert.strictEqual(typeof checkpoint._private.normalizeConfig, "function")

  {
    delete require.cache[require.resolve(examplePath)]
    const loaded = captureConsole(() => require(examplePath))
    assert.deepStrictEqual(loaded.logs, [])
    assert.deepStrictEqual(loaded.errors, [])
    assert.strictEqual(typeof loaded.result.OpenCodeTurnCheckpointNotifyConsoleExample, "function")
    assert.strictEqual(typeof loaded.result._private, "function")
    assert.strictEqual(typeof loaded.result._private.main, "function")

    const missingPayload = captureConsole(() => loaded.result._private.main(["node", "notify-console.js"]))
    assert.strictEqual(missingPayload.result, 2)
    assert.ok(missingPayload.errors.some((line) => line.includes("Missing -Payload")))

    const payloadFile = path.join(tmpRoot, "example-payload.json")
    write(
      payloadFile,
      JSON.stringify({
        cwd: path.join(tmpRoot, "project"),
        sessionId: "s-example",
        event: "stable-idle",
        timestamp: "2026-05-27T00:00:00.000Z",
        agentOutput: { source: "message-cache", preview: "done", truncated: false },
        recentActivity: { lastTool: "edit", lastToolAt: "2026-05-27T00:00:00.000Z" },
      })
    )
    const withPayload = captureConsole(() =>
      loaded.result._private.main(["node", "notify-console.js", "-Payload", payloadFile])
    )
    assert.strictEqual(withPayload.result, 0)
    assert.ok(withPayload.logs.join("\n").includes("OpenCode turn checkpoint"))
    assert.ok(withPayload.logs.join("\n").includes("Session: s-example"))
  }

  {
    assert.strictEqual(checkpoint._private.normalizeConfig({}).stableIdleMs, 2000)
    const normalized = checkpoint._private.normalizeConfig({
      stableIdleMs: -1,
      payloadRetentionDays: -1,
      agentOutput: { mode: "invalid", maxChars: -1 },
      callbacks: [{ enabled: false, command: "node" }, { id: "ok", command: "node", args: [1] }],
    })
    assert.strictEqual(normalized.stableIdleMs, 0)
    assert.strictEqual(normalized.payloadRetentionDays, 0)
    assert.strictEqual(normalized.agentOutput.mode, "preview")
    assert.strictEqual(normalized.agentOutput.maxChars, 0)
    assert.strictEqual(normalized.callbacks.length, 1)
    assert.deepStrictEqual(normalized.callbacks[0].args, ["1"])
  }

  {
    const sessions = new Map()
    const config = checkpoint._private.normalizeConfig({
      agentOutput: { mode: "preview", maxChars: 50 },
    })
    checkpoint._private.handleMessageActivity(
      sessions,
      "s-sdk-updated",
      {
        properties: {
          info: {
            id: "m-sdk-updated",
            sessionID: "s-sdk-updated",
            role: "assistant",
          },
        },
      },
      null,
      "message.updated"
    )
    checkpoint._private.handleMessageActivity(
      sessions,
      "s-sdk-updated",
      {
        properties: {
          part: {
            id: "p-sdk-updated",
            sessionID: "s-sdk-updated",
            messageID: "m-sdk-updated",
            type: "text",
            text: "assistant text from OpenCode SDK part update",
          },
        },
      },
      null,
      "message.part.updated"
    )
    const payload = checkpoint._private.buildPayload({
      ctx: makeCtx(tmpRoot),
      sessionID: "s-sdk-updated",
      session: sessions.get("s-sdk-updated"),
      stableIdleMs: 10,
      rawType: "session.idle",
      config,
    })
    assert.strictEqual(payload.agentOutput.source, "message.part.updated")
    assert.strictEqual(payload.agentOutput.messageId, "m-sdk-updated")
    assert.strictEqual(payload.agentOutput.preview, "assistant text from OpenCode SDK part update")
  }

  {
    const sessions = new Map()
    const config = checkpoint._private.normalizeConfig({
      agentOutput: { mode: "preview", maxChars: 50 },
    })
    checkpoint._private.handleMessagePartDelta(sessions, "s-delta", {
      properties: {
        sessionID: "s-delta",
        messageID: "m-delta",
        partID: "p-delta",
        field: "text",
        delta: "assistant ",
      },
    })
    checkpoint._private.handleMessagePartDelta(sessions, "s-delta", {
      properties: {
        sessionID: "s-delta",
        messageID: "m-delta",
        partID: "p-delta",
        field: "text",
        delta: "delta text",
      },
    })
    const payload = checkpoint._private.buildPayload({
      ctx: makeCtx(tmpRoot),
      sessionID: "s-delta",
      session: sessions.get("s-delta"),
      stableIdleMs: 10,
      rawType: "session.idle",
      config,
    })
    assert.strictEqual(payload.agentOutput.source, "message.part.delta")
    assert.strictEqual(payload.agentOutput.messageId, "m-delta")
    assert.strictEqual(payload.agentOutput.preview, "assistant delta text")
  }

  {
    const dir = path.join(tmpRoot, "callback-payload")
    const oldPayload = checkpoint._private.payloadPath(dir, "old-session")
    write(oldPayload, JSON.stringify({ old: true }))
    const oldMs = Date.now() - 5 * 24 * 60 * 60 * 1000
    fs.utimesSync(oldPayload, oldMs / 1000, oldMs / 1000)
    const captured = []
    const fakeSpawn = (command, args) => {
      captured.push({ command, args })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      process.nextTick(() => child.emit("close", 0))
      return child
    }
    const sessions = new Map()
    checkpoint._private.handleMessageActivity(
      sessions,
      "s-callback",
      { sessionID: "s-callback", messageID: "m-callback" },
      { parts: [{ text: "abcdef" }] },
      "chat.message"
    )
    const config = checkpoint._private.normalizeConfig({
      stableIdleMs: 10,
      payloadRetentionDays: 3,
      agentOutput: { mode: "preview", maxChars: 3 },
      callbacks: [
        {
          id: "fake",
          command: "fake-command",
          args: ["--payload", "{payloadFile}"],
          timeoutMs: 1000,
        },
      ],
    })
    await withEnv(
      {
        OPENCODE_TURN_CHECKPOINT_LOG: path.join(dir, "checkpoint.log.jsonl"),
      },
      async () => {
        const result = await checkpoint._private.runCallbacks({
          ctx: makeCtx(dir),
          sessionID: "s-callback",
          session: sessions.get("s-callback"),
          stableIdleMs: 10,
          rawType: "session.idle",
          config,
          spawnFn: fakeSpawn,
        })
        assert.strictEqual(result.length, 1)
        assert.strictEqual(result[0].ok, true)
        assert.strictEqual(captured.length, 1)
        assert.strictEqual(captured[0].command, "fake-command")
        const payloadFile = captured[0].args[1]
        assert.ok(fs.existsSync(payloadFile))
        assert.strictEqual(fs.existsSync(oldPayload), false)
        const payload = JSON.parse(fs.readFileSync(payloadFile, "utf8"))
        assert.strictEqual(payload.agentOutput.preview, "abc")
        assert.strictEqual(payload.agentOutput.truncated, true)
        assert.strictEqual(payload.agentOutput.messageId, "m-callback")
      }
    )
  }

  {
    const dir = path.join(tmpRoot, "immediate-idle")
    const config = writeConfig({ dir, stableIdleMs: 0 })
    const log = path.join(dir, "checkpoint.log.jsonl")
    await withEnv(
      {
        OPENCODE_TURN_CHECKPOINT_CONFIG: config,
        OPENCODE_TURN_CHECKPOINT_LOG: log,
      },
      async () => {
        const hooks = await checkpoint.OpenCodeTurnCheckpoint(makeCtx(dir))
        await hooks.event({
          event: {
            type: "message.part.delta",
            properties: {
              sessionID: "s-immediate",
              messageID: "m-immediate",
              partID: "p-immediate",
              field: "text",
              delta: "immediate idle payload",
            },
          },
        })
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s-immediate" } } })
        const rows = readJsonl(log).filter((row) => row.message === "stable idle checkpoint observed with no callbacks")
        assert.strictEqual(rows.length, 1)
        assert.strictEqual(rows[0].extra.sessionID, "s-immediate")
      }
    )
  }

  {
    const dir = path.join(tmpRoot, "stable")
    const config = writeConfig({ dir, stableIdleMs: 10 })
    const log = path.join(dir, "checkpoint.log.jsonl")
    await withEnv(
      {
        OPENCODE_TURN_CHECKPOINT_CONFIG: config,
        OPENCODE_TURN_CHECKPOINT_LOG: log,
      },
      async () => {
        const hooks = await checkpoint.OpenCodeTurnCheckpoint(makeCtx(dir))
        await hooks["chat.message"](
          { sessionID: "s1", messageID: "m1" },
          { parts: [{ text: "assistant finished this turn" }] }
        )
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
        const rows = await waitForLogMessage(log, "stable idle checkpoint observed with no callbacks")
        assert.strictEqual(rows.length, 1)
        assert.strictEqual(rows[0].extra.sessionID, "s1")
      }
    )
  }

  {
    const dir = path.join(tmpRoot, "cancel")
    const log = path.join(dir, "checkpoint.log.jsonl")
    const config = writeConfig({ dir, stableIdleMs: 20 })
    await withEnv(
      {
        OPENCODE_TURN_CHECKPOINT_CONFIG: config,
        OPENCODE_TURN_CHECKPOINT_LOG: log,
      },
      async () => {
        const hooks = await checkpoint.OpenCodeTurnCheckpoint(makeCtx(dir))
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } })
        await hooks["tool.execute.before"]({ sessionID: "s2", tool: "edit" })
        await sleep(60)
        assert.strictEqual(readJsonl(log).filter((row) => row.message === "stable idle checkpoint observed with no callbacks").length, 0)

        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } })
        const rows = await waitForLogMessage(log, "stable idle checkpoint observed with no callbacks")
        assert.strictEqual(rows.length, 1)
      }
    )
  }

  {
    const dir = path.join(tmpRoot, "dedupe")
    const log = path.join(dir, "checkpoint.log.jsonl")
    const config = writeConfig({ dir, stableIdleMs: 10 })
    await withEnv(
      {
        OPENCODE_TURN_CHECKPOINT_CONFIG: config,
        OPENCODE_TURN_CHECKPOINT_LOG: log,
      },
      async () => {
        const hooks = await checkpoint.OpenCodeTurnCheckpoint(makeCtx(dir))
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s3" } } })
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s3" } } })
        assert.strictEqual((await waitForLogMessage(log, "stable idle checkpoint observed with no callbacks")).length, 1)
      }
    )
  }

  {
    const dir = path.join(tmpRoot, "truncate")
    const log = path.join(dir, "checkpoint.log.jsonl")
    const config = writeConfig({
      dir,
      stableIdleMs: 10,
      agentOutput: { mode: "preview", maxChars: 5 },
    })
    await withEnv(
      {
        OPENCODE_TURN_CHECKPOINT_CONFIG: config,
        OPENCODE_TURN_CHECKPOINT_LOG: log,
      },
      async () => {
        const hooks = await checkpoint.OpenCodeTurnCheckpoint(makeCtx(dir))
        await hooks.event({
          event: {
            type: "message.updated",
            properties: {
              sessionID: "s4",
              messageID: "m4",
              role: "assistant",
              parts: [{ text: "1234567890" }],
            },
          },
        })
        await hooks.event({ event: { type: "session.status", properties: { sessionID: "s4", status: "idle" } } })
        const rows = await waitForLogMessage(log, "stable idle checkpoint observed with no callbacks")
        assert.strictEqual(rows.length, 1)
      }
    )
  }

  {
    const dir = path.join(tmpRoot, "invalid-config")
    const config = path.join(dir, "opencode-turn-checkpoint.json")
    const log = path.join(dir, "checkpoint.log.jsonl")
    write(config, "{ invalid json")
    await withEnv(
      {
        OPENCODE_TURN_CHECKPOINT_CONFIG: config,
        OPENCODE_TURN_CHECKPOINT_LOG: log,
      },
      async () => {
        const hooks = await checkpoint.OpenCodeTurnCheckpoint(makeCtx(dir))
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s5" } } })
        await sleep(30)
        const logs = readJsonl(log)
        assert.ok(logs.some((row) => row.message === "turn checkpoint config could not be parsed"))
      }
    )
  }

  console.log("opencode turn checkpoint tests passed")
}

run()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })
