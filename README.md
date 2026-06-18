# multi-gmail-mcp

Multi-account Gmail MCP server for Claude Desktop, Cursor, and other MCP hosts.

It lets your assistant:
- connect one or more Gmail accounts
- scan the inbox with lightweight **list** mode (metadata only)
- load **one full thread at a time** with `get_thread` (plain or quote-stripped bodies)
- draft replies from real message text (not Gmail snippets)
- send **replies** (`send`) or **new outbound** mail (`send_new`), including HTML bodies
- save drafts to Gmail
- send only after explicit approval
- manage follow-up reminders for email threads

**Safety rule:** nothing is ever sent automatically. `send`, `send_new`, and `followup_send` must only be called after human approval.

---

## What This MCP Does

This server is **thread-first**, not message-first, and **metadata-first** for inbox triage.

- `multi_gmail_fetch` with **`mode=list`** (default) returns small per-thread metadata — snippets are **not** full emails
- for each thread you care about, call **`multi_gmail_get_thread` once** — never load many full threads in one LLM context
- `multi_gmail_get_thread` returns a chronological transcript (`format`, `stripped`, `latestN`)
- `multi_gmail_send` sends an approved **reply** (`messageId` required); **`multi_gmail_send_new`** starts a **new thread** (standalone outbound mail)
- outbound tools support **`format`**: `text/plain` (default) or `text/html` (pricing tables, CTAs)
- legacy `mode=full` on fetch still batch-loads and auto-drafts (token-heavy — avoid for normal inbox review)
- `multi_gmail_followup_due` refreshes the thread before showing a due follow-up

This project is designed for setups where one person may handle:
- multiple Gmail accounts
- multiple chats against one MCP server session
- inbox review plus follow-up workflows in the same toolset

---

## Requirements

- Node.js `18+`
- a Gmail account
- Claude Desktop, Cursor, or another MCP-compatible host
- a Google Cloud project with Gmail API enabled

Check Node:

```bash
node --version
```

---

## Install

```bash
npm install -g @nitsantechnologies/multi-gmail-mcp
mkdir -p ~/.multi-gmail-mcp
```

Set this env var anywhere you run the server or auth command:

```bash
export MULTI_GMAIL_MCP_HOME="$HOME/.multi-gmail-mcp"
```

Useful commands:

```bash
multi-gmail-mcp
multi-gmail-mcp-auth
```

Local development from git still works:

```bash
git clone https://github.com/nitsan-ai/Multi-Gmail-MCP.git
cd Multi-Gmail-MCP
npm install
npm start
npm run auth
```

---

## Google OAuth Setup

1. Open [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project
3. Enable **Gmail API**
4. Go to **APIs & Services -> Credentials**
5. Create **OAuth client ID**
6. Choose **Desktop app**
7. Download the JSON file
8. Save it in your config home as:

```text
~/.multi-gmail-mcp/credentials.json
```

Set a different location with `MULTI_GMAIL_MCP_HOME`. For local git development, project root still works by default.

OAuth scopes used by this MCP:
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.settings.basic` (Gmail signature on send/draft)

**After upgrading:** re-authenticate every connected account once so tokens include `gmail.settings.basic` (required for automatic signature appending on `send`, `set_draft`, and `followup_send`):

```bash
MULTI_GMAIL_MCP_HOME="$HOME/.multi-gmail-mcp" multi-gmail-mcp-auth --alias <your-alias>
```

Then reconnect in your MCP client (`connect` + `connect_finish`).

---

## Local Account Auth

Authenticate the first Gmail account:

```bash
MULTI_GMAIL_MCP_HOME="$HOME/.multi-gmail-mcp" multi-gmail-mcp-auth
```

Add another account with an alias:

```bash
MULTI_GMAIL_MCP_HOME="$HOME/.multi-gmail-mcp" multi-gmail-mcp-auth --alias work
```

Notes:
- token files are saved under `$MULTI_GMAIL_MCP_HOME/accounts/`
- each alias gets its own token JSON
- `--account` is accepted as a synonym for `--alias`

---

## Connect to Claude Desktop

Edit:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Example:

```json
{
  "mcpServers": {
    "multi-gmail-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@nitsantechnologies/multi-gmail-mcp"
      ],
      "env": {
        "MULTI_GMAIL_MCP_HOME": "/Users/you/.multi-gmail-mcp"
      }
    }
  }
}
```

Replace `/Users/you/.multi-gmail-mcp` with your real path.

After saving:
- fully quit Claude Desktop
- reopen Claude Desktop

---

## Connect to Cursor

Open **Cursor Settings -> MCP -> Add server** and use:

```json
{
  "multi-gmail-mcp": {
    "command": "npx",
    "args": [
      "-y",
      "@nitsantechnologies/multi-gmail-mcp"
    ],
    "env": {
      "MULTI_GMAIL_MCP_HOME": "/Users/you/.multi-gmail-mcp"
    }
  }
}
```

Replace `/Users/you/.multi-gmail-mcp` with your real path.

---

## First-Time Flow Inside Claude or Cursor

Run this once per account:

1. `multi_gmail_status`
2. `multi_gmail_connect` with `Connect you@example.com personal`
3. `multi_gmail_connect_finish`
4. `multi_gmail_set_signer`
5. `multi_gmail_fetch` with `mode="list"`
6. `multi_gmail_get_thread` for each thread you will read or reply to
7. review drafts
8. use `multi_gmail_send` (reply) or `multi_gmail_send_new` (new outbound) only after approval

Typical signer example:

```text
Set signer name to Jane Smith
```

---

## Daily Workflow

### Recommended inbox review (list → one thread at a time)

Ask:

```text
Fetch my inbox with mode list, then get_thread for threads I need to reply to
```

**Step 1 — triage (small payload):**

```json
{ "mode": "list", "maxResults": 10 }
```

You get per thread: `threadId`, `latestMessageId`, subject, participants, date, direction, **snippet** (preview only).

**Step 2 — full bodies (one thread per call):**

```json
{
  "threadId": "<from fetch>",
  "format": "full",
  "stripped": false
}
```

- `stripped=false` (default) — full plain-text body per message (best for reading mail)
- `stripped=true` — quote/signature-stripped text (best when drafting in long threads)
- `format=latest` + `latestN` — first message + last N messages, with omission markers

Present `message.text` **verbatim** to the user — do not summarize snippets or bodies.

**Step 3 — draft and send:**

- Reply in an existing thread → `multi_gmail_send` with `messageId` from fetch / `get_thread`
- New outbound email → `multi_gmail_send_new` (no `messageId`)

Optional: `mode=full` on fetch still auto-drafts every thread in one batch (legacy; can cause token overflow).

With `mode=list`, follow-up-labeled threads are excluded from normal inbox review. Optional markdown export is written unless `writeMarkdownFile: false`. Nothing is sent until you approve.

After review, per item you can:
- `send` or `send_new`
- `set_draft`
- `edit`
- `cancel` / `skip`

### Follow-up review

Ask:

```text
Show due follow-ups
```

What happens:
- due reminders are loaded
- the thread is refreshed from Gmail first
- if the recipient already replied, the reminder is resolved automatically
- otherwise a fresh follow-up draft is shown

---

## Tool Reference

The MCP registers both prefixed and unprefixed names:
- `multi_gmail_fetch` and `fetch`
- `multi_gmail_followup_due` and `followup_due`
- etc.

In practice, most hosts will show the `multi_gmail_*` names.

### Setup and status tools

#### `multi_gmail_help`
Shows the first-time setup flow.

Input: none

#### `multi_gmail_status`
Shows:
- connected account
- signer status
- due follow-ups
- last inbox batch
- useful local paths

Input:
- `accountAlias` optional
- `chatScope` optional

#### `multi_gmail_connect`
Starts Gmail login for one account and opens the browser.

Input:
- `command` required

Format:

```text
Connect you@example.com personal
Connect you@example.com work
```

#### `multi_gmail_connect_finish`
Completes the login started by `connect`.

Input:
- `code` optional
- `pendingAlias` optional
- `chatScope` optional

Normally you do not need to paste the code manually; the local callback server completes it.

#### `multi_gmail_accounts`
Lists all saved local account aliases.

Input: none

#### `multi_gmail_set_signer`
Stores the display name used in draft replies for the current session.

Input:
- `name` required
- `followUpLabel` optional
- `accountAlias` optional
- `chatScope` optional

#### `multi_gmail_set_mode`
Switches response mode for the current chat scope.

Input:
- `mode` required: `standard` or `compact`

#### `multi_gmail_diagnostics`
Checks:
- credentials file
- accounts directory
- reminder store
- active account binding

Input:
- `accountAlias` optional
- `chatScope` optional

#### `multi_gmail_setup_labels`
Ensures the configured Gmail labels exist.

Useful if labels do not appear after connect or fetch.

Input:
- `accountAlias` optional
- `chatScope` optional

---

### Inbox and thread tools

#### `multi_gmail_fetch`
Lists inbox threads for triage, or (legacy) batch-loads full threads and auto-drafts replies.

**Recommended:** `mode=list` (default), then `get_thread` per selected thread.

| `mode` | Behavior |
|--------|----------|
| `list` (default) | Metadata only: `threadId`, `latestMessageId`, subject, participants, snippet, dates, direction. Snippets are **not** full emails. |
| `full` | Legacy: loads full bodies and drafts every thread in one call — **token-heavy**; avoid for normal inbox review. |

Important behavior:
- `maxResults` means **unique inbox threads**
- `list` returns `messageId` / `threadId` for `send` and `get_thread`
- `includeLatestBody` (list only): optional latest-message plain body per thread, capped at 15 threads — still prefer `get_thread` for one thread
- Response includes `gmailListQuery` — the exact Gmail `q` string sent to the API

| `queryMode` | Behavior |
|-------------|----------|
| `inbox` (default) | Prepends inbox review filters (`in:inbox`, excludes follow-up label) |
| `raw` | Passes `query` directly to Gmail — use for sent mail, archives, all-mail, date filters |

Input:
- `mode` optional: `list` or `full`, default `list`
- `maxResults` optional, default `20`, max `100`
- `query` optional Gmail search string (combined with inbox filters when `queryMode=inbox`)
- `queryMode` optional: `inbox` or `raw`, default `inbox`
- `includeLatestBody` optional, default `false` (list mode only)
- `saveGmailDrafts` optional, default `false` (mainly `full` mode)
- `writeMarkdownFile` optional, default `true` (`full` mode / review export)
- `accountAlias` optional
- `chatScope` optional

Examples:

```json
{
  "mode": "list",
  "maxResults": 10
}
```

```json
{
  "mode": "list",
  "maxResults": 15,
  "query": "newer_than:7d"
}
```

Sent-mail / historical analysis (raw Gmail query):

```json
{
  "mode": "list",
  "queryMode": "raw",
  "query": "in:sent after:2026/01/01 before:2026/04/01",
  "maxResults": 50
}
```

Legacy batch mode (avoid for daily triage):

```json
{
  "mode": "full",
  "maxResults": 5,
  "writeMarkdownFile": false
}
```

#### `multi_gmail_send`
Sends one approved **reply** in an existing thread. Marks the source message read and returns IDs for follow-up threading.

For **new outbound** mail (no source message), use `multi_gmail_send_new` instead.

Input:
- `messageId` required — from `fetch` or `get_thread`
- `to` required
- `subject` required
- `body` required unless legacy `html` is set
- `format` optional: `text/plain` (default) or `text/html` — when `text/html`, `body` is the HTML part (plain part auto-generated)
- `html` optional — legacy HTML part (prefer `format` + `body`)
- `cc` / `bcc` optional — single email, comma-separated string, array, or `Name <email@example.com>` (multiple recipients)
- `quoteOriginal` optional, default `true` — append Gmail-style quoted parent history below your new body (`false` = new body only)
- `accountAlias` optional
- `chatScope` optional

Response includes: `sentMessageId`, `threadId`, `isNewThread: false`, `markedReadMessageId`.

Example (plain reply):

```json
{
  "messageId": "19e90840fbfd1961",
  "to": "recipient@example.com",
  "subject": "Re: Pricing",
  "body": "Thanks — here is the updated quote."
}
```

#### `multi_gmail_send_new`
Sends one approved **new** email. Use for standalone outbound mail or follow-ups in the same thread.

Input:
- `to` required
- `threadId` optional — from a prior `send_new` response; adds this message to that Gmail thread (follow-up in same thread)
- `subject` required — Unicode (–, ü, €, etc.) is RFC 2047–encoded automatically
- `body` required unless legacy `htmlBody` is set
- `format` optional: `text/plain` (default) or `text/html`
- `htmlBody` optional — legacy HTML (prefer `format` + `body`)
- `cc` optional
- `bcc` optional
- `accountAlias` optional
- `chatScope` optional

Response includes: `sentMessageId`, `threadId`, `isNewThread: true` — store `threadId` for phase-2 threading.

Example (HTML outbound):

```json
{
  "to": "recipient@example.com",
  "subject": "Product — pricing overview",
  "format": "text/html",
  "body": "<h1>Hello</h1><p>See the <a href=\"https://example.com/pricing\">pricing table</a>.</p>"
}
```

#### `multi_gmail_set_draft`
Creates or updates a Gmail draft reply without sending.

Input:
- `messageId` required
- `to` required
- `subject` required
- `body` required unless legacy `html` is set
- `format` optional: `text/plain` (default) or `text/html`
- `html` optional — legacy HTML part
- `cc` / `bcc` optional — comma-separated string, array, or `Name <email@example.com>`
- `quoteOriginal` optional, default `true` — append quoted parent history (Gmail `···` expander)
- `accountAlias` optional
- `chatScope` optional

#### `multi_gmail_get_thread`
Loads **one** Gmail thread as an ordered transcript. Call after `fetch` `mode=list` when you need real message bodies.

| `format` | Behavior |
|--------|----------|
| `full` (default) | All messages with bodies |
| `latest` | First message + latest `latestN` messages; middle messages collapsed with `[N earlier messages omitted]` |
| `metadata` | Headers/dates only — no bodies |

Body options (when `format` is not `metadata`):
- `stripped` default `false` — full plain-text per message
- `stripped=true` — removes quoted reply history and signatures (drafting in long threads)
- `includeRaw=true` — adds `rawText` alongside stripped `text` for debugging

Input:
- `threadId` required — from `fetch`, `followup_due`, or `archive`
- `format` optional: `metadata`, `latest`, or `full` (default `full`)
- `latestN` optional, default `5`, max `50` (when `format=latest`)
- `stripped` optional, default `false`
- `includeRaw` optional, default `false`
- `accountAlias` optional
- `chatScope` optional

Example (read full mail):

```json
{
  "threadId": "19e913bf5e640ea2",
  "format": "full",
  "stripped": false
}
```

Example (draft in a long thread):

```json
{
  "threadId": "19e913bf5e640ea2",
  "format": "full",
  "stripped": true
}
```

#### `multi_gmail_archive`
Archives one thread by removing the `INBOX` label.

Input:
- `threadId` required
- `accountAlias` optional
- `chatScope` optional

#### `multi_gmail_fetch_drafts`
Lists messages in Gmail Drafts.

Input:
- `maxResults` optional
- `accountAlias` optional
- `chatScope` optional

#### `multi_gmail_fetch_sent` (deprecated)
Lists the latest messages in Gmail Sent without query filters.

**Prefer** `multi_gmail_fetch` with `queryMode=raw` and a Gmail query such as `in:sent after:2026/01/01 before:2026/04/01` for filtered sent-mail and historical analysis.

Input:
- `maxResults` optional
- `accountAlias` optional
- `chatScope` optional

---

### Follow-up tools

#### `multi_gmail_followup_trigger`
Creates a new follow-up plan for a thread, or updates the existing open plan for that same thread.

Input:
- `messageId` required
- `pattern` optional
- `daysList` optional
- `businessDaysOnly` optional, default `false`
- `dueWeekday` optional
- `createGmailDraft` optional, default `false`
- `accountAlias` optional
- `chatScope` optional

Rules:
- use either `pattern` or `daysList`
- not both
- `daysList` must be ascending
- duplicates are not allowed

Examples:

```json
{
  "messageId": "gmail-message-id",
  "daysList": [1, 3]
}
```

```json
{
  "messageId": "gmail-message-id",
  "pattern": "1, 3, 7 business days",
  "businessDaysOnly": true
}
```

Scheduling behavior:
- first entry is due from now
- later entries are **chained**
- example: `[1, 3]` means:
  - follow-up 1 in 1 day
  - follow-up 2 in 3 days **after follow-up 1 is sent**

#### `multi_gmail_followup_due`
Lists due follow-up reminders for the active account.

Behavior:
- refreshes the thread before returning results
- includes full `threadContext`
- skips reminders if the recipient already replied

Input:
- `accountAlias` optional
- `chatScope` optional

#### `multi_gmail_followup_send`
Sends one approved follow-up email.

Input:
- `reminderId` required
- `to` optional
- `subject` optional
- `body` optional (unless legacy `html` is set)
- `format` optional: `text/plain` (default) or `text/html`
- `html` optional — legacy HTML part
- `cc` / `bcc` optional — comma-separated string, array, or `Name <email@example.com>`
- `quoteOriginal` optional, default `true` — append quoted parent history below the follow-up body
- `accountAlias` optional
- `chatScope` optional

Only use this after the user explicitly approves the draft.

#### `multi_gmail_followup_cleanup`
Deletes follow-up reminder records from the local store.

Input filters:
- `reminderIds`
- `messageId` for Gmail internal message id
- `messageHeaderId` for RFC `Message-ID` from Gmail **Show original**
- `sourceThreadId`
- `followUpChainId`
- `deleteAll` with `confirm: true`
- `statuses`
- `cancelChain`
- `removeGmailLabel`
- `accountAlias`
- `chatScope`

Examples:

Delete by RFC `Message-ID`:

```json
{
  "messageHeaderId": "<abc123@example.com>"
}
```

Delete one chain:

```json
{
  "reminderIds": ["reminder-id"],
  "cancelChain": true
}
```

Delete all reminders for an account:

```json
{
  "deleteAll": true,
  "confirm": true
}
```

---

## Multiple Accounts and Shared Sessions

### `accountAlias`

Use `accountAlias` when you want to target a specific saved local account:

```json
{
  "accountAlias": "work"
}
```

### `chatScope`

Some MCP hosts reuse one server session across many chats.

In that case, pass the same `chatScope` on:
- `connect`
- `connect_finish`
- `set_signer`
- every later Gmail tool in that same chat

Example:

```json
{
  "chatScope": "work-inbox"
}
```

This keeps one chat’s active account binding separate from another chat’s.

---

## Files and Data

Important local paths under `$MULTI_GMAIL_MCP_HOME`:

- `credentials.json`
  Google OAuth client credentials
- `accounts/`
  saved Gmail OAuth tokens, one JSON file per alias
- `data/followup-reminders.json`
  local follow-up reminder store
- `data/inbox-reviews/latest-inbox-review.md`
  latest markdown inbox review export

Project layout:

```text
~/.multi-gmail-mcp/
├── credentials.json
├── accounts/
└── data/
    ├── followup-reminders.json
    └── inbox-reviews/
```

Useful env vars:

| Name | Purpose |
|------|---------|
| `MULTI_GMAIL_MCP_HOME` | base directory for credentials, tokens, and local data |
| `GOOGLE_CREDENTIALS_PATH` | absolute or config-home-relative path to OAuth credentials |
| `ACCOUNTS_DIR` | absolute or config-home-relative path to token files |
| `FOLLOWUP_REMINDERS_PATH` | absolute or config-home-relative reminder store path |
| `GMAIL_REVIEW_MARKDOWN_DIR` | absolute or config-home-relative inbox export directory |

**Dependencies** (for HTML bodies and quote stripping): `email-reply-parser`, `planer`, `jsdom`.

---

## Gmail Labels

This MCP can create Gmail user labels automatically.

Expected labels:
- `Inbox-review`
- `Multi-Gmail-MCP Follow-up`

Use `multi_gmail_setup_labels` if they do not appear.

---

## Troubleshooting

### Server not showing in Claude or Cursor

- make sure `MULTI_GMAIL_MCP_HOME` points at your real config directory
- make sure `node --version` is `18+`
- fully quit and reopen the app
- if `npx` is unavailable inside the app, install globally and use the full path to `multi-gmail-mcp`

### `multi_gmail_status` not available

Usually this means the MCP server did not start at all.

Check:
- JSON config syntax
- absolute path to the server entry
- Node availability
- app restart after config change

### Token expired or auth errors

Re-authenticate:

```bash
rm ~/.multi-gmail-mcp/accounts/*.json
MULTI_GMAIL_MCP_HOME="$HOME/.multi-gmail-mcp" multi-gmail-mcp-auth
```

### Permission or scope errors

Make sure:
- Gmail API is enabled
- OAuth client is a **Desktop app**
- scopes include `gmail.modify`, `gmail.send`, and `gmail.settings.basic`

Then re-authenticate (see **Local Account Auth** above).

### Multiple accounts not working

- run `multi_gmail_accounts`
- verify the alias exists
- re-authenticate missing accounts:

```bash
MULTI_GMAIL_MCP_HOME="$HOME/.multi-gmail-mcp" multi-gmail-mcp-auth --alias work
```

### Labels missing in Gmail

Run:

```text
multi_gmail_setup_labels
```

If that still fails, re-authenticate so the token includes `gmail.modify`.

### Setup state unclear

Run:

```text
multi_gmail_diagnostics
```

---

## Security Notes

- `credentials.json` contains your Google OAuth client secret
- `accounts/` contains Gmail refresh/access tokens
- never commit either of those paths
- `.gitignore` already excludes them
- token files are written with mode `0600`

This repository may also write:
- local reminder data
- local markdown inbox review exports

Treat those as sensitive personal data.

---

## License

MIT

---

## Company

Developed by [NITSAN Technologies](https://nitsan.ai/ "https://nitsan.ai/")
