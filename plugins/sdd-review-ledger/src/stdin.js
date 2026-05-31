"use strict"

// Read all of stdin (the hook event JSON). Bounded to avoid unbounded buffering.
// Resolves "" immediately on a TTY so a manual run never hangs. Ported from
// sibling sdd-drift-check/src/stdin.js.

const MAX_STDIN = 10 * 1024 * 1024

const readStdin = () =>
  new Promise((resolve) => {
    let data = ""
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(data)
    }
    try {
      if (process.stdin.isTTY) {
        resolve("")
        return
      }
      process.stdin.setEncoding("utf8")
    } catch {
      resolve("")
      return
    }
    process.stdin.on("data", (chunk) => {
      data += chunk
      if (data.length > MAX_STDIN) {
        data = data.slice(0, MAX_STDIN)
        finish()
      }
    })
    process.stdin.on("end", finish)
    process.stdin.on("error", finish)
  })

module.exports = { MAX_STDIN, readStdin }
