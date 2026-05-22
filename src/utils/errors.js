export class AppError extends Error {
  constructor(message, code = "APP_ERROR", status = 500, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const ERROR_HINTS_BY_CODE = {
  NO_ACTIVE_CONNECTION: {
    userAction: "Connect an account before running Gmail tools.",
    nextStep:
      'Run `connect` with `Connect your@email.com personal` (or `work`), then run `connect_finish`.'
  },
  NO_PENDING_CONNECTION: {
    userAction: "Start account connection before trying to complete it.",
    nextStep: "Run `connect` first, then run `connect_finish` right away."
  },
  PENDING_CONNECT_IN_PROGRESS: {
    userAction: "Finish the in-progress connection before starting another one.",
    nextStep: "Run `connect_finish` for the existing pending account first."
  },
  AMBIGUOUS_PENDING: {
    userAction: "Multiple login attempts are open for this chat.",
    nextStep: "Run `connect_finish` again and pass `pendingAlias` from `connect`."
  },
  ACCOUNT_NOT_FOUND: {
    userAction: "The selected account alias is not connected on this machine.",
    nextStep: "Run `accounts` to see available aliases, or connect the account first."
  },
  INVALID_ALIAS: {
    userAction: "The accountAlias you passed does not match any saved account.",
    nextStep: "Run `accounts` to see valid aliases, then pass one of those."
  },
  CREDENTIALS_NOT_FOUND: {
    userAction: "Google OAuth credentials file is missing.",
    nextStep:
      "Place `gcp-oauth.keys.json` in the project folder (or update credentials path), then retry."
  },
  INVALID_CREDENTIALS_FILE: {
    userAction: "Google OAuth credentials file is invalid.",
    nextStep: "Download a fresh Desktop App OAuth JSON from Google Cloud and retry."
  },
  EMAIL_MISMATCH: {
    userAction: "You authorized a different email than requested.",
    nextStep: "Run `connect` again and sign in with the exact requested email."
  },
  VALIDATION_ERROR: {
    userAction: "Fix the input parameters shown in the error message and retry.",
    nextStep: "Check the tool description for required fields and valid values, or run help for the full setup guide."
  },
  NOT_FOUND: {
    userAction: "The messageId is no longer valid (deleted, archived, or never existed).",
    nextStep: "Run fetch to get current message IDs."
  },
  FORBIDDEN: {
    userAction: "This action is blocked for the selected account.",
    nextStep: "Confirm account selection and retry with the correct `accountAlias`."
  },
  CONFLICT: {
    userAction: "This action conflicts with the current item state.",
    nextStep: "Refresh state (for example `status` or `followup_due`) and retry."
  },
  TOKEN_EXPIRED: {
    userAction: "Your Gmail authentication has expired — you need to reconnect the account.",
    nextStep: "Run `connect` with `Connect your@email.com personal` (or `work`), then `connect_finish` to re-authenticate."
  }
};

/**
 * Returns true when a raw googleapis / OAuth2 error signals that the refresh
 * token is invalid or revoked (invalid_grant, token revoked, etc.).
 */
function isInvalidGrantError(error) {
  const msg = String(error?.message || "").toLowerCase();
  const data = error?.response?.data;
  const dataError = String(data?.error || "").toLowerCase();
  return (
    msg.includes("invalid_grant") ||
    msg.includes("token has been expired or revoked") ||
    dataError === "invalid_grant"
  );
}

export function normalizeError(error) {
  if (error instanceof AppError) return error;

  // Map expired/revoked OAuth tokens to TOKEN_EXPIRED so callers get a clear
  // re-auth instruction instead of "verify setup in README troubleshooting".
  if (isInvalidGrantError(error)) {
    return new AppError(
      "Gmail authentication token is invalid or expired. Re-authenticate to continue.",
      "TOKEN_EXPIRED",
      401
    );
  }

  const message = error?.message || "Unexpected error occurred";
  return new AppError(message, "INTERNAL_ERROR", 500);
}

export function errorResponse(error) {
  const normalized = normalizeError(error);
  const hint = ERROR_HINTS_BY_CODE[normalized.code] || null;
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
      userAction: hint?.userAction || "Try again or run status for guided next steps.",
      nextStep: hint?.nextStep || "If this keeps happening, verify setup in README troubleshooting."
    }
  };
}

export function okResponse(data) {
  return {
    ok: true,
    data
  };
}
