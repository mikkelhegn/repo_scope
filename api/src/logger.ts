import * as variables from "@spinframework/spin-variables";

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
type Level = keyof typeof LEVELS;

let threshold = 2;

export function initLogger(): void {
  const raw = (variables.get("log_level") || "info").trim().toLowerCase();
  threshold = LEVELS[raw] ?? LEVELS.info;
}

function emit(level: Level, message: string): void {
  if (LEVELS[level] > threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padStart(5)} api: ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  error: (message: string) => emit("error", message),
  warn: (message: string) => emit("warn", message),
  info: (message: string) => emit("info", message),
  debug: (message: string) => emit("debug", message),
  trace: (message: string) => emit("trace", message),
};
