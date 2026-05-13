import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const port = Number(process.env.FAKE_OPENAI_PORT || 48127)
const scenario = process.env.FAKE_SCENARIO || "sdd-design"
const logPath = path.resolve("fake-openai.log")
let requestCount = 0
let toolStage = 0

const log = (entry) => {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n")
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })

const writeJson = (response, status, data) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(data))
}

const sse = (response, payload) => {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const completionChunk = (delta, finishReason = null) => ({
  id: "chatcmpl-sdd-drift-e2e",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "fake-model",
  choices: [
    {
      index: 0,
      delta,
      finish_reason: finishReason,
    },
  ],
})

const target =
  scenario === "code"
    ? "src/app.ts"
    : "sdd/changes/test-feat/design.md"
const targetContent =
  scenario === "code"
    ? "export function greet(name: string) {\n  return \"hi \" + name\n}\n"
    : "# Design\n\nEdited by fake opencode model.\n"
const toolArguments = JSON.stringify({
  filePath: target,
  content: targetContent,
})
const readArguments = JSON.stringify({
  filePath: target,
})

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    writeJson(response, 200, {
      object: "list",
      data: [{ id: "fake-model", object: "model", owned_by: "test" }],
    })
    return
  }

  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    writeJson(response, 404, { error: { message: "not found" } })
    return
  }

  const body = await readBody(request)
  const payload = JSON.parse(body)
  requestCount += 1
  const toolNames = (payload.tools || []).map((tool) => tool.function?.name || tool.name)
  log({
    request: requestCount,
    scenario,
    stream: payload.stream,
    toolNames,
    messageRoles: (payload.messages || []).map((message) => message.role),
  })

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })

  if (toolNames.includes("write") && toolStage === 0) {
    toolStage += 1
    sse(response, completionChunk({ role: "assistant" }))
    sse(
      response,
      completionChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_read_design",
            type: "function",
            function: {
              name: "read",
              arguments: "",
            },
          },
        ],
      }),
    )
    sse(
      response,
      completionChunk({
        tool_calls: [
          {
            index: 0,
            function: {
              arguments: readArguments,
            },
          },
        ],
      }),
    )
    sse(response, completionChunk({}, "tool_calls"))
  } else if (toolNames.includes("write") && toolStage === 1) {
    toolStage += 1
    sse(response, completionChunk({ role: "assistant" }))
    sse(
      response,
      completionChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_write_design",
            type: "function",
            function: {
              name: "write",
              arguments: "",
            },
          },
        ],
      }),
    )
    sse(
      response,
      completionChunk({
        tool_calls: [
          {
            index: 0,
            function: {
              arguments: toolArguments,
            },
          },
        ],
      }),
    )
    sse(response, completionChunk({}, "tool_calls"))
  } else {
    sse(response, completionChunk({ role: "assistant" }))
    sse(response, completionChunk({ content: "Design file updated." }))
    sse(response, completionChunk({}, "stop"))
  }

  response.end("data: [DONE]\n\n")
})

server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync("fake-openai.ready", String(port))
  console.log(`fake OpenAI-compatible server listening on ${port}`)
})

process.on("SIGTERM", () => {
  server.close(() => process.exit(0))
})
