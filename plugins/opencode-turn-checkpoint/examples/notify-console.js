#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")

const argValue = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

const payloadFile = argValue("-Payload") || argValue("--payload")

if (!payloadFile) {
  console.error("Missing -Payload <payload.json>")
  process.exit(2)
}

let payload
try {
  payload = JSON.parse(fs.readFileSync(payloadFile, "utf8").replace(/^\uFEFF/, ""))
} catch (error) {
  console.error(`Failed to read payload: ${error.message}`)
  process.exit(2)
}

const agentOutput = payload.agentOutput || {}
const recentActivity = payload.recentActivity || {}
const projectName = payload.cwd ? path.basename(payload.cwd) : "unknown-project"
const preview = String(agentOutput.preview || "").trim()

const lines = [
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
]

console.log(lines.join("\n"))
