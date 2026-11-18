/**
 * A tiny client for the Spin Code Sandbox `ts-sandbox` component.
 *
 * The sandbox exposes `POST /ts/run` with this envelope:
 *   { code, sandboxId, allowedHosts, kvEnabled }
 * and returns `{ stdout, stderr, error }` for script-shaped code.
 *
 * The sandbox is a PRIVATE component in this app. The API reaches it through
 * Spin service chaining at http://ts-sandbox.spin.internal. Model-written code
 * must never be able to pick its own sandbox id, allowed hosts, or KV policy:
 * those are application-controlled here.
 */

export interface SandboxRunOptions {
  /** Stable per-conversation namespace. KV is disabled in this app. */
  identity: string;
  /** Application-approved egress. The model cannot change this list. */
  allowedHosts: readonly string[];
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  error: string | null;
}

interface SandboxBody {
  stdout?: unknown;
  stderr?: unknown;
  error?: unknown;
  message?: unknown;
  trace?: unknown;
}

function parseJson(text: string): SandboxBody | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as SandboxBody) : null;
  } catch {
    return null;
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const ctor = AbortSignal as unknown as {
    timeout?: (milliseconds: number) => AbortSignal;
  };
  try {
    return typeof ctor.timeout === "function" ? ctor.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

function detailOf(body: SandboxBody | null, fallback: string): string {
  const detail = body?.message ?? body?.error ?? body?.trace ?? fallback;
  return String(detail).slice(0, 2_000);
}

export class SandboxClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async run(code: string, options: SandboxRunOptions): Promise<SandboxRunResult> {
    // The sandbox does not enforce a wall-clock limit of its own. Abort the HTTP
    // request so a runaway program does not hold the chat request forever. The
    // underlying Wasm instance may continue until the platform reaps it.
    const signal = timeoutSignal(90_000);

    const response = await fetch(`${this.baseUrl}/ts/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        sandboxId: options.identity,
        allowedHosts: options.allowedHosts,
        kvEnabled: false,
      }),
      ...(signal ? { signal } : {}),
    });

    const text = await response.text();
    const body = parseJson(text);

    if (!response.ok) {
      return {
        stdout: "",
        stderr: "",
        error: `sandbox ${response.status}: ${detailOf(body, text || response.statusText)}`,
      };
    }

    if (!body) {
      return {
        stdout: "",
        stderr: "",
        error: `sandbox returned a non-JSON response (${response.status}): ${text.slice(0, 2_000)}`,
      };
    }

    return {
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
      error:
        body.error === null || body.error === undefined || body.error === ""
          ? null
          : String(body.error),
    };
  }
}
