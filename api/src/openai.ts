import OpenAI from "openai";

/** A provider-neutral function tool definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamedTurn {
  text: string;
  toolCalls: StreamedToolCall[];
  finishReason: string;
  usage: { input: number; output: number };
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Thin, stateless OpenAI Chat Completions client.
 *
 * The full conversation is sent each turn, which keeps the agent loop easy to
 * reason about and works with OpenAI-compatible servers too.
 */
export class OpenAIClient {
  private readonly client: OpenAI;
  readonly model: string;

  constructor(options: { apiKey: string; baseURL: string; model: string }) {
    this.client = new OpenAI({
      // Some local OpenAI-compatible servers ignore the key, but the SDK requires one.
      apiKey: options.apiKey || "unset",
      baseURL: options.baseURL,
    });
    this.model = options.model;
  }

  async stream(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    onText: (delta: string) => void,
  ): Promise<StreamedTurn> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages,
      max_completion_tokens: 4096,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as OpenAI.FunctionParameters,
        },
      }));
    }

    const stream = await this.client.chat.completions.create(params);

    let text = "";
    let finishReason = "";
    let usage = { input: 0, output: 0 };
    const calls = new Map<number, PendingCall>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        };
      }

      const choice = chunk.choices[0];
      if (!choice) continue; // the final usage-only chunk has no choices

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (delta.content) {
        text += delta.content;
        onText(delta.content);
      }

      for (const toolDelta of delta.tool_calls ?? []) {
        let call = calls.get(toolDelta.index);
        if (!call) {
          call = {
            id: toolDelta.id || `call_${toolDelta.index}`,
            name: "",
            args: "",
          };
          calls.set(toolDelta.index, call);
        }
        if (toolDelta.id) call.id = toolDelta.id;
        if (toolDelta.function?.name) call.name = toolDelta.function.name;
        if (toolDelta.function?.arguments) call.args += toolDelta.function.arguments;
      }
    }

    const toolCalls: StreamedToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: call.args || "{}",
      }));

    return { text, toolCalls, finishReason, usage };
  }
}
