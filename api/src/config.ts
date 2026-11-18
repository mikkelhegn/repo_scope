import * as variables from "@spinframework/spin-variables";

export interface AppConfig {
  /** OpenAI (or OpenAI-compatible) API key. */
  openaiApiKey: string;
  /** Full Chat Completions base URL, including /v1. */
  openaiBaseUrl: string;
  model: string;
  /** Private sandbox component base URL. */
  tsSandboxUrl: string;
  /** Optional shared token that gates the UI and API. */
  accessToken: string;
  logLevel: string;
  maxTurns: number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(): AppConfig {
  const rawBase = trimTrailingSlash(
    variables.get("openai_base_url") || "https://api.openai.com",
  );
  const openaiBaseUrl = rawBase.endsWith("/v1") ? rawBase : `${rawBase}/v1`;
  const parsedTurns = Number.parseInt(variables.get("max_turns") || "10", 10);

  return {
    openaiApiKey: variables.get("openai_api_key") ?? "",
    openaiBaseUrl,
    model: variables.get("model") || "gpt-5",
    tsSandboxUrl: trimTrailingSlash(
      variables.get("ts_sandbox_url") || "http://ts-sandbox.spin.internal",
    ),
    accessToken: (variables.get("access_token") ?? "").trim(),
    logLevel: variables.get("log_level") || "info",
    maxTurns:
      Number.isFinite(parsedTurns) && parsedTurns > 0
        ? Math.min(parsedTurns, 20)
        : 10,
  };
}

/** The hosts model-written code may reach, enforced by the sandbox guard. */
export const SANDBOX_ALLOWED_HOSTS = [
  "https://api.github.com",
  "https://raw.githubusercontent.com",
] as const;
