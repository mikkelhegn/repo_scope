#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible mock server for local development.
 *
 * It lets you exercise the full RepoScope loop — model turn, sandbox tool call,
 * observation, final answer — without spending API credits. It is NOT a real
 * model: the first turn always asks the sandbox to inspect spinframework/spin,
 * and the second turn summarizes the observation.
 *
 * Usage:
 *   node scripts/mock-openai.mjs
 *   SPIN_VARIABLE_OPENAI_BASE_URL=http://127.0.0.1:4010 \
 *   SPIN_VARIABLE_OPENAI_API_KEY=mock \
 *   spin up
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const MODEL = process.env.MOCK_MODEL ?? "mock-codeact";

const CODE = `
const response = await fetch("https://api.github.com/repos/spinframework/spin", {
  headers: {
    "Accept": "application/vnd.github+json",
    "User-Agent": "RepoScope",
  },
});
console.log("status", response.status);
const repo = await response.json();
console.log(JSON.stringify({
  full_name: repo.full_name,
  description: repo.description,
  stars: repo.stargazers_count,
  language: repo.language,
  default_branch: repo.default_branch,
  open_issues: repo.open_issues_count,
}, null, 2));
`.trim();

function chunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function usage() {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    },
  };
}

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: MODEL }));
    return;
  }

  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  let request;
  try {
    request = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }

  const messages = Array.isArray(request.messages) ? request.messages : [];
  const toolMessage = [...messages]
    .reverse()
    .find((message) => message.role === "tool");

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  if (!toolMessage) {
    // First turn: ask the sandbox to fetch a real repository.
    sendEvent(res, {
      ...chunk({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            index: 0,
            id: "call_mock_1",
            type: "function",
            function: {
              name: "run_in_wasm_interpreter",
              arguments: JSON.stringify({
                language: "javascript",
                code: CODE,
              }),
            },
          },
        ],
      }),
    });
    sendEvent(res, chunk({}, "tool_calls"));
    sendEvent(res, usage());
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const observation =
    typeof toolMessage.content === "string" ? toolMessage.content : "";
  const summary =
    "Mock OpenAI server: the sandbox ran successfully. Here is the observation " +
    "it returned:\n\n```text\n" +
    observation.slice(0, 1200) +
    "\n```\n\nSet `SPIN_VARIABLE_OPENAI_API_KEY` to a real key and point " +
    "`SPIN_VARIABLE_OPENAI_BASE_URL` at `https://api.openai.com` to use a real model.";

  const words = summary.split(/(\s+)/);
  let index = 0;
  const timer = setInterval(() => {
    if (index >= words.length) {
      clearInterval(timer);
      sendEvent(res, chunk({}, "stop"));
      sendEvent(res, usage());
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    sendEvent(res, chunk({ role: "assistant", content: words[index] }));
    index += 1;
  }, 8);

  req.on("close", () => clearInterval(timer));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock OpenAI API listening on http://127.0.0.1:${PORT}`);
  console.log(`Model: ${MODEL}`);
});
