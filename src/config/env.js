import { fileURLToPath } from "url";
import path from "path";

// MCP clients (e.g. Claude Desktop) often spawn the server without setting cwd;
// resolving from the repo root avoids paths like "/accounts".
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function resolveFromProjectRoot(maybeRelative) {
  if (path.isAbsolute(maybeRelative)) return maybeRelative;
  return path.resolve(PROJECT_ROOT, maybeRelative);
}

const CONFIG = {
  GOOGLE_CREDENTIALS_PATH: "./credentials.json",
  ACCOUNTS_DIR: "./accounts",
  DEFAULT_GMAIL_USER_ID: "me",
  GMAIL_REVIEW_MARKDOWN_DIR: null,
  GMAIL_REVIEW_MARKDOWN_FILENAME: "latest-inbox-review.md",
  LOG_LEVEL: "info",
  FOLLOWUP_REMINDERS_PATH: null,
  FOLLOWUP_CHECK_INTERVAL_MS: 60_000,
  GMAIL_MCP_SCOPE_KEY: "",
  FOLLOW_UP_GMAIL_LABEL_NAME: "Follow-up",
  FOLLOW_UP_GMAIL_LABEL_ENABLED: true,
  GMAIL_REVIEW_GMAIL_LABEL_NAME: "Inbox-review",
  GMAIL_REVIEW_GMAIL_LABEL_ENABLED: false
};

export const FOLLOWUP_DATA_DIR = path.join(PROJECT_ROOT, "data");

export const env = {
  PROJECT_ROOT,
  FOLLOWUP_DATA_DIR,
  GOOGLE_CREDENTIALS_PATH: resolveFromProjectRoot(CONFIG.GOOGLE_CREDENTIALS_PATH),
  ACCOUNTS_DIR: resolveFromProjectRoot(CONFIG.ACCOUNTS_DIR),
  DEFAULT_GMAIL_USER_ID: CONFIG.DEFAULT_GMAIL_USER_ID,
  GMAIL_REVIEW_MARKDOWN_DIR: CONFIG.GMAIL_REVIEW_MARKDOWN_DIR
    ? resolveFromProjectRoot(CONFIG.GMAIL_REVIEW_MARKDOWN_DIR)
    : path.join(FOLLOWUP_DATA_DIR, "inbox-reviews"),
  /**
   * Single filename (no path); this file is **overwritten** on every successful fetch with drafts.
   */
  GMAIL_REVIEW_MARKDOWN_FILENAME: (() => {
    const raw = String(CONFIG.GMAIL_REVIEW_MARKDOWN_FILENAME).trim();
    const base = path.basename(raw.replace(/\\/g, "/"));
    if (!base || base === "." || base === "..") return "latest-inbox-review.md";
    return /\.md$/i.test(base) ? base : `${base}.md`;
  })(),
  LOG_LEVEL: CONFIG.LOG_LEVEL,
  FOLLOWUP_REMINDERS_PATH: CONFIG.FOLLOWUP_REMINDERS_PATH
    ? resolveFromProjectRoot(CONFIG.FOLLOWUP_REMINDERS_PATH)
    : path.join(FOLLOWUP_DATA_DIR, "followup-reminders.json"),
  FOLLOWUP_CHECK_INTERVAL_MS:
    Number.isFinite(Number(CONFIG.FOLLOWUP_CHECK_INTERVAL_MS)) && Number(CONFIG.FOLLOWUP_CHECK_INTERVAL_MS) >= 10_000
      ? Math.floor(Number(CONFIG.FOLLOWUP_CHECK_INTERVAL_MS))
      : 60_000,
  /** Namespaces in-memory OAuth bindings when the MCP client does not send a per-chat session id (stdio). */
  GMAIL_MCP_SCOPE_KEY: String(CONFIG.GMAIL_MCP_SCOPE_KEY).trim(),

  /** User label applied to the source message when a follow-up reminder is created (visible in Gmail sidebar). */
  FOLLOW_UP_GMAIL_LABEL_NAME: String(CONFIG.FOLLOW_UP_GMAIL_LABEL_NAME).trim() || "Follow-up",
  FOLLOW_UP_GMAIL_LABEL_ENABLED: Boolean(CONFIG.FOLLOW_UP_GMAIL_LABEL_ENABLED),

  /**
   * User label applied to each message in an MCP inbox batch (`fetch`) so threads show under Labels in Gmail.
   * Removed from the source message after a successful `send`.
   */
  GMAIL_REVIEW_GMAIL_LABEL_NAME: String(CONFIG.GMAIL_REVIEW_GMAIL_LABEL_NAME).trim() || "Inbox-review",
  GMAIL_REVIEW_GMAIL_LABEL_ENABLED: Boolean(CONFIG.GMAIL_REVIEW_GMAIL_LABEL_ENABLED)
};
