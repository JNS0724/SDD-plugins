#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")

const argValue = (argv, name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : null
}

const readPayload = (payloadFile) => JSON.parse(fs.readFileSync(payloadFile, "utf8").replace(/^\uFEFF/, ""))

const formatPayload = (payload) => {
  const agentOutput = payload.agentOutput || {}
  const recentActivity = payload.recentActivity || {}
  const projectName = payload.cwd ? path.basename(payload.cwd) : "unknown-project"
  const preview = String(agentOutput.preview || "").trim()

  return [
    "OpenCode turn checkpoint",
    `Project: ${projectName}`,
    `Directory: ${payload.cwd || ""}`,
    `Session: ${payload.sessionId || ""}`,
    `Event: ${payload.event || ""}`,
    `Timestamp: ${payload.timestamp || ""}`,
    `Last tool: ${recentActivity.lastTool || "none"}`,
    `Last tool at: ${recentActivity.lastToolAt || "none"}`,
    `Last message at: ${recentActivity.lastMessageAt || "none"}`,
    `Agent output source: ${agentOutput.source || "none"}`,
    `Agent output truncated: ${Boolean(agentOutput.truncated)}`,
    "",
    "Agent output preview:",
    preview || "(empty)",
  ].join("\n")
}

const main = (argv = process.argv) => {
  const payloadFile = argValue(argv, "-Payload") || argValue(argv, "--payload")

  if (!payloadFile) {
    console.error("Missing -Payload <payload.json>")
    return 2
  }

  try {
    console.log(formatPayload(readPayload(payloadFile)))
    return 0
  } catch (error) {
    console.error(`Failed to read payload: ${error.message}`)
    return 2
  }
}

const OpenCodeTurnCheckpointNotifyConsoleExample = async () => ({})

exports.OpenCodeTurnCheckpointNotifyConsoleExample = OpenCodeTurnCheckpointNotifyConsoleExample
exports._private = Object.assign(async () => ({}), {
  argValue,
  formatPayload,
  main,
  readPayload,
})

if (require.main === module) {
  process.exitCode = main(process.argv)
}
