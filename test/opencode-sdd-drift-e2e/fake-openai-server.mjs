import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const port = Number(process.env.FAKE_OPENAI_PORT || 48127)
const scenario = process.env.FAKE_SCENARIO || "sdd-design"
const logPath = path.resolve(process.env.FAKE_LOG_PATH || "fake-openai.log")
const readyPath = path.resolve(process.env.FAKE_READY_PATH || "fake-openai.ready")
let requestCount = 0
let toolStage = 0

const messageText = (messages) =>
  (messages || [])
    .map((message) => {
      if (typeof message.content === "string") return message.content
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) => part.text || part.content || "")
          .join("\n")
      }
      return ""
    })
    .join("\n")

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
const designArguments = JSON.stringify({
  filePath: "sdd/changes/test-feat/design.md",
})
const codeDesignArguments = JSON.stringify({
  filePath: "sdd/changes/test-feat/design.md",
  content:
    "# Design\n\nInitial design.\n\n## Synced by fake opencode model after code drift enforcement.\n",
})
const tasksArguments = JSON.stringify({
  filePath: "sdd/changes/test-feat/tasks.md",
  content:
    "# Tasks\n\n- [x] Synced by fake opencode model after SDD drift tool result enforcement.\n",
})
const readTasksArguments = JSON.stringify({
  filePath: "sdd/changes/test-feat/tasks.md",
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
  const toolText = messageText((payload.messages || []).filter((message) => message.role === "tool"))
  const hasToolEnforcement = toolText.includes("SDD drift tool result enforcement")
  const hasCodeEnforcement =
    toolText.includes("changed code") ||
    toolText.includes("code changed") ||
    toolText.includes("changed implementation code")
  log({
    request: requestCount,
    scenario,
    stream: payload.stream,
    toolNames,
    hasToolEnforcement,
    hasCodeEnforcement,
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
  } else if (
    scenario === "code" &&
    hasToolEnforcement &&
    toolNames.includes("write") &&
    toolStage === 2
  ) {
    toolStage += 1
    sse(response, completionChunk({ role: "assistant" }))
    sse(
      response,
      completionChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_read_design_after_code",
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
              arguments: designArguments,
            },
          },
        ],
      }),
    )
    sse(response, completionChunk({}, "tool_calls"))
  } else if (
    scenario === "code" &&
    hasToolEnforcement &&
    toolNames.includes("write") &&
    toolStage === 3
  ) {
    toolStage += 1
    sse(response, completionChunk({ role: "assistant" }))
    sse(
      response,
      completionChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_write_design_after_code",
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
              arguments: codeDesignArguments,
            },
          },
        ],
      }),
    )
    sse(response, completionChunk({}, "tool_calls"))
  } else if (
    (scenario === "sdd-cascade" || scenario === "code") &&
    hasToolEnforcement &&
    toolNames.includes("write") &&
    (scenario === "sdd-cascade" ? toolStage === 2 : toolStage === 4)
  ) {
    toolStage += 1
    sse(response, completionChunk({ role: "assistant" }))
    sse(
      response,
      completionChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_read_tasks",
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
              arguments: readTasksArguments,
            },
          },
        ],
      }),
    )
    sse(response, completionChunk({}, "tool_calls"))
  } else if (
    (scenario === "sdd-cascade" || scenario === "code") &&
    hasToolEnforcement &&
    toolNames.includes("write") &&
    (scenario === "sdd-cascade" ? toolStage === 3 : toolStage === 5)
  ) {
    toolStage += 1
    sse(response, completionChunk({ role: "assistant" }))
    sse(
      response,
      completionChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_write_tasks",
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
              arguments: tasksArguments,
            },
          },
        ],
      }),
    )
    sse(response, completionChunk({}, "tool_calls"))
  } else {
    sse(response, completionChunk({ role: "assistant" }))
    sse(
      response,
      completionChunk({
        content:
          (scenario === "sdd-cascade" && toolStage >= 4) ||
          (scenario === "code" && toolStage >= 6)
            ? "Design and tasks files updated."
            : "Design file updated.",
      }),
    )
    sse(response, completionChunk({}, "stop"))
  }

  response.end("data: [DONE]\n\n")
})

server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(readyPath, String(port))
  console.log(`fake OpenAI-compatible server listening on ${port}`)
})

process.on("SIGTERM", () => {
  server.close(() => process.exit(0))
})
