import { exec } from "child_process";
import { assertAlias } from "../utils/validators.js";
import { listAccountAliases, readTokens, writeTokens } from "./token-store.js";
import { buildAuthUrlWithRedirect, createOAuthClient, exchangeCodeForTokens } from "./oauth-client.js";
import { startCallbackServer } from "./local-callback-server.js";
import { google } from "googleapis";
import { AppError } from "../utils/errors.js";

/** Opens a URL in the system default browser — cross-platform, non-blocking. */
function openBrowser(url) {
  const p = process.platform;
  const cmd =
    p === "win32" ? `start "" "${url}"` :
    p === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd); // fire-and-forget; errors are intentionally ignored
}

const pendingAuthorizations = new Map();

/**
 * Per MCP scope: multiple Gmail accounts can be connected in the same chat.
 * `activeAlias` is the default for tools that omit accountAlias (usually the most recently completed connect).
 */
const sessionBindings = new Map();

export async function listAccounts() {
  return listAccountAliases();
}

export async function getOAuthClientForAlias(alias) {
  const safeAlias = assertAlias(alias);
  const oauth2Client = await createOAuthClient();
  const tokens = await readTokens(safeAlias);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

export async function fetchEmailAddressForAlias(alias) {
  const safeAlias = assertAlias(alias);
  const oauth2Client = await getOAuthClientForAlias(safeAlias);
  return fetchAuthenticatedEmail(oauth2Client);
}

function isBindingBucket(value) {
  return value && typeof value === "object" && value.bindings instanceof Map;
}

/** Normalize legacy single-binding storage to { activeAlias, bindings }. */
function ensureBindingBucket(sessionKey) {
  const raw = sessionBindings.get(sessionKey);
  if (!raw) return null;
  if (isBindingBucket(raw)) return raw;
  const bucket = {
    activeAlias: raw.alias,
    bindings: new Map([[raw.alias, { ...raw }]])
  };
  sessionBindings.set(sessionKey, bucket);
  return bucket;
}

function putBindingInScope(sessionKey, binding) {
  let bucket = ensureBindingBucket(sessionKey);
  if (!bucket) {
    bucket = { activeAlias: binding.alias, bindings: new Map() };
  }
  bucket.bindings.set(binding.alias, {
    alias: binding.alias,
    email: binding.email,
    type: binding.type,
    suggestedChatTitle: binding.suggestedChatTitle ?? binding.email
  });
  bucket.activeAlias = binding.alias;
  sessionBindings.set(sessionKey, bucket);
}

/**
 * Resolves which Gmail account to use: optional explicit alias (from accounts) or session binding.
 */
export async function resolveActiveBinding(scopeKey, accountAlias) {
  const trimmedAlias =
    typeof accountAlias === "string" && accountAlias.trim() ? accountAlias.trim() : "";

  if (trimmedAlias) {
    const safe = assertAlias(trimmedAlias);
    await readTokens(safe);
    const email = await fetchEmailAddressForAlias(safe);
    return {
      alias: safe,
      email,
      suggestedChatTitle: email,
      bindingSource: "accountAlias",
      scopeKeyUsed: scopeKey
    };
  }

  const binding = getScopedBinding(scopeKey);
  if (!binding) {
    throw new AppError(
      'No active connected email for this scope. Run connect + connect_finish, or pass accountAlias from accounts, or set env GMAIL_MCP_SCOPE_KEY, or pass the same chatScope on every tool when you use multiple UI chats against one MCP session.',
      "NO_ACTIVE_CONNECTION",
      400
    );
  }

  return {
    ...binding,
    bindingSource: "session",
    scopeKeyUsed: scopeKey
  };
}

function normalizeSessionKey(sessionId) {
  return sessionId || "default";
}

function sanitizeEmailForAlias(email) {
  // Preserve "@" as "_at_" so foo.bar@gmail.com and foo_bar@gmail.com don't collide
  return email.toLowerCase().replace(/@/, "_at_").replace(/[^a-z0-9_-]/g, "_");
}

function parseConnectCommand(command) {
  const match = String(command || "")
    .trim()
    .match(/^connect\s+([^\s]+)\s+(work|personal)$/i);

  if (!match) {
    throw new AppError(
      'Command must match: "Connect <email> work" or "Connect <email> personal"',
      "VALIDATION_ERROR",
      400
    );
  }

  const email = match[1].toLowerCase();
  const type = match[2].toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError("Invalid email format in connect command", "VALIDATION_ERROR", 400);
  }

  return { email, type };
}

function pendingKeyFor(sessionKey, alias) {
  return `${sessionKey}::${assertAlias(alias)}`;
}

function assertNoOtherPendingConnect(sessionKey, thisPendingKey) {
  const prefix = `${sessionKey}::`;
  for (const key of pendingAuthorizations.keys()) {
    if (key.startsWith(prefix) && key !== thisPendingKey) {
      throw new AppError(
        "Another account login is already in progress in this chat. Call connect_finish for that account first (use the alias returned by connect, in pendingAlias if needed).",
        "PENDING_CONNECT_IN_PROGRESS",
        409
      );
    }
  }
}

export async function beginScopedAuthorization(command, sessionId) {
  const { email, type } = parseConnectCommand(command);
  const sessionKey = normalizeSessionKey(sessionId);
  const alias = `${type}_${sanitizeEmailForAlias(email)}`;
  const pendingKey = pendingKeyFor(sessionKey, alias);

  assertNoOtherPendingConnect(sessionKey, pendingKey);

  const existing = pendingAuthorizations.get(pendingKey);
  if (existing?.shutdown) existing.shutdown();

  const { redirectUri, codePromise, shutdown } = await startCallbackServer();

  let oauth2Client;
  let authUrl;
  try {
    oauth2Client = await createOAuthClient();
    authUrl = buildAuthUrlWithRedirect(oauth2Client, redirectUri);
  } catch (err) {
    shutdown();
    throw err;
  }

  openBrowser(authUrl);

  pendingAuthorizations.set(pendingKey, {
    email,
    type,
    alias,
    redirectUri,
    codePromise,
    shutdown
  });

  return {
    email,
    type,
    alias,
    pendingAlias: alias,
    authUrl
  };
}

async function fetchAuthenticatedEmail(oauth2Client) {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return String(profile?.data?.emailAddress || "").toLowerCase();
}

function resolvePendingAuthorizationKey(sessionKey, pendingAlias) {
  const prefix = `${sessionKey}::`;
  if (pendingAlias && String(pendingAlias).trim()) {
    const safe = assertAlias(String(pendingAlias).trim());
    const key = pendingKeyFor(sessionKey, safe);
    if (!pendingAuthorizations.has(key)) {
      throw new AppError(
        "No in-progress connect for that pendingAlias. Run connect for this account first, then complete it before starting another.",
        "NO_PENDING_CONNECTION",
        400
      );
    }
    return key;
  }
  const matches = [...pendingAuthorizations.keys()].filter((k) => k.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new AppError(
      "Multiple logins are in progress for this chat. Pass pendingAlias (the alias field from connect).",
      "AMBIGUOUS_PENDING",
      400
    );
  }
  return matches[0];
}

/**
 * Completes the OAuth flow started by beginScopedAuthorization.
 *
 * @param {string | undefined} code - Optional when using loopback capture.
 * @param {string} sessionId - Same scope key as connect (session / chatScope / default).
 * @param {string | undefined} pendingAlias - Same as `alias` from connect; omit if only one connect is in flight.
 */
export async function completeScopedAuthorization(code, sessionId, pendingAlias) {
  const sessionKey = normalizeSessionKey(sessionId);
  const pendingKey = resolvePendingAuthorizationKey(sessionKey, pendingAlias);

  if (!pendingKey) {
    throw new AppError(
      "No pending connection. Run connect first.",
      "NO_PENDING_CONNECTION",
      400
    );
  }

  const pending = pendingAuthorizations.get(pendingKey);

  if (!pending) {
    throw new AppError(
      "No pending connection. Run connect first.",
      "NO_PENDING_CONNECTION",
      400
    );
  }

  let authCode = code && code.trim() ? code.trim() : null;
  if (!authCode) {
    if (!pending.codePromise) {
      throw new AppError(
        "No authorization code provided and no automatic capture is available. Pass the code explicitly.",
        "NO_AUTH_CODE",
        400
      );
    }
    authCode = await pending.codePromise;
  }

  if (pending.shutdown) pending.shutdown();

  const oauth2Client = await createOAuthClient();
  const tokens = await exchangeCodeForTokens(oauth2Client, authCode, pending.redirectUri);
  oauth2Client.setCredentials(tokens);

  const authenticatedEmail = await fetchAuthenticatedEmail(oauth2Client);
  if (authenticatedEmail !== pending.email) {
    throw new AppError(
      `Authorized email "${authenticatedEmail}" does not match requested "${pending.email}"`,
      "EMAIL_MISMATCH",
      400
    );
  }

  await writeTokens(pending.alias, tokens);
  pendingAuthorizations.delete(pendingKey);

  const binding = {
    alias: pending.alias,
    email: pending.email,
    type: pending.type,
    suggestedChatTitle: pending.email
  };
  putBindingInScope(sessionKey, binding);
  return binding;
}

export function getScopedBinding(sessionId) {
  const sessionKey = normalizeSessionKey(sessionId);
  const bucket = ensureBindingBucket(sessionKey);
  if (!bucket) return null;
  return bucket.bindings.get(bucket.activeAlias) || null;
}

/** All accounts bound in this chat scope (for the same MCP session key). */
export function listSessionBindings(sessionId) {
  const sessionKey = normalizeSessionKey(sessionId);
  const bucket = ensureBindingBucket(sessionKey);
  if (!bucket) return [];
  return [...bucket.bindings.values()].map((b) => ({
    alias: b.alias,
    email: b.email,
    type: b.type
  }));
}
