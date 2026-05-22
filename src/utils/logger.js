import { env } from "../config/env.js";

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

function canLog(level) {
  const current = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;
  return (LEVELS[level] ?? LEVELS.info) <= current;
}

function write(level, message, meta) {
  if (!canLog(level)) return;
  const payload = meta ? ` ${JSON.stringify(meta)}` : "";
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}${payload}`;
  // MCP stdio: stdout is reserved for JSON-RPC only; never log there.
  console.error(line);
}

export const logger = {
  error: (message, meta) => write("error", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  info: (message, meta) => write("info", message, meta),
  debug: (message, meta) => write("debug", message, meta)
};
