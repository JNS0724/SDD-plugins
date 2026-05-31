#!/usr/bin/env node
"use strict"

// Claude Code command-hook entry. Reads the hook event JSON on stdin, dispatches
// to the right handler, writes the (optional) additionalContext JSON to stdout.
// Always exits 0 — the tool must never block the user's main flow (§1).

const { readStdin } = require("../../stdin")
const { dispatch } = require("../../dispatch")

const main = async () => {
  const raw = await readStdin()
  let event
  try {
    event = raw ? JSON.parse(raw) : {}
  } catch {
    event = {}
  }
  const result = dispatch(event, process.env)
  if (result && typeof result.stdout === "string" && result.stdout.length > 0) {
    process.stdout.write(result.stdout)
  }
  process.exit(0)
}

main().catch(() => process.exit(0))
