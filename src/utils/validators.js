import { AppError } from "./errors.js";

export function assertAlias(alias) {
  if (!alias || typeof alias !== "string") {
    throw new AppError("Account alias is required", "VALIDATION_ERROR", 400);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
    throw new AppError(
      "Account alias must contain only letters, numbers, underscores, or hyphens",
      "VALIDATION_ERROR",
      400
    );
  }
  return alias;
}

export function safeNumber(input, fallback, min, max) {
  if (input === undefined || input === null || input === "") return fallback;
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.max(min, Math.min(max, parsed));
  return bounded;
}
