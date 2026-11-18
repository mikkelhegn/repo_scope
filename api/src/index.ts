import { Hono } from "hono";
import { fire } from "hono/service-worker";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

import { runAgent, type Emit } from "./agent";
import { loadConfig } from "./config";
import { initLogger, log } from "./logger";

const AUTH_COOKIE = "reposcope_token";

const app = new Hono();

app.use(async (c: Context, next) => {
  initLogger();
  c.header("server", "reposcope");
  await next();
});

// Only this origin's own pages may call the API. Browsers send Origin on
// cross-origin requests and on same-origin writes, so this stops other sites
// from driving the model, whether or not the access gate is on.
app.use("/api/*", async (c: Context, next) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && !isSameHost(origin, c.req.url)) {
    return c.json({ error: "forbidden" }, 403);
  }
  return next();
});

// If access_token is set, every /api route except health/auth needs the gate
// cookie set by POST /api/auth. An empty token disables the gate (local dev).
app.use("/api/*", async (c: Context, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/health" || path === "/api/auth") return next();

  const token = loadConfig().accessToken;
  if (token && getCookie(c, AUTH_COOKIE) !== token) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

function isSameHost(origin: string, requestUrl: string): boolean {
  try {
    // Compare hosts, not schemes: behind a TLS-terminating proxy the request
    // URL can be http even though the browser is on https.
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

function isHttps(c: Context): boolean {
  return (
    new URL(c.req.url).protocol === "https:" ||
    c.req.header("x-forwarded-proto") === "https"
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

app.get("/api/health", (c: Context) => {
  const config = loadConfig();
  const authRequired = config.accessToken !== "";
  return c.json({
    ok: true,
    provider: "openai",
    model: config.model,
    sandbox: "ts-sandbox",
    authRequired,
    authed:
      !authRequired || getCookie(c, AUTH_COOKIE) === config.accessToken,
  });
});

// Validate the shared access token and, on success, set the HttpOnly gate cookie.
app.post("/api/auth", async (c: Context) => {
  const config = loadConfig();
  if (!config.accessToken) return c.json({ ok: true });

  let given = "";
  try {
    const body = await c.req.json<{ token?: unknown }>();
    if (typeof body.token === "string") given = body.token.trim();
  } catch {
    // fall through to 401
  }

  if (given && constantTimeEqual(given, config.accessToken)) {
    setCookie(c, AUTH_COOKIE, config.accessToken, {
      path: "/",
      httpOnly: true,
      secure: isHttps(c),
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.json({ ok: true });
  }
  return c.json({ ok: false, error: "invalid access token" }, 401);
});

app.post("/api/chat", async (c: Context) => {
  const config = loadConfig();

  if (!config.openaiApiKey) {
    return c.json(
      {
        error:
          "OPENAI_API_KEY is not configured. Set SPIN_VARIABLE_OPENAI_API_KEY=sk-... and restart the app.",
      },
      503,
    );
  }

  let prompt = "";
  let history: unknown;
  try {
    const body = await c.req.json<{ prompt?: unknown; history?: unknown }>();
    if (typeof body.prompt === "string") prompt = body.prompt.trim();
    history = body.history;
  } catch {
    return c.json({ error: "expected a JSON body { prompt: string }" }, 400);
  }

  if (!prompt) return c.json({ error: "prompt is required" }, 400);
  if (prompt.length > 12_000) {
    return c.json({ error: "prompt is too long (limit 12000 characters)" }, 400);
  }

  if (!config.accessToken) {
    log.warn(
      "access_token is empty: anyone who can reach this app can spend the model key",
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (event) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        await runAgent({ config, prompt, history, emit });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `agent error: ${error instanceof Error ? (error.stack ?? error.message) : message}`,
        );
        emit({ t: "error", error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
});

// Hono's service-worker adapter: export the wasi:http handler.
fire(app, { fetch: undefined });
