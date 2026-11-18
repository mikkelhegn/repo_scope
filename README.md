# RepoScope

A chat agent that examines GitHub repositories with the **CodeAct** pattern: the
model's action is a JavaScript program, and that program runs inside the
[Spin Code Sandbox](https://github.com/spinframework/spin-code-sandbox), a private
WebAssembly component with no filesystem, no shell, and an egress allow-list.

```
┌────────────────────┐   POST /api/chat    ┌──────────────────────────┐
│  Browser chat UI   │ ──────────────────▶ │  api (Hono + OpenAI)     │
│  static, no build  │ ◀────────────────── │  CodeAct tool loop       │
└────────────────────┘   NDJSON stream     └────────────┬─────────────┘
                                                       │ private service chain
                                                       ▼
                                          ┌──────────────────────────┐
                                          │  ts-sandbox (private)    │
                                          │  Spin Code Sandbox       │
                                          │  no fs / shell / KV      │
                                          └────────────┬─────────────┘
                                                       │ allow-listed egress
                                                       ▼
                                          api.github.com
                                          raw.githubusercontent.com
```

The model writes JavaScript that fetches the repository tree, manifests, docs, and
source files. The sandbox runs it, returns stdout/stderr/errors, and the model iterates
until it can write a cited answer. Every code run and its real output are shown in the
chat.

## Prerequisites

- [Spin](https://spinframework.dev) 4.x
- Node.js 20+ and npm
- An OpenAI API key (or any OpenAI-compatible Chat Completions server)

The two large Wasm components — the static fileserver and `ts-sandbox` — are pinned
release artifacts in `spin.toml`. Spin downloads and verifies them on first run, so you
do **not** need Rust, `wac`, `wasm-tools`, or a Python toolchain.

## Quick start

```bash
cp .env.example .env
# put your key in .env
./run.sh
```

Open <http://127.0.0.1:3000> and ask about a repository. `run.sh` sources `.env`, maps
`OPENAI_API_KEY` to the Spin variable if needed, and runs `spin up --build`.

Or configure it directly:

```bash
export SPIN_VARIABLE_OPENAI_API_KEY=sk-...
spin up --build
```

Health check:

```bash
curl -s http://127.0.0.1:3000/api/health
```

## Configuration

Spin exposes lowercase application variables through `SPIN_VARIABLE_*` environment
variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPIN_VARIABLE_OPENAI_API_KEY` | empty | OpenAI API key (required) |
| `SPIN_VARIABLE_OPENAI_BASE_URL` | `https://api.openai.com` | Origin of an OpenAI-compatible server; the app appends `/v1` |
| `SPIN_VARIABLE_MODEL` | `gpt-5` | Any Chat Completions model that supports tool calling |
| `SPIN_VARIABLE_ACCESS_TOKEN` | empty | Optional shared token that gates the UI and API |
| `SPIN_VARIABLE_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`, or `trace` |
| `SPIN_VARIABLE_MAX_TURNS` | `10` | Maximum model turns before a forced summary |
| `SPIN_VARIABLE_TS_SANDBOX_URL` | internal | Override the private sandbox URL only if you know what you are doing |

Examples:

```bash
# A smaller, cheaper model
SPIN_VARIABLE_MODEL=gpt-4.1-mini ./run.sh

# A local OpenAI-compatible server (Ollama, vLLM, LM Studio, …)
SPIN_VARIABLE_OPENAI_BASE_URL=http://127.0.0.1:11434 \
SPIN_VARIABLE_OPENAI_API_KEY=local \
SPIN_VARIABLE_MODEL=qwen3:8b \
./run.sh
```

If you change `openai_base_url`, it is also interpolated into the API component's
`allowed_outbound_hosts` in `spin.toml`, so keep it an origin (no path).

## Development without an API key

`scripts/mock-openai.mjs` is a tiny OpenAI-compatible server that returns a real sandbox
tool call on the first turn and summarizes the observation on the second. It exercises the
whole agent loop, streaming, and UI without spending credits.

```bash
node scripts/mock-openai.mjs

# in another terminal
SPIN_VARIABLE_OPENAI_API_KEY=mock \
SPIN_VARIABLE_OPENAI_BASE_URL=http://127.0.0.1:4010 \
SPIN_VARIABLE_MODEL=mock-codeact \
spin up --build
```

## Architecture

- **`ui/`** — a dependency-free single-page chat. It renders streamed model text,
  syntax-preserving code cards, and tool output. Markdown is rendered from an escaped,
  allow-listed subset (no raw HTML), and only `http`/`https` links are accepted.
- **`api/`** — a Hono component compiled to Wasm by `j2w`. It owns the system prompt, the
  tool schema, the OpenAI loop, the access gate, and the sandbox client. It streams
  newline-delimited JSON so the UI updates as the model types and as each sandbox run
  finishes.
- **`ts-sandbox`** — the private `spin-code-sandbox` component. It is never publicly
  routable. The API reaches it by service chaining at
  `http://ts-sandbox.spin.internal`.

The model cannot choose its sandbox identity, KV policy, or network permissions. Those
are set by the application for every run. The tool schema accepts only `language` and
`code`; extra arguments are rejected.

### Agent loop

1. The browser sends the prompt and the prior OpenAI message history to `/api/chat`.
2. The API asks the model for a turn with one tool, `run_in_wasm_interpreter`.
3. If the model emits a tool call, the API validates it and posts a
   `{ code, sandboxId, allowedHosts, kvEnabled }` envelope to the private sandbox.
4. stdout, stderr, and errors are fed back as the tool result.
5. Steps 2–4 repeat until the model answers, or until `max_turns` is reached. At the
   limit, the API asks for a summary with tools disabled.

The API caps tool observations (28 KB) and UI output, and aborts sandbox HTTP requests
after 90 seconds.

## Security model

- **Private sandbox.** The `ts-sandbox` component has `route = { private = true }`. Only
  the API component can reach it.
- **No ambient capabilities.** Model code has no filesystem, shell, subprocess, raw
  socket, or runtime package installation. KV is disabled (`kvEnabled: false`).
- **Egress allow-list.** Both the component manifest and every request allow only
  `https://api.github.com` and `https://raw.githubusercontent.com`. The sandbox guard
  enforces the intersection and always refuses private/loopback/internal targets.
- **Server-owned policy.** The model cannot supply a sandbox ID, hosts, or KV flag.
- **Untrusted output.** Model text is escaped and rendered with a small Markdown
  allow-list. Code and tool output are inserted with `textContent`.
- **Access gate.** Set `SPIN_VARIABLE_ACCESS_TOKEN` before exposing the app; an empty
  token means anyone who can reach it can spend your OpenAI key.
- **Public repositories only.** The app does not authenticate to GitHub. Private repos
  return 404. Unauthenticated GitHub API calls are rate limited (roughly 60/hour per IP);
  the agent is instructed to fetch one tree and use raw.githubusercontent.com for files.

The sandbox itself does not enforce a per-run CPU or wall-clock limit. The API aborts its
HTTP request after 90 seconds, but a runaway Wasm instance may continue until the platform
reaps it. For a public deployment, put Spin behind a platform that enforces request
deadlines and memory limits, and block private networks at the host layer as well.

## Testing

```bash
# Type-check and rebuild the API
cd api && npm run typecheck && npm run build

# While the app is running
curl -s http://127.0.0.1:3000/api/health

# Exercise the full loop with the mock model
BASE=http://127.0.0.1:3000 ./scripts/smoke.sh

# If the access gate is enabled, pass the token too
BASE=http://127.0.0.1:3000 ACCESS_TOKEN=... ./scripts/smoke.sh
```

`scripts/smoke.sh` checks health and sends one chat request, asserting that the stream
contains a sandbox tool result and a `done` event. It authenticates with `ACCESS_TOKEN`
when one is given.

## Project layout

```
spin.toml                 components, variables, private sandbox, egress policy
run.sh                    loads .env and runs spin up --build
.env.example              documented configuration template
api/
  src/index.ts            Hono app, auth, /api/chat NDJSON stream
  src/agent.ts            CodeAct loop, tool validation, output caps
  src/openai.ts           streaming Chat Completions client
  src/sandbox.ts          envelope client for POST /ts/run
  src/prompt.ts           GitHub-oriented system prompt
  src/config.ts           variables and allowed hosts
ui/
  index.html              chat shell + help dialog
  app.js                  stream parser, Markdown renderer, tool cards
  styles.css              responsive dark UI
scripts/
  mock-openai.mjs         local OpenAI-compatible mock for development
  smoke.sh                health + one chat request
```

## Using a locally built sandbox

The pinned canary artifact is convenient and reproducible. To build the same component
from source instead:

```bash
git clone https://github.com/spinframework/spin-code-sandbox
cd spin-code-sandbox
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2 -p guard-io -p guard
npm --prefix packages/typescript/sandbox ci
npm --prefix packages/typescript/sandbox run build
wac compose \
  -d guard:io=target/wasm32-wasip2/release/guard_io.wasm \
  -d ts-sandbox:sandbox=packages/typescript/sandbox/dist/ts-sandbox.wasm \
  -d guard:front=target/wasm32-wasip2/release/guard.wasm \
  -o dist/ts-sandbox.wasm \
  crates/guard/compose.wac
```

Then replace the `source = { url = …, digest = … }` line for `ts-sandbox` in `spin.toml`
with `source = "path/to/ts-sandbox.wasm"`.

To add Python as a second language, fetch or build `py-sandbox.wasm`, add another private
component, include it in the API's `allowed_outbound_hosts`, and let the model choose
`language: "python"`. The tool description and system prompt in `api/src/prompt.ts` and
`api/src/agent.ts` are the places to update.

## Credits

Built on [Spin](https://spinframework.dev), the
[Spin Code Sandbox](https://github.com/spinframework/spin-code-sandbox) (Apache-2.0), and
the [CodeAct](https://arxiv.org/abs/2402.01030) pattern. The OpenAI loop follows the shape
of the sandbox project's `ai-code-executor` example, adapted for GitHub investigation and
a dependency-free UI.

License: MIT.
