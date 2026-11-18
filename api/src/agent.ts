import type OpenAI from "openai";

import type { AppConfig } from "./config";
import { SANDBOX_ALLOWED_HOSTS } from "./config";
import { log } from "./logger";
import { OpenAIClient, type ChatMessage, type ToolDefinition } from "./openai";
import { systemPrompt } from "./prompt";
import { SandboxClient, type SandboxRunResult } from "./sandbox";

export type WireEvent =
  | { t: "text_delta"; block: string; text: string }
  | {
      t: "tool_start";
      id: string;
      language: string;
      code: string;
      allowedHosts: string[];
      genMs: number;
    }
  | {
      t: "tool_end";
      id: string;
      execMs: number;
      stdout: string;
      stderr: string;
      error: string | null;
    }
  | { t: "done"; history: ChatMessage[] }
  | { t: "error"; error: string };

export type Emit = (event: WireEvent) => void;

const MAX_TOOL_RESULT_CHARS = 28_000;
const MAX_CODE_CHARS = 200_000;

const RUN_TOOL: ToolDefinition = {
  name: "run_in_wasm_interpreter",
  description:
    "Run JavaScript/TypeScript in an isolated WebAssembly sandbox and get back stdout, " +
    "stderr, and any error. The sandbox has browser-style fetch and standard JavaScript, " +
    "but no filesystem, shell, Node APIs, or package installation. Outbound HTTP is " +
    "limited by the application to https://api.github.com and " +
    "https://raw.githubusercontent.com. Print the results you need to stdout. " +
    "Top-level await is supported: await all asynchronous work, because promises still " +
    "pending when the program ends are discarded without output or error. Keep output " +
    "compact (under ~200 lines / 20 KB per run).",
  parameters: {
    type: "object",
    properties: {
      language: {
        type: "string",
        enum: ["javascript"],
        description: "Always javascript. TypeScript syntax is accepted.",
      },
      code: {
        type: "string",
        description:
          "The complete program to run. Use browser-style fetch, print findings to " +
          "stdout, and await every asynchronous operation.",
      },
    },
    required: ["language", "code"],
    additionalProperties: false,
  },
};

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} characters]`;
}

function formatToolResult(result: SandboxRunResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  if (result.error) parts.push(`error: ${result.error}`);
  const text = parts.join("\n\n") || "(no output)";
  return clip(text, MAX_TOOL_RESULT_CHARS);
}

function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validateToolInput(
  input: Record<string, unknown> | null,
): { code: string } | { error: string } {
  if (!input) return { error: "error: tool arguments must be a JSON object" };

  const allowed = new Set(["language", "code"]);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    return {
      error:
        "error: unsupported tool arguments (" +
        unexpected.join(", ") +
        "). Execution permissions, sandbox identity, and network policy are controlled by the application. Use only language and code.",
    };
  }

  if (input.language !== "javascript") {
    return { error: 'error: language must be "javascript"' };
  }
  if (typeof input.code !== "string" || !input.code.trim()) {
    return { error: "error: code must be a non-empty string" };
  }
  if (input.code.length > MAX_CODE_CHARS) {
    return {
      error: `error: code is too large (${input.code.length} characters; limit ${MAX_CODE_CHARS})`,
    };
  }
  return { code: input.code };
}

/**
 * Keep only the message shapes the OpenAI Chat Completions API accepts, and cap
 * the size so a client cannot replay an unbounded transcript. System and
 * developer messages are deliberately dropped: the server owns the system prompt.
 */
function sanitizeHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  const result: ChatMessage[] = [];
  for (const raw of value.slice(-60)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    if (item.role === "user") {
      if (typeof item.content === "string") {
        result.push({ role: "user", content: item.content.slice(0, 20_000) });
      }
      continue;
    }

    if (item.role === "assistant") {
      const message: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content:
          typeof item.content === "string" ? item.content.slice(0, 20_000) : null,
      };
      if (Array.isArray(item.tool_calls)) {
        const calls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
        for (const rawCall of item.tool_calls) {
          if (!rawCall || typeof rawCall !== "object") continue;
          const call = rawCall as Record<string, unknown>;
          const fn = call.function as Record<string, unknown> | undefined;
          if (
            typeof call.id === "string" &&
            fn &&
            typeof fn.name === "string" &&
            typeof fn.arguments === "string"
          ) {
            calls.push({
              id: call.id,
              type: "function",
              function: {
                name: fn.name,
                arguments: fn.arguments.slice(0, 30_000),
              },
            });
          }
        }
        if (calls.length > 0) message.tool_calls = calls;
      }
      result.push(message);
      continue;
    }

    if (item.role === "tool") {
      if (
        typeof item.tool_call_id === "string" &&
        typeof item.content === "string"
      ) {
        result.push({
          role: "tool",
          tool_call_id: item.tool_call_id,
          content: item.content.slice(0, 30_000),
        });
      }
    }
  }
  return result;
}

function sandboxIdentity(): string {
  const cryptoApi = globalThis.crypto as
    | { randomUUID?: () => string }
    | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export interface RunAgentOptions {
  config: AppConfig;
  prompt: string;
  history: unknown;
  emit: Emit;
}

/**
 * The CodeAct loop: ask the model for a turn, run any code it writes in the
 * private sandbox, feed the observations back, and repeat until it answers.
 */
export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { config, prompt, history, emit } = options;

  const llm = new OpenAIClient({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    model: config.model,
  });
  const sandbox = new SandboxClient(config.tsSandboxUrl);
  const identity = sandboxIdentity();

  const messages: ChatMessage[] = [
    ...sanitizeHistory(history),
    { role: "user", content: prompt },
  ];

  log.info(
    `chat: provider=openai model=${llm.model} turns=${config.maxTurns} prompt=${JSON.stringify(
      prompt.slice(0, 80),
    )}`,
  );

  let toolId = 0;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    const genStart = Date.now();
    const result = await llm.stream(messages, [RUN_TOOL], (delta) => {
      emit({ t: "text_delta", block: `${turn}-0`, text: delta });
    });
    const genMs = Date.now() - genStart;

    log.info(
      `generate: turn=${turn} ${genMs}ms stop=${result.finishReason} ` +
        `in=${result.usage.input} out=${result.usage.output} calls=${result.toolCalls.length}`,
    );

    const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: result.text || null,
    };
    if (result.toolCalls.length > 0) {
      assistant.tool_calls = result.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
    }
    messages.push(assistant);

    if (result.toolCalls.length === 0) {
      emit({ t: "done", history: messages });
      return;
    }

    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

    for (const call of result.toolCalls) {
      const id = `tool-${toolId++}`;

      if (call.name !== RUN_TOOL.name) {
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: `error: unknown tool "${call.name}"; only ${RUN_TOOL.name} is available`,
        });
        continue;
      }

      const parsed = parseArguments(call.arguments);
      const validated = validateToolInput(parsed);
      if ("error" in validated) {
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: validated.error,
        });
        continue;
      }

      const code = validated.code;
      emit({
        t: "tool_start",
        id,
        language: "javascript",
        code,
        allowedHosts: [...SANDBOX_ALLOWED_HOSTS],
        genMs,
      });

      const execStart = Date.now();
      let runResult: SandboxRunResult;
      try {
        runResult = await sandbox.run(code, {
          identity,
          allowedHosts: SANDBOX_ALLOWED_HOSTS,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        runResult = {
          stdout: "",
          stderr: "",
          error: `sandbox request failed: ${message}`,
        };
      }
      const execMs = Date.now() - execStart;

      log.info(
        `execute: sandbox=ts-sandbox exec=${execMs}ms ` +
          `${runResult.error ? `error=${JSON.stringify(runResult.error.slice(0, 200))}` : "ok"} ` +
          `stdout=${runResult.stdout.length}b`,
      );

      emit({
        t: "tool_end",
        id,
        execMs,
        stdout: clip(runResult.stdout, 60_000),
        stderr: clip(runResult.stderr, 20_000),
        error: runResult.error ? clip(runResult.error, 4_000) : null,
      });

      toolResults.push({
        role: "tool",
        tool_call_id: call.id,
        content: formatToolResult(runResult),
      });
    }

    messages.push(...toolResults);
  }

  // The tool budget is exhausted. Ask for a summary without tools so the user
  // still gets an answer, without polluting the saved history with this nudge.
  const historyBeforeNudge = [...messages];
  const summaryMessages: ChatMessage[] = [
    ...messages,
    {
      role: "user",
      content:
        "You reached the tool-call limit for this request. Do not call any more tools. " +
        "Summarize what you confirmed so far, and clearly state what you did not inspect or verify.",
    },
  ];

  const summary = await llm.stream(summaryMessages, undefined, (delta) => {
    emit({ t: "text_delta", block: `limit-${toolId}`, text: delta });
  });

  const finalMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content:
      summary.text ||
      "I reached the tool-call limit before I could finish. Try a narrower question or ask me to continue.",
  };

  emit({ t: "done", history: [...historyBeforeNudge, finalMessage] });
}
