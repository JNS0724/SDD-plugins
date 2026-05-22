const assert = require("assert")
const { spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.resolve(__dirname, "../../..")
const fixtureRoot = path.join(repoRoot, "test", "fixtures", "journeys")
const hookPath = path.join(repoRoot, "plugins", "sdd-drift-check", "sdd-drift-check-hook.js")
const hook = require(hookPath)

const toPosix = (value) => String(value || "").replace(/\\/g, "/")

const readJson = (fp) => JSON.parse(fs.readFileSync(fp, "utf8"))

const readJsonl = (fp) =>
  fs
    .readFileSync(fp, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const writeWorkspaceFiles = (cwd, files) => {
  for (const [relPath, content] of Object.entries(files || {})) {
    const fp = path.join(cwd, relPath)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, content)
  }
}

const replaceTokens = (value, tokens) => {
  if (typeof value === "string") {
    return Object.entries(tokens).reduce((text, [token, replacement]) => text.replaceAll(token, replacement), value)
  }
  if (Array.isArray(value)) return value.map((item) => replaceTokens(item, tokens))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, tokens)]))
  }
  return value
}

const rel = (cwd, fp) => toPosix(path.relative(cwd, fp))

const sorted = (items) => [...items].sort()

const assertArraySet = (actual, expected, message) => {
  assert.deepStrictEqual(sorted(actual), sorted(expected), message)
}

const assertObjectSubset = (actual, expected, label) => {
  for (const [key, expectedValue] of Object.entries(expected || {})) {
    const actualValue = actual?.[key]
    if (expectedValue && typeof expectedValue === "object" && !Array.isArray(expectedValue)) {
      assertObjectSubset(actualValue, expectedValue, `${label}.${key}`)
    } else {
      assert.deepStrictEqual(actualValue, expectedValue, label ? `${label}.${key}` : key)
    }
  }
}

const assertStdout = (actual, expected, label) => {
  if (expected.empty) assert.strictEqual(actual.trim(), "", `${label} stdout should be empty`)
  for (const text of expected.contains || []) {
    assert.ok(actual.includes(text), `${label} stdout should contain ${JSON.stringify(text)}\nActual:\n${actual}`)
  }
  for (const text of expected.notContains || []) {
    assert.ok(!actual.includes(text), `${label} stdout should not contain ${JSON.stringify(text)}\nActual:\n${actual}`)
  }
  if (expected.jsonContains) {
    assertObjectSubset(JSON.parse(actual), expected.jsonContains, `${label} stdout JSON`)
  }
}

const loadEvents = (logPath) => {
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const assertSession = (cwd, sessionID, expected, project) => {
  const state = hook.loadState(cwd, sessionID)
  if (expected.editedRel) {
    assertArraySet((state.edited || []).map((file) => rel(cwd, file)), expected.editedRel, `${sessionID} editedRel`)
  }
  if (expected.touchedRel) {
    assertArraySet((state.touched || []).map((file) => rel(cwd, file)), expected.touchedRel, `${sessionID} touchedRel`)
  }
  if (Object.prototype.hasOwnProperty.call(expected, "pendingType")) {
    const pending = hook.buildPendingEnforcement(cwd, state, { includeStageOnly: false, project })
    assert.strictEqual(pending?.type || null, expected.pendingType, `${sessionID} pendingType`)
  }
  if (Object.prototype.hasOwnProperty.call(expected, "carryOverNotice")) {
    assert.strictEqual(Boolean(state.carryOverNotice), expected.carryOverNotice, `${sessionID} carryOverNotice`)
  }
  if (Object.prototype.hasOwnProperty.call(expected, "codeReviewConfirmationsMin")) {
    assert.ok(
      Object.keys(state.codeReviewConfirmations || {}).length >= expected.codeReviewConfirmationsMin,
      `${sessionID} codeReviewConfirmationsMin`
    )
  }
  if (Object.prototype.hasOwnProperty.call(expected, "reportExists")) {
    assert.strictEqual(fs.existsSync(path.join(cwd, ".sdd-drift-report.md")), expected.reportExists, "reportExists")
  }
}

const assertProject = (cwd, project, expected) => {
  for (const [relDir, state] of Object.entries(expected.states || {})) {
    assert.strictEqual(project.changeDirs?.[relDir]?.state, state, `${relDir} project state`)
  }
  for (const [relDir, codeFiles] of Object.entries(expected.linkedCodeContains || {})) {
    const linked = (project.changeDirs?.[relDir]?.linkedCode || []).map((item) => item.path)
    for (const codeFile of codeFiles) {
      assert.ok(linked.includes(codeFile), `${relDir} linkedCode should include ${codeFile}`)
    }
  }
  for (const [relDir, conditions] of Object.entries(expected.conditions || {})) {
    assertObjectSubset(project.changeDirs?.[relDir]?.conditions || {}, conditions, `${relDir} conditions`)
  }
}

const runFixture = (fixtureDir) => {
  const id = path.basename(fixtureDir)
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `sdd-journey-${id}-`))
  const cwd = path.join(tmpRoot, "workspace")
  const logPath = path.join(cwd, ".journey", "sdd-drift-check.log.jsonl")
  fs.mkdirSync(cwd, { recursive: true })

  try {
    writeWorkspaceFiles(cwd, readJson(path.join(fixtureDir, "files.json")))

    const tokens = { "<cwd>": cwd.replace(/\\/g, "\\\\") }
    const inputs = readJsonl(path.join(fixtureDir, "inputs.jsonl")).map((input) =>
      replaceTokens(
        {
          hook_source: "opencode-plugin",
          cwd,
          session_id: `session-${id}`,
          ...input,
        },
        tokens
      )
    )
    const stdoutExpectations = readJsonl(path.join(fixtureDir, "expected-stdout.jsonl"))
    assert.strictEqual(stdoutExpectations.length, inputs.length, `${id} expected stdout count`)

    inputs.forEach((input, index) => {
      const result = spawnSync(process.execPath, [hookPath], {
        cwd,
        input: JSON.stringify(input),
        encoding: "utf8",
        env: {
          ...process.env,
          SDD_DRIFT_LOG: "1",
          SDD_DRIFT_LOG_PATH: logPath,
          SDD_DRIFT_CHECKPOINT_MTIME_SCAN: "0",
        },
      })
      assert.strictEqual(result.status, 0, `${id} step ${index + 1} exit status\n${result.stderr}`)
      assert.strictEqual(result.stderr, "", `${id} step ${index + 1} stderr`)
      assertStdout(result.stdout, stdoutExpectations[index], `${id} step ${index + 1}`)
    })

    const project = hook.loadProjectState(cwd)
    const expectedSession = readJson(path.join(fixtureDir, "expected-session.json"))
    for (const [sessionID, expected] of Object.entries(expectedSession.sessions || {})) {
      assertSession(cwd, sessionID, expected, project)
    }
    if (!expectedSession.sessions) {
      assertSession(cwd, expectedSession.sessionId || `session-${id}`, expectedSession, project)
    }

    assertProject(cwd, project, readJson(path.join(fixtureDir, "expected-project.json")))

    const actualEvents = loadEvents(logPath).map((event) => event.event)
    for (const expectedEvent of readJsonl(path.join(fixtureDir, "expected-events.jsonl"))) {
      assert.ok(actualEvents.includes(expectedEvent), `${id} log should include event ${expectedEvent}`)
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

for (const entry of fs.readdirSync(fixtureRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) runFixture(path.join(fixtureRoot, entry.name))
}

console.log("sdd-drift journey fixture tests passed")
