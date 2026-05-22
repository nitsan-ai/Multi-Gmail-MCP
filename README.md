# multi-gmail-mcp

Gmail MCP server for Claude Desktop and Cursor. Connects one or more Gmail accounts to your AI assistant so it can read inbox emails, draft replies, and send only what you explicitly approve.

> [!IMPORTANT]
> **Nothing is ever sent automatically. Every send requires your explicit approval.**

---

## Requirements

- Node.js v18 or higher — check with `node --version`
- A Gmail account
- Claude Desktop or Cursor (or any MCP-compatible host)
- A Google Cloud project with Gmail API enabled

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/multi-gmail-mcp.git
cd multi-gmail-mcp
npm install
```

### 2. Create Google OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. Create a new project (or select an existing one).
3. Search for **Gmail API** in the top search bar and click **Enable**.
4. Configure the **OAuth consent screen** (required before creating credentials):
   - Go to **APIs & Services → OAuth consent screen**.
   - Select **External** (or **Internal** if using a Google Workspace account and you want to restrict it to your domain) and click **Create**.
   - Fill in the required fields (App name, User support email, Developer contact email) and click **Save and Continue**.
   - Under the **Scopes** step, click **Add or Remove Scopes** and add:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/gmail.send`
   - Under the **Test users** step, click **Add Users** and add your own Gmail address. 
     > [!IMPORTANT]
     > Since your project is in "Testing" status, only the emails listed as **Test users** can authorize and log in. If you skip this, Google will block authorization with an `Access blocked: project is in testing` error.
5. Create your Client ID:
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Select **Desktop app** as the Application type.
   - Set a name (e.g., `multi-gmail-mcp`) and click **Create**.
6. Download the client secret JSON file, rename it to exactly `credentials.json`, and save it in the root folder of this project.

Required OAuth scopes (requested automatically during authorization):
- `https://www.googleapis.com/auth/gmail.readonly` — read inbox emails
- `https://www.googleapis.com/auth/gmail.modify` — read, label, and archive emails
- `https://www.googleapis.com/auth/gmail.send` — send approved emails

### 3. Authenticate your Gmail account

```bash
npm run auth
```

A browser window opens. Log in and approve access. The token is saved to `accounts/`.

> [!TIP]
> **Google hasn't verified this app warning:** During login, you will see a warning screen saying *"Google hasn't verified this app"*. This is normal because your Google Cloud project is self-managed and unverified. Click **Advanced** and then click **Go to multi-gmail-mcp (unsafe)** to proceed with the authorization.

**To add another account** (pick a short label, e.g. `work`):

```bash
npm run auth -- --alias work
```

`--account` is accepted as a synonym for `--alias`. Each account gets its own token file in `accounts/`.

### 4. Connect to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "multi-gmail-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/multi-gmail-mcp/src/index.js"]
    }
  }
}
```

Run `pwd` inside the project folder to get the absolute path. Restart Claude Desktop after saving.

### 5. Connect to Cursor

Open **Cursor Settings → MCP → Add server**:

```json
{
  "multi-gmail-mcp": {
    "command": "node",
    "args": ["/absolute/path/to/multi-gmail-mcp/src/index.js"]
  }
}
```

Restart Cursor after saving.

---

## First-time flow (inside Claude / Cursor)

Once the server is connected, run this sequence once per account:

1. `multi_gmail_status` (or `status`) — check what's currently connected and setup health.
2. `multi_gmail_connect` (or `connect`) with parameter `command` set to `"Connect you@example.com personal"` (or `"work"`) — starts browser OAuth flow.
3. `multi_gmail_connect_finish` (or `connect_finish`) — run this right after browser approval to automatically complete the login and save the token.
4. `multi_gmail_set_signer` (or `set_signer`) with parameter `name` set to your name — sets the signature appended to all draft replies.
5. `multi_gmail_fetch` (or `fetch`) — fetches inbox emails, reviews them, and drafts a reply for each.
6. Review the generated drafts in your chat. To send one, call `multi_gmail_send` (or `send`) with the parameters (`messageId`, `to`, `subject`, `body`) provided in the draft.

---

## Daily use

Just ask your AI assistant:
```
Fetch my inbox emails and draft replies
```

The assistant will fetch unread messages, show you summaries, and present a proposed reply for each. For each draft, you can respond with:

- **send** — sends the draft and marks the source email as read
- **edit** — provide your edits and the assistant will revise the draft
- **cancel** / **skip** — ignores/discards the draft

> [!IMPORTANT]
> **No emails are ever sent without your approval.** The assistant must call the `send` tool only when you explicitly instruct it to.

---

## Tools reference

> [!NOTE]
> All tools are registered under two aliases for maximum compatibility across various MCP clients:
> 1. With prefix (e.g., `multi_gmail_fetch`)
> 2. Without prefix (e.g., `fetch`)

### Setup and status

| Tool (Prefixed / Unprefixed) | What it does | Parameters |
|------|-------------|------------|
| `multi_gmail_help` / `help` | Shows the first-time setup steps | None |
| `multi_gmail_status` / `status` | Shows connection status, signer name, due follow-ups, and local file paths | `accountAlias`, `chatScope` (optional) |
| `multi_gmail_connect` / `connect` | Starts OAuth login for a Gmail account (opens browser) | `command` (e.g. `"Connect you@example.com personal"`), `chatScope` (optional) |
| `multi_gmail_connect_finish` / `connect_finish` | Finishes OAuth login after browser approval | `code` (optional), `pendingAlias` (optional), `chatScope` (optional) |
| `multi_gmail_accounts` / `accounts` | Lists all authenticated accounts (token file aliases) | None |
| `multi_gmail_set_signer` / `set_signer` | Sets the display name used to sign draft replies | `name` (required), `followUpLabel` (optional), `accountAlias`, `chatScope` (optional) |
| `multi_gmail_set_mode` / `set_mode` | Switches output between `standard` (default) and `compact` | `mode` (`"standard"` or `"compact"`), `chatScope` (optional) |
| `multi_gmail_diagnostics` / `diagnostics` | Checks credentials, accounts, reminders store, and active binding | `accountAlias`, `chatScope` (optional) |
| `multi_gmail_setup_labels` / `setup_labels` | Creates the Gmail sidebar labels if missing | `accountAlias`, `chatScope` (optional) |
| `multi_gmail_fetch_drafts` / `fetch_drafts` | Lists drafts in Gmail Drafts folder | `maxResults` (optional), `accountAlias`, `chatScope` (optional) |
| `multi_gmail_fetch_sent` / `fetch_sent` | Lists messages in Gmail Sent folder | `maxResults` (optional), `accountAlias`, `chatScope` (optional) |

### Email

| Tool (Prefixed / Unprefixed) | What it does | Parameters |
|------|-------------|------------|
| `multi_gmail_fetch` / `fetch` | Fetches up to 10 inbox emails and drafts a reply for each | `maxResults` (optional), `query` (optional), `saveGmailDrafts` (optional, default `false`), `writeMarkdownFile` (optional, default `true`), `accountAlias`, `chatScope` (optional) |
| `multi_gmail_set_draft` / `set_draft` | Saves/updates a Gmail draft reply for a reviewed thread without sending | `messageId`, `to`, `subject`, `body` (required); `cc`, `bcc` (optional); `accountAlias`, `chatScope` (optional) |
| `multi_gmail_send` / `send` | Sends one approved reply and marks source as read | `messageId`, `to`, `subject`, `body` (required); `cc`, `bcc` (optional); `accountAlias`, `chatScope` (optional) |

### Follow-up reminders

| Tool (Prefixed / Unprefixed) | What it does | Parameters |
|------|-------------|------------|
| `multi_gmail_followup_trigger` / `followup_trigger` | Creates follow-up reminders for a thread using `pattern` or `daysList` | `messageId` (required); `pattern` (e.g. `'1st follow after 10 days'`) or `daysList` (array of integers); `businessDaysOnly` (optional); `dueWeekday` (optional); `createGmailDraft` (optional); `accountAlias`, `chatScope` (optional) |
| `multi_gmail_followup_due` / `followup_due` | Lists reminders due now (skips replied threads) | `accountAlias`, `chatScope` (optional) |
| `multi_gmail_followup_send` / `followup_send` | Sends one approved follow-up reminder | `reminderId` (required); `to`, `subject`, `body`, `cc`, `bcc` (optional overrides); `accountAlias`, `chatScope` (optional) |

---

## Multiple accounts

Each account is identified by an **alias** — the label generated during authorization (e.g. `personal_you_at_gmail_com`).

To see all saved aliases, run:
```bash
multi_gmail_accounts
```

To target a specific account on any tool, pass `accountAlias`:
```json
{
  "accountAlias": "personal_you_at_gmail_com"
}
```

If your MCP host shares one server session across multiple chat windows (common in Cursor), pass a unique `chatScope` string on every tool call in a given chat. This keeps each chat's OAuth binding isolated:
```json
{
  "chatScope": "japan-inbox"
}
```

---

## File structure

```
multi-gmail-mcp/
├── credentials.json          # Google OAuth client credentials (you add this)
├── accounts/                 # Saved OAuth tokens, one file per account alias
├── data/
│   └── followup-reminders.json   # Stored follow-up reminders
│   └── inbox-reviews/
│       └── latest-inbox-review.md  # Latest inbox review export
└── src/
    ├── index.js              # Entry point
    ├── auth/                 # OAuth flow (connect, token store)
    ├── gmail/                # Gmail API client and service layer
    ├── mcp/                  # MCP server, tool schemas, tool handlers
    ├── reminders/            # Follow-up reminder store and service
    ├── config/               # env config, constants
    └── utils/                # Logger, error types, validators, formatters
```

---

## Gmail labels

Two labels are created automatically in your Gmail account on first use:

- **Inbox-review** — applied to emails in an active fetch batch, removed after you send the reply.
- **Follow-up** — applied to the source thread when you create a follow-up reminder, removed after the follow-up is sent.

If they do not appear under your Gmail sidebar, run the `setup_labels` tool.

---

## Troubleshooting

**"Token expired" or auth errors**
```bash
rm accounts/*.json
npm run auth
```

**"Insufficient permissions" or scope errors**

Re-run the Google Cloud OAuth setup. Make sure your OAuth consent screen has all three required scopes (`gmail.readonly`, `gmail.modify`, `gmail.send`) added. Then delete the old tokens in `accounts/` and re-authenticate.

**Server not showing in Claude / Cursor**

- Path in the config must be absolute — run `pwd` in the project folder.
- `node --version` must be v18 or higher.
- Fully quit and reopen the app (not just close the window).

**Multiple accounts not working**

Run the `accounts` tool to confirm tokens are saved. Re-authenticate any missing account with:
```bash
npm run auth -- --alias <alias>
```

**Setup state unclear**

Run the `diagnostics` tool — it checks all required files/directories and reports what is missing with a suggested next step.

---

## Security

> [!CAUTION]
> - `credentials.json` contains your Google OAuth client secret — **never commit it**.
> - `accounts/` contains saved OAuth tokens for each Gmail account — **never commit it**.
> - Both paths are listed in `.gitignore` and must remain there to prevent accidental credential leaks.
> - Token files are written with mode `0600` (owner read/write only) for local filesystem safety.

---

## License

MIT
