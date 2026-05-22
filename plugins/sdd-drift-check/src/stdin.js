const readStdin = (timeoutMs) =>
  new Promise((resolve, reject) => {
    let data = ""
    let settled = false
    let timer = null

    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(data)
    }

    const fail = (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(err)
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(finish, timeoutMs)
    }

    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", finish)
    process.stdin.on("error", fail)
    if (process.stdin.isTTY) finish()
  })

module.exports = { readStdin }
