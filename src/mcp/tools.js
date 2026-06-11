import {
  beginScopedAuthorization,
  completeScopedAuthorization,
  resolveActiveBinding,
  listAccounts,
  listSessionBindings
} from "../auth/account-manager.js";
import { env } from "../config/env.js";
import { inboxWorkflowMarkdown, INBOX_WORKFLOW_POLICY } from "../config/inbox-workflow.js";
import {
  sendEmail,
  setReplyDraft,
  fetchUnreadSummariesAndReplyDrafts,
  markAsRead,
  removeInboxReviewGmailLabel,
  ensureMcpGmailLabelsForAccount,
  fetchGmailDrafts,
  fetchGmailSent,
  getThread,
  archiveThread
} from "../gmail/gmail-service.js";
import {
  createFollowUpReminder,
  deleteFollowUpReminders,
  getFollowUpReminder,
  listDuePendingFollowUps,
  listFollowUpReminders,
  updateFollowUpReminder
} from "../reminders/reminder-store.js";
import {
  tagSourceMessageForFollowUp,
  untagSourceMessageFollowUp
} from "../reminders/followup-gmail-sync.js";
import {
  generateFollowUpDraft,
  refreshDueFollowUpReminder,
  sendFollowUpReminder
} from "../reminders/followup-service.js";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { AppError, errorResponse, okResponse } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { resolveOutboundEmailParts } from "../utils/send-content.js";
import {
  helpOnboardingSchema,
  ensureMcpGmailLabelsSchema,
  getThreadSchema,
  archiveThreadSchema,
  completeConnectAccountSchema,
  connectAccountSchema,
  fetchUnreadSmartDraftsSchema,
  fetchDraftsSchema,
  fetchSentSchema,
  followUpCheckDueSchema,
  followUpCleanupBaseSchema,
  followUpCleanupSchema,
  followUpTriggerBaseSchema,
  followUpTriggerSchema,
  followUpSendSchema,
  listAccountsSchema,
  runSetupDiagnosticsSchema,
  sendSmartReplyBaseSchema,
  sendSmartReplySchema,
  sendNewEmailBaseSchema,
  sendNewEmailSchema,
  setDraftReplySchema,
  setDraftReplyValidatedSchema,
  setResponseModeSchema,
  setSignerNameSchema,
  workspaceStatusSchema
} from "./tool-schemas.js";

/** Per-session signer name: scopeKey → name string */
const sessionSignerNames = new Map();
/** Per-session follow-up label override: scopeKey → label string */
const sessionFollowUpLabels = new Map();
/** Per-session response mode: scopeKey → standard|compact */
const sessionResponseModes = new Map();

/** Last successful fetch per scope (for status). */
const lastInboxFetchByScope = new Map();

function toolResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

function getResponseMode(scopeKey) {
  return sessionResponseModes.get(scopeKey) || "standard";
}

function buildThreadTranscriptMarkdown(data) {
  const format = data.format || "full";
  const lines = [
    `# Thread: ${data.subject || "(no subject)"}`,
    "",
    `format: ${format}`,
    format === "latest" && data.latestN != null ? `latestN: ${data.latestN}` : null,
    `threadId: ${data.threadId || "—"}`,
    `messages: ${data.messageCount ?? 0}`,
    `latestMessageId: ${data.latestMessageId || "—"}`,
    data.participants?.from ? `participants.from: ${data.participants.from}` : null,
    format === "metadata" ? "bodies: omitted (metadata only)" : null,
    format !== "metadata" && data.stripped === false ? "bodies: raw (stripped=false)" : null,
    format !== "metadata" && data.includeRaw ? "bodies: stripped text + rawText per message" : null,
    ""
  ];

  if (Array.isArray(data.messages) && data.messages.length > 0) {
    let section = 0;
    for (const message of data.messages) {
      if (message.marker) {
        lines.push(message.marker, "");
        continue;
      }
      section++;
      lines.push(
        `## ${section}. ${message.direction || "—"}`,
        `messageId: ${message.messageId || "—"}`,
        `from: ${message.from || "—"}`,
        `to: ${message.to || "—"}`,
        `date: ${message.date || "—"}`
      );
      if (format !== "metadata") {
        lines.push("", message.text || "_(no content)_");
        if (message.rawText && data.includeRaw && data.stripped !== false) {
          lines.push("", "_rawText available in structuredContent_");
        }
      }
      lines.push("", "---", "");
    }
  } else {
    lines.push("_No messages in this thread._", "");
  }

  return lines.filter(Boolean).join("\n");
}

function getThreadToolResult(payload) {
  if (!payload.ok || !payload.data) {
    return toolResult(payload);
  }
  return {
    content: [{ type: "text", text: buildThreadTranscriptMarkdown(payload.data) }],
    structuredContent: payload
  };
}

function buildListInboxMarkdown(data) {
  const lines = [
    "# Inbox threads (list)",
    "",
    `Account: ${data.activeEmail ?? "—"}`,
    `Threads: ${data.threadCount ?? data.inboxThreadCount ?? 0}`,
    "Metadata only — snippets are **not** full emails. Call `get_thread` per thread and show `message.text` verbatim when the user needs to read mail.",
    "",
    inboxWorkflowMarkdown({ heading: "### Next steps" })
  ];

  if (Array.isArray(data.items) && data.items.length > 0) {
    for (const [index, item] of data.items.entries()) {
      const from = item.participants?.from || item.from || "—";
      lines.push(
        `${index + 1}) ${item.subject || "(no subject)"}`,
        `   from: ${from}`,
        `   direction: ${item.lastMessageDirection || "—"}`,
        `   date: ${item.lastMessageDate || "—"}`,
        `   messages: ${item.messageCount ?? "—"}`,
        `   threadId: ${item.threadId || "—"}`,
        `   latestMessageId: ${item.latestMessageId || "—"}`,
        item.snippet ? `   snippet: ${item.snippet}` : null,
        ""
      );
    }
  } else {
    lines.push("No inbox threads in this batch.", "");
  }

  return lines.filter(Boolean).join("\n");
}

function buildCompactInboxMarkdown(data) {
  if (data.mode === "list") {
    return buildListInboxMarkdown(data);
  }

  const lines = [
    "# Inbox review (compact)",
    "",
    `Account: ${data.activeEmail ?? "—"}`,
    `Inbox threads in batch: ${data.threadCount ?? data.inboxThreadCount ?? data.inboxCount ?? 0}`,
    "Safety: nothing is sent automatically",
    ""
  ];

  if (Array.isArray(data.items) && data.items.length > 0) {
    for (const [index, item] of data.items.entries()) {
      lines.push(
        `${index + 1}) ${item.subject || "(no subject)"}`,
        `   from: ${item.from || item.participants?.from || "—"}`,
        `   threadId: ${item.threadId || "—"}`,
        `   messageId: ${item.messageId || item.latestMessageId || "—"}`,
        ""
      );
    }
    lines.push(
      "Next: say send/edit/cancel for each item, then use send only for approved drafts.",
      "Note: When generating or editing drafts, avoid reusing previously addressed content from the thread history and generate a fresh, context-aware response instead.",
      ""
    );
  } else {
    lines.push("No inbox threads in this batch.", "");
  }

  return lines.join("\n");
}

function buildSmartAssistantChatMarkdown(data) {
  const fileLine = data.markdownFile
    ? `\`${data.markdownFile}\` (${data.markdownSaved ? "saved" : "not saved"})`
    : data.writeMarkdownFile === false
      ? "_(optional file export was off — review drafts in this chat)_"
      : "_(no file — zero inbox messages in this batch)_";

  const mdNorm = data.markdownFile ? String(data.markdownFile).replace(/\\/g, "/") : "";
  const savedReviewMd = data.markdownSaved && data.markdownFile;

  const lines = [
    "# Inbox review (legacy batch mode)",
    "",
    data.workflowWarning
      ? `> **${data.workflowWarning}** Prefer \`fetch\` mode=list, then \`get_thread\` one thread at a time for future runs.`
      : null,
    "> **Review drafts** — Every inbox thread below has a proposed reply in this run. **Do not send** until the user confirms each one. Drafting already used the full thread context. When generating or editing drafts, avoid reusing previously addressed content from the thread history and generate a fresh, context-aware response instead. When they approve, call **`send`** to deliver to the recipient and mark the original as read. Show **all** items; the user chooses send / edit / skip **per** thread.",
    ""
  ].filter(Boolean);

  if (savedReviewMd) {
    if (mdNorm.includes("knowledge-base/") || mdNorm.includes("T3Planet-Cowork/")) {
      lines.push(
        "> **Optional:** A single **`.md`** file was saved for editing next to your knowledge base (overwritten on the next fetch):",
        "> ",
        `> \`${data.markdownFile}\``,
        "",
        "> *(Open it in the tree if you prefer the editor; chat review is enough for most workflows.)*",
        ""
      );
    } else {
      lines.push(
        "> **Optional file export:**",
        "> ",
        `> \`${data.markdownFile}\``,
        ""
      );
    }
  }

  lines.push(
    `**Connected account:** ${data.activeEmail ?? "—"}`,
    `**Inbox threads in this batch:** ${data.threadCount ?? data.inboxThreadCount ?? data.inboxCount ?? 0}`,
    `**Ready to send:** only after explicit approval per thread (nothing sent automatically)`,
    `**Optional export:** ${fileLine}`,
    `**Gmail filter:** \`${data.gmailListQuery ?? ""}\``,
    ""
  );

  if (data.noUnreadHint) {
    lines.push("> " + data.noUnreadHint, "");
  }
  if (data.markdownSaveError) {
    lines.push("> **Save error:** " + data.markdownSaveError, "");
  }

  lines.push("---", "");

  if (Array.isArray(data.items) && data.items.length > 0) {
    for (const [i, item] of data.items.entries()) {
      const sub = item.subject || "(no subject)";
      lines.push(`## ${i + 1}. ${sub}`);
      lines.push(`- **From:** ${item.from || "—"}`);
      lines.push(`- **threadId:** \`${item.threadId || "—"}\``);
      lines.push(`- **messageId:** \`${item.messageId}\``);
      lines.push(`- **Thread messages:** ${item.threadMessageCount || item.threadContext?.messageCount || 0}`);
      lines.push(`- **Intent:** ${item.intentType} — ${item.intentDetail}`);
      if (item.mailSummary) lines.push(`- **Summary:** ${item.mailSummary}`);
      if (item.senderGoal) lines.push(`- **Sender Goal:** ${item.senderGoal}`);
      if (item.selectedFormat) lines.push(`- **Selected Format:** ${item.selectedFormat}`);
      if (Array.isArray(item.selectedFormatGuidance) && item.selectedFormatGuidance.length > 0) {
        lines.push(`- **Format Guidance:** ${item.selectedFormatGuidance.join("; ")}`);
      }
      if (Array.isArray(item.selectedContextSections) && item.selectedContextSections.length > 0) {
        lines.push(`- **Context Sections:** ${item.selectedContextSections.join("; ")}`);
      }
      if (item.gmailDraftId) {
        lines.push(`- **Gmail Draft:** \`${item.gmailDraftId}\` (${item.gmailDraftAction === "updated" ? "updated" : "saved"})`);
      } else if (item.gmailDraftError) {
        lines.push(`- **Gmail Draft:** not saved (${item.gmailDraftError})`);
      }
      if (Array.isArray(item.agentNotes) && item.agentNotes.length > 0) {
        lines.push("", "### Review Notes");
        for (const note of item.agentNotes) {
          lines.push(`- ${note}`);
        }
      }
      lines.push("");
      lines.push("### Draft Reply");
      lines.push(item.draftReplyMarkdown || "");
      lines.push("", "---", "");
    }

    lines.push(
      "**For each draft, reply with your choice:**",
      "- **send** — sends the draft reply for that thread and marks the source email as read",
      "- **edit** — paste your revised text and confirm",
      "- **cancel** — discard this draft",
      "",
      "> IMPORTANT: Nothing is sent until you explicitly say **send** for a specific thread/email.",
      ""
    );
  } else {
    lines.push(data.draftsMarkdown || "_No inbox threads in this run._", "");
  }

  return lines.join("\n");
}

function smartAssistantFetchResult(payload) {
  if (!payload.ok || !payload.data) {
    return toolResult(payload);
  }
  const chatMarkdown =
    payload.data.mode === "list"
      ? buildListInboxMarkdown(payload.data)
      : payload.data.responseMode === "compact"
        ? buildCompactInboxMarkdown(payload.data)
        : buildSmartAssistantChatMarkdown(payload.data);
  return {
    content: [{ type: "text", text: chatMarkdown }],
    structuredContent: payload
  };
}

function formatFollowUpItemMarkdown(item, index) {
  const lines = [
    `## ${index + 1}. ${item.sourceSubject || item.draft?.subject || "(no subject)"}`,
    `- **Reminder ID:** \`${item.id}\``,
    `- **Connected account:** ${item.activeEmail ?? "—"} (\`${item.alias ?? "—"}\`)`,
    `- **Thread ID:** \`${item.sourceThreadId || item.threadContext?.threadId || "—"}\``,
    `- **From:** ${item.sourceFrom || "—"}`,
    `- **Thread messages:** ${item.threadContext?.messageCount || 0}`,
    `- **Due:** ${
      item.status === "waiting"
        ? `after follow-up #${(item.followUpSequence ?? 0)} is sent (+${item.reminderDays} day(s))`
        : item.dueAt || "—"
    }`,
    `- **Status:** ${item.status || "pending"}`,
    `- **Summary:** ${item.summary || "—"}`,
    item.latestExternalDate ? `- **Latest external reply:** ${item.latestExternalDate}` : null,
    `- **Gmail Draft:** ${
      item.draft?.gmailDraftId
        ? `\`${item.draft.gmailDraftId}\` (${item.draft.gmailDraftAction || "saved"})`
        : item.draft?.gmailDraftError
          ? `not saved (${item.draft.gmailDraftError})`
          : "not created"
    }`,
    "",
    "### Suggested follow-up",
    `**To:** ${Array.isArray(item.draft?.to) ? item.draft.to.join(", ") : item.draft?.to || "—"}`,
    `**Subject:** ${item.draft?.subject || "—"}`,
    "",
    "```text",
    item.draft?.body || "",
    "```",
    "",
    item.threadContext?.lastMessage?.bodyText
      ? `**Latest thread message preview:** ${String(item.threadContext.lastMessage.bodyText).replace(/\s+/g, " ").trim().slice(0, 280)}`
      : null,
    "",
    "> Nothing is sent automatically. Only call `followup_send` when the user explicitly says `send`.",
    ""
  ];

  return lines.filter(Boolean).join("\n");
}

function followUpResult(payload) {
  if (!payload.ok || !payload.data) {
    return toolResult(payload);
  }

  const data = payload.data;
  if (data.responseMode === "compact") {
    const compactLines = [
      "# Follow-ups (compact)",
      "",
      `Action: ${data.action || "create"}`,
      `Account: ${data.activeEmail ?? "—"}`,
      data.dueCount !== undefined ? `Due: ${data.dueCount}` : null,
      data.sentMessageId ? `Sent message: ${data.sentMessageId}` : null,
      data.message || null,
      data.nextStep ? `Next: ${data.nextStep}` : null,
      ""
    ].filter(Boolean);
    return {
      content: [{ type: "text", text: compactLines.join("\n") }],
      structuredContent: payload
    };
  }
  const items = Array.isArray(data.items)
    ? data.items
    : data.reminder
      ? [data.reminder]
      : [];

  const lines = [
    "# Follow-ups",
    "",
    `**Action:** ${data.action || "create"}`,
    `**Connected account:** ${data.activeEmail ?? "—"} (\`${data.activeAlias ?? "—"}\`)`,
    data.dueCount !== undefined ? `**Due reminders:** ${data.dueCount}` : null,
    data.createdReminderId ? `**Reminder created:** \`${data.createdReminderId}\`` : null,
    Array.isArray(data.createdReminderIds) && data.createdReminderIds.length > 1
      ? `**Reminder IDs created:** ${data.createdReminderIds.map((id) => `\`${id}\``).join(", ")}`
      : null,
    data.sentMessageId ? `**Sent message:** \`${data.sentMessageId}\`` : null,
    ""
  ].filter(Boolean);

  if (items.length === 0) {
    lines.push(data.message || "No due follow-ups right now.", "");
  } else {
    for (const [index, item] of items.entries()) {
      lines.push("---", "", formatFollowUpItemMarkdown(item, index));
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: payload
  };
}

function parseSchema(schema, args) {
  const input = args ?? {};

  // Detect unknown keys before Zod runs (BUG-7): some MCP hosts/SDK versions
  // strip unrecognised keys from args before calling the handler, so Zod's
  // .strict() never sees them. By checking the raw args here we catch typos
  // like `acountAlias` that would otherwise silently fall back to the default.
  //
  // We read the known keys from the Zod schema's shape. ZodEffects (superRefine)
  // wraps a ZodObject — unwrap one level so we can always reach _def.shape.
  const innerDef = schema._def?.schema?._def ?? schema._def;
  const knownShape = innerDef?.shape?.() ?? null;
  if (knownShape && typeof input === "object" && input !== null) {
    const unknown = Object.keys(input).filter((k) => !(k in knownShape));
    if (unknown.length > 0) {
      throw new AppError(
        `Unknown parameter(s): ${unknown.join(", ")}. Check for typos — known keys are: ${Object.keys(knownShape).join(", ")}.`,
        "VALIDATION_ERROR",
        400
      );
    }
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    // Build a single readable summary so the error message (not just details)
    // explains what is wrong — avoids raw Zod arrays as the primary signal (BUG-9).
    const fieldParts = Object.entries(flat.fieldErrors || {})
      .map(([field, msgs]) => `${field}: ${(msgs || []).join(", ")}`)
      .join("; ");
    const formParts = (flat.formErrors || []).join("; ");
    const summary = [fieldParts, formParts].filter(Boolean).join("; ") || "Invalid input.";
    throw new AppError(
      `Invalid tool input — ${summary}`,
      "VALIDATION_ERROR",
      400,
      flat
    );
  }
  return parsed.data;
}

function chatScopeToSessionKey(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const safe = t.replace(/[^a-zA-Z0-9._@-]+/g, "_").slice(0, 128);
  return safe ? `chat:${safe}` : null;
}

/**
 * Binding namespace for OAuth + signer name. If the client passes chatScope on tools, it wins — use one
 * distinct chatScope per UI chat when the MCP host shares a single "default" session across tasks.
 */
function resolveScopeKey(extra, toolArgs = {}) {
  const fromChatScope = chatScopeToSessionKey(toolArgs.chatScope);
  if (fromChatScope) return fromChatScope;

  const meta = extra?._meta || {};
  const candidates = [
    extra?.sessionId,
    meta.sessionId,
    meta.chatId,
    meta.conversationId,
    meta.threadId
  ];
  const value = candidates.find((item) => typeof item === "string" && item.trim().length > 0);
  if (value) return value.trim();
  if (env.GMAIL_MCP_SCOPE_KEY) return env.GMAIL_MCP_SCOPE_KEY;
  return "default";
}

function omitRoutingFields(input) {
  const { accountAlias, chatScope, ...rest } = input;
  return rest;
}

function withScopedUiHints(binding, data = {}) {
  return {
    ...data,
    activeEmail: binding.email,
    activeAlias: binding.alias,
    bindingSource: binding.bindingSource,
    scopeKeyUsed: binding.scopeKeyUsed,
    responseMode: getResponseMode(binding.scopeKeyUsed),
    chatPolicy: "multi_account_per_chat",
    renameChatTo: binding.email
  };
}

function buildOnboardingMarkdown() {
  return [
    "# Gmail MCP onboarding",
    "",
    "Use this first-time sequence:",
    "1. Run `status`.",
    "2. Run `connect` (example: `Connect you@example.com personal`).",
    "3. Run `connect_finish` right after browser approval.",
    "4. Run `set_signer` with your preferred signature name.",
    '5. Run `fetch` with `mode="list"` to scan inbox metadata.',
    "6. For each thread that needs a reply, run `get_thread` once, draft, then `send` only after approval.",
    "",
    inboxWorkflowMarkdown(),
    "Safety:",
    "- Nothing is sent automatically.",
    "- You must explicitly approve each send action.",
    "",
    "Optional:",
    "- Run `set_mode` with `compact` for shorter responses.",
    "- Run `diagnostics` if setup/auth feels broken.",
    "- `fetch` with `mode=full` is legacy batch mode — avoid for normal inbox review.",
    ""
  ].join("\n");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_TO_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function moveToNextBusinessDay(date) {
  const out = new Date(date.getTime());
  while (isWeekend(out)) {
    out.setUTCDate(out.getUTCDate() + 1);
  }
  return out;
}

function moveToNextWeekday(date, weekdayIndex) {
  if (!Number.isInteger(weekdayIndex) || weekdayIndex < 0 || weekdayIndex > 6) {
    return new Date(date.getTime());
  }
  const out = new Date(date.getTime());
  while (out.getUTCDay() !== weekdayIndex) {
    out.setUTCDate(out.getUTCDate() + 1);
  }
  return out;
}

function addBusinessDaysUtc(startDate, businessDays) {
  const out = new Date(startDate.getTime());
  let remaining = Math.max(0, Number(businessDays) || 0);

  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    if (!isWeekend(out)) {
      remaining -= 1;
    }
  }

  return out;
}

function resolveReminderDueAt(days, options = {}) {
  const anchor =
    options.baseDate instanceof Date && !Number.isNaN(options.baseDate.getTime())
      ? options.baseDate
      : new Date();
  const base = options.businessDaysOnly
    ? addBusinessDaysUtc(anchor, days)
    : new Date(anchor.getTime() + days * 24 * 60 * 60 * 1000);
  const weekdayIndex =
    typeof options.dueWeekday === "string"
      ? WEEKDAY_TO_INDEX[options.dueWeekday.toLowerCase()]
      : undefined;

  let dueDate = base;
  if (options.businessDaysOnly) {
    dueDate = moveToNextBusinessDay(dueDate);
  }
  if (weekdayIndex !== undefined) {
    dueDate = moveToNextWeekday(dueDate, weekdayIndex);
  }

  return dueDate.toISOString();
}

async function reschedulePendingFollowUpsForThread(alias, threadId) {
  if (!threadId) return;
  const all = await listFollowUpReminders();
  const matches = all.filter(
    (r) => r.alias === alias && r.sourceThreadId === threadId && ["pending", "due"].includes(r.status)
  );
  for (const reminder of matches) {
    const days = reminder.reminderDays;
    if (!Number.isFinite(days) || days <= 0) continue;
    const newDueAt = resolveReminderDueAt(days, reminder.scheduleRule || {});
    await updateFollowUpReminder(reminder.id, { dueAt: newDueAt, status: "pending" });
    logger.info("follow-up rescheduled after reply", { reminderId: reminder.id, newDueAt });
  }
}

/** After follow-up N is sent, schedule follow-up N+1 from sentAt + its reminderDays. */
async function activateNextFollowUpInChain(sentReminder) {
  if (!sentReminder?.followUpChainId || sentReminder.followUpSequence === undefined) {
    return null;
  }
  const nextSequence = sentReminder.followUpSequence + 1;
  const all = await listFollowUpReminders();
  const next = all.find(
    (r) =>
      r.followUpChainId === sentReminder.followUpChainId &&
      r.followUpSequence === nextSequence &&
      r.status === "waiting"
  );
  if (!next) return null;

  const sentAt = sentReminder.sentAt ? new Date(sentReminder.sentAt) : new Date();
  const scheduleRule = next.scheduleRule || {};
  const newDueAt = resolveReminderDueAt(next.reminderDays, {
    ...scheduleRule,
    baseDate: sentAt
  });
  const activated = await updateFollowUpReminder(next.id, {
    status: "pending",
    dueAt: newDueAt
  });
  logger.info("follow-up chain: next reminder activated", {
    chainId: sentReminder.followUpChainId,
    previousReminderId: sentReminder.id,
    nextReminderId: next.id,
    newDueAt
  });
  return activated;
}

function parseFollowUpPattern(pattern) {
  const text = String(pattern || "").trim();
  if (!text) return [];
  const matches = text.match(/\d+/g) || [];
  return Array.from(new Set(matches.map((item) => Number.parseInt(item, 10)).filter(Number.isFinite))).sort((a, b) => a - b);
}

function normalizeMessageHeaderId(value) {
  return String(value || "").trim().toLowerCase();
}

async function listEditableFollowUpsForThread(alias, sourceThreadId) {
  const all = await listFollowUpReminders();
  return all
    .filter(
      (reminder) =>
        reminder.alias === alias &&
        reminder.sourceThreadId === sourceThreadId &&
        ["pending", "due", "waiting"].includes(reminder.status)
    )
    .sort((left, right) => {
      const leftSeq = Number.isInteger(left.followUpSequence) ? left.followUpSequence : 0;
      const rightSeq = Number.isInteger(right.followUpSequence) ? right.followUpSequence : 0;
      if (leftSeq !== rightSeq) return leftSeq - rightSeq;
      return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    });
}

async function handleFetchUnreadSmartDrafts(args, extra) {
  try {
    const input = parseSchema(fetchUnreadSmartDraftsSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const signerName = sessionSignerNames.get(scopeKey) || null;
    const payload = omitRoutingFields(input);

    logger.info("fetch", {
      mode: payload.mode,
      queryMode: payload.queryMode,
      maxResults: payload.maxResults,
      query: payload.query,
      saveGmailDrafts: payload.saveGmailDrafts,
      writeMarkdownFile: payload.writeMarkdownFile,
      signerName
    });

    const data = await fetchUnreadSummariesAndReplyDrafts({
      alias: binding.alias,
      maxResults: payload.maxResults,
      query: payload.query,
      queryMode: payload.queryMode,
      mode: payload.mode,
      writeMarkdownFile: payload.mode === "full" ? payload.writeMarkdownFile : false,
      signerName,
      saveGmailDrafts: payload.mode === "full" ? payload.saveGmailDrafts : false
    });

    const merged = { ...data, writeMarkdownFile: payload.writeMarkdownFile };
    lastInboxFetchByScope.set(scopeKey, {
      unreadDraftsPrepared: merged.unreadCount ?? 0,
      fetchedAt: new Date().toISOString(),
      markdownFile: merged.markdownFile || null,
      markdownSaved: Boolean(merged.markdownSaved)
    });

    logger.info("fetch complete", {
      unreadCount: data.unreadCount,
      markdownFile: data.markdownFile
    });

    return smartAssistantFetchResult(okResponse(withScopedUiHints(binding, merged)));
  } catch (error) {
    logger.error("fetch failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function executeApprovedSend(binding, payload, { sourceMessageId, action = "send" }) {
  const isReply = Boolean(sourceMessageId);
  const continuesThread = Boolean(payload.threadId?.trim() && !isReply);
  const parts = resolveOutboundEmailParts({
    body: payload.body,
    html: payload.html,
    htmlBody: payload.htmlBody,
    format: payload.format
  });

  logger.info(action, {
    messageId: sourceMessageId ?? null,
    isReply,
    to: payload.to,
    subject: payload.subject,
    format: parts.format,
    hasHtml: Boolean(parts.html)
  });

  const sendResult = await sendEmail({
    alias: binding.alias,
    to: payload.to,
    subject: payload.subject,
    body: parts.body,
    cc: payload.cc,
    bcc: payload.bcc,
    html: parts.html,
    sourceMessageId,
    threadId: payload.threadId,
    quoteOriginal: payload.quoteOriginal,
    appendSignature: payload.appendSignature
  });

  let markResult = null;
  let reviewLabelRemoved = { removed: false, labelName: null };
  if (isReply) {
    markResult = await markAsRead({
      alias: binding.alias,
      messageId: sourceMessageId
    });
    reviewLabelRemoved = await removeInboxReviewGmailLabel({
      alias: binding.alias,
      messageId: sourceMessageId
    });
    await reschedulePendingFollowUpsForThread(binding.alias, sendResult.threadId);
  }

  logger.info(`${action} complete`, {
    sentId: sendResult.id,
    threadId: sendResult.threadId,
    markedRead: markResult?.messageId ?? null,
    isReply
  });

  const to = Array.isArray(payload.to) ? payload.to.join(", ") : payload.to;
  let summary;
  if (isReply) {
    let tail = "";
    if (reviewLabelRemoved.removed) {
      tail += `, inbox-review label "${reviewLabelRemoved.labelName}" removed from source`;
    }
    if (sendResult.deletedDraft) {
      tail += ", and the matching Gmail draft was removed";
    } else if (sendResult.deletedDraftError) {
      tail += `, but draft cleanup failed: ${sendResult.deletedDraftError}`;
    }
    summary = `Email sent to ${to}, source message marked as read${tail}.`;
  } else if (continuesThread) {
    summary = `Email sent to ${to} in existing thread ${sendResult.threadId}.`;
  } else {
    summary = `New email sent to ${to} (threadId ${sendResult.threadId}).`;
  }

  return toolResult(
    okResponse(
      withScopedUiHints(binding, {
        action,
        sent: true,
        isNewThread: !isReply && !continuesThread,
        sentMessageId: sendResult.id,
        threadId: sendResult.threadId,
        deletedDraftId: sendResult.deletedDraftId,
        deletedDraft: sendResult.deletedDraft,
        deletedDraftError: sendResult.deletedDraftError,
        markedReadMessageId: markResult?.messageId ?? null,
        gmailInboxReviewLabelRemoved: reviewLabelRemoved.removed,
        gmailInboxReviewLabelName: reviewLabelRemoved.labelName,
        summary,
        nextStep: isReply
          ? "Run fetch to review the next batch, or followup_due to review due follow-ups."
          : "Store sentMessageId and threadId for follow-up threading; use get_thread or fetch to verify delivery."
      })
    )
  );
}

async function handleSendSmartReply(args, extra) {
  try {
    const input = parseSchema(sendSmartReplySchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);
    const sourceMessageId = payload.messageId?.trim() || undefined;
    return executeApprovedSend(binding, payload, { sourceMessageId, action: "send" });
  } catch (error) {
    logger.error("send failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleSendNewEmail(args, extra) {
  try {
    const input = parseSchema(sendNewEmailSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);
    return executeApprovedSend(
      binding,
      {
        to: payload.to,
        subject: payload.subject,
        body: payload.body,
        format: payload.format,
        threadId: payload.threadId,
        cc: payload.cc,
        bcc: payload.bcc,
        htmlBody: payload.htmlBody
      },
      { sourceMessageId: undefined, action: "send_new" }
    );
  } catch (error) {
    logger.error("send_new failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleSetDraftReply(args, extra) {
  try {
    const input = parseSchema(setDraftReplyValidatedSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);
    const parts = resolveOutboundEmailParts({
      body: payload.body,
      html: payload.html,
      format: payload.format
    });

    logger.info("set_draft", {
      messageId: payload.messageId,
      to: payload.to,
      subject: payload.subject,
      format: parts.format
    });

    const result = await setReplyDraft({
      alias: binding.alias,
      sourceMessageId: payload.messageId,
      to: payload.to,
      subject: payload.subject,
      body: parts.body,
      html: parts.html,
      cc: payload.cc,
      bcc: payload.bcc,
      quoteOriginal: payload.quoteOriginal,
      appendSignature: payload.appendSignature
    });

    return toolResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "set_draft",
          gmailDraftId: result.gmailDraftId,
          gmailDraftAction: result.gmailDraftAction,
          gmailDraftError: result.gmailDraftError,
          sourceMessageId: result.sourceMessageId,
          sourceThreadId: result.sourceThreadId,
          summary: result.gmailDraftError
            ? `Draft could not be saved: ${result.gmailDraftError}`
            : `Draft ${result.gmailDraftAction} in Gmail Drafts for this thread.`,
          nextStep: "Review the draft in Gmail or send via multi_gmail_send when approved."
        })
      )
    );
  } catch (error) {
    logger.error("set_draft failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleTriggerFollowUp(args, extra) {
  try {
    const input = parseSchema(followUpTriggerSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const signerName = sessionSignerNames.get(scopeKey) || null;
    const payload = omitRoutingFields(input);

    const generated = await generateFollowUpDraft({
      alias: binding.alias,
      activeEmail: binding.email,
      messageId: payload.messageId,
      signerName,
      createGmailDraft: payload.createGmailDraft
    });

    const reminderDaysList = input.daysList || parseFollowUpPattern(input.pattern);
    if (!Array.isArray(reminderDaysList) || reminderDaysList.length === 0) {
      throw new AppError(
        "No follow-up day values found. Provide daysList or include day numbers in pattern.",
        "VALIDATION_ERROR",
        400
      );
    }

    const schedulePolicy = {
      businessDaysOnly: Boolean(payload.businessDaysOnly),
      dueWeekday: payload.dueWeekday
    };

    const existingEditable = await listEditableFollowUpsForThread(
      binding.alias,
      generated.sourceEmail.threadId
    );
    const useChainedSchedule = reminderDaysList.length > 1;
    const chainId =
      useChainedSchedule
        ? existingEditable.find((item) => item.followUpChainId)?.followUpChainId || randomUUID()
        : null;
    const reminders = [];
    const touchedReminderIds = new Set();
    for (let sequence = 0; sequence < reminderDaysList.length; sequence++) {
      const days = reminderDaysList[sequence];
      const isFirstInChain = sequence === 0;
      const scheduleRule = {
        businessDaysOnly: schedulePolicy.businessDaysOnly,
        dueWeekday: schedulePolicy.dueWeekday
      };
      const reminderPayload = {
        alias: binding.alias,
        activeEmail: binding.email,
        signerName,
        createGmailDraft: payload.createGmailDraft,
        followUpChainId: chainId,
        followUpSequence: useChainedSchedule ? sequence : null,
        reminderDays: days,
        dueAt:
          !useChainedSchedule || isFirstInChain
            ? resolveReminderDueAt(days, scheduleRule)
            : null,
        status: useChainedSchedule && !isFirstInChain ? "waiting" : "pending",
        notifiedAt: null,
        sentAt: null,
        resolvedAt: null,
        resolutionReason: null,
        lastEvaluatedAt: null,
        scheduleRule,
        sourceMessageId: generated.sourceEmail.id,
        sourceMessageHeaderId: generated.sourceEmail.messageHeaderId || null,
        sourceThreadId: generated.sourceEmail.threadId,
        sourceSubject: generated.sourceEmail.subject,
        sourceFrom: generated.sourceEmail.from,
        summary: generated.summary,
        topic: generated.topic,
        latestExternalDate: generated.latestExternalDate,
        draft: {
          ...generated.draft,
          gmailDraftId: generated.gmailDraft.gmailDraftId || null,
          gmailDraftAction: generated.gmailDraft.gmailDraftAction || null,
          gmailDraftError: generated.gmailDraft.gmailDraftError || null
        }
      };
      const existingReminder = existingEditable[sequence];
      const reminder = existingReminder
        ? await updateFollowUpReminder(existingReminder.id, reminderPayload)
        : await createFollowUpReminder(reminderPayload);
      touchedReminderIds.add(reminder.id);
      reminders.push(reminder);
    }

    const staleReminderIds = existingEditable
      .filter((reminder) => !touchedReminderIds.has(reminder.id))
      .map((reminder) => reminder.id);
    if (staleReminderIds.length > 0) {
      const staleIdSet = new Set(staleReminderIds);
      await deleteFollowUpReminders(
        (reminder) => reminder.alias === binding.alias && staleIdSet.has(reminder.id)
      );
    }

    logger.info("followup_trigger", {
      action: existingEditable.length > 0 ? "update" : "create",
      reminderIds: reminders.map((r) => r.id),
      sourceMessageId: generated.sourceEmail.id,
      dueAt: reminders.map((r) => r.dueAt)
    });

    const labelSync = await tagSourceMessageForFollowUp(binding.alias, generated.sourceEmail.id);

    return followUpResult(
      okResponse(
        withScopedUiHints(binding, {
          action: existingEditable.length > 0 ? "update" : "create",
          createdReminderId: reminders[0]?.id || null,
          createdReminderIds: reminders.map((r) => r.id),
          deletedReminderIds: staleReminderIds,
          reminder: reminders.length === 1 ? reminders[0] : undefined,
          items: reminders,
          message:
            existingEditable.length > 0
              ? reminders.length === 1
                ? "Follow-up reminder updated for this thread."
                : `Follow-up reminders updated for this thread (${reminders.length} milestones).`
              : reminders.length === 1
                ? "Follow-up reminder created."
                : `Follow-up reminders created (${reminders.length} milestones).`,
          schedule: {
            reminderDays: reminderDaysList,
            chained: useChainedSchedule,
            businessDaysOnly: schedulePolicy.businessDaysOnly,
            dueWeekday: schedulePolicy.dueWeekday,
            note: useChainedSchedule
              ? `Follow-up 1 in ${reminderDaysList[0]} day(s) from now; follow-up 2+ each wait until the previous is sent, then use that entry's day count (e.g. [1, 3] = 1 day, then 3 days after follow-up 1).`
              : null
          },
          nextStep:
            "Run followup_due to review due reminders. Send only after explicit approval using followup_send.",
          gmailFollowUpLabel: env.FOLLOW_UP_GMAIL_LABEL_NAME,
          gmailFollowUpLabelApplied: labelSync.ok && !labelSync.skipped,
          gmailFollowUpLabelSkipped: labelSync.skipped === true,
          gmailFollowUpLabelError: labelSync.error || null
        })
      )
    );
  } catch (error) {
    logger.error("followup_trigger failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleCheckDueFollowUps(args, extra) {
  try {
    const input = parseSchema(followUpCheckDueSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    // Use the current session signer name so the draft is signed correctly even
    // when the reminder was created in a previous session (signerName: null).
    const sessionSignerName = sessionSignerNames.get(scopeKey) || null;

    const dueReminders = (await listDuePendingFollowUps()).filter(
      (reminder) => reminder.alias === binding.alias
    );
    const dueItems = [];

    for (const reminder of dueReminders) {
      const evaluation = await refreshDueFollowUpReminder(reminder, { sessionSignerName });

      if (evaluation.state === "resolved_by_reply") {
        await updateFollowUpReminder(reminder.id, {
          status: "resolved_by_reply",
          resolvedAt: new Date().toISOString(),
          resolutionReason: "Customer replied after the reminder was created.",
          summary: evaluation.summary,
          topic: evaluation.topic,
          latestExternalDate: evaluation.latestExternalDate,
          draft: {
            ...reminder.draft,
            ...evaluation.draft,
            gmailDraftId: evaluation.gmailDraft.gmailDraftId || reminder.draft?.gmailDraftId || null,
            gmailDraftAction: evaluation.gmailDraft.gmailDraftAction || null,
            gmailDraftError: evaluation.gmailDraft.gmailDraftError || null
          },
          lastEvaluatedAt: new Date().toISOString()
        });
        await untagSourceMessageFollowUp(reminder.alias, reminder.sourceMessageId);
        continue;
      }

      const updatedReminder = await updateFollowUpReminder(reminder.id, {
        status: "due",
        summary: evaluation.summary,
        topic: evaluation.topic,
        latestExternalDate: evaluation.latestExternalDate,
        draft: {
          ...reminder.draft,
          ...evaluation.draft,
          gmailDraftId: evaluation.gmailDraft.gmailDraftId || reminder.draft?.gmailDraftId || null,
          gmailDraftAction: evaluation.gmailDraft.gmailDraftAction || null,
          gmailDraftError: evaluation.gmailDraft.gmailDraftError || null
        },
        lastEvaluatedAt: new Date().toISOString()
      });

      if (updatedReminder) {
        dueItems.push({
          ...updatedReminder,
          threadContext: {
            threadId: evaluation.sourceEmail?.threadId || updatedReminder.sourceThreadId || null,
            messageCount: Array.isArray(evaluation.threadMessages) ? evaluation.threadMessages.length : 0,
            firstMessage: Array.isArray(evaluation.threadMessages) && evaluation.threadMessages.length > 0 ? evaluation.threadMessages[0] : null,
            lastMessage:
              Array.isArray(evaluation.threadMessages) && evaluation.threadMessages.length > 0
                ? evaluation.threadMessages[evaluation.threadMessages.length - 1]
                : null,
            messages: Array.isArray(evaluation.threadMessages) ? evaluation.threadMessages : []
          }
        });
      }
    }

    return followUpResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "check_due",
          dueCount: dueItems.length,
          items: dueItems,
          message:
            dueItems.length > 0
              ? "Due follow-up reminders are ready for review."
              : "No due follow-up reminders right now.",
          nextStep:
            dueItems.length > 0
              ? "Review each reminder and call followup_send only for items explicitly approved to send."
              : "Run fetch for new inbox work, or followup_due later."
        })
      )
    );
  } catch (error) {
    logger.error("followup_due failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleGetThread(args, extra) {
  try {
    const input = parseSchema(getThreadSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);
    const transcript = await getThread({
      alias: binding.alias,
      threadId: payload.threadId,
      format: payload.format,
      latestN: payload.latestN,
      stripped: payload.stripped,
      includeRaw: payload.includeRaw
    });

    const formatNote =
      transcript.format === "metadata"
        ? "metadata only"
        : transcript.format === "latest"
          ? `latest (first + ${transcript.latestN} trailing)`
          : "full transcript";

    return getThreadToolResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "get_thread",
          ...transcript,
          summary: `Loaded thread ${transcript.threadId} (${formatNote}, ${transcript.messageCount || 0} message(s)). Full message text is in the markdown below — show message.text verbatim to the user; do not summarize. Call get_thread again for the next thread.`,
          workflowPolicy: INBOX_WORKFLOW_POLICY
        })
      )
    );
  } catch (error) {
    logger.error("get_thread failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleArchiveThread(args, extra) {
  try {
    const input = parseSchema(archiveThreadSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);
    const result = await archiveThread({ alias: binding.alias, threadId: payload.threadId });

    return toolResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "archive",
          threadId: result.threadId,
          appliedLabelIds: result.appliedLabelIds,
          summary: `Archived thread ${result.threadId} by removing the INBOX label.`
        })
      )
    );
  } catch (error) {
    logger.error("archive failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

function reminderMatchesStatus(reminder, statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) return true;
  return statuses.includes(reminder.status);
}

async function resolveFollowUpCleanupTargets(input, alias) {
  const all = await listFollowUpReminders();
  let pool = all.filter((r) => r.alias === alias && reminderMatchesStatus(r, input.statuses));

  if (input.deleteAll) {
    return pool;
  }

  const idSet = new Set();

  if (input.followUpChainId) {
    for (const r of pool) {
      if (r.followUpChainId === input.followUpChainId) {
        idSet.add(r.id);
      }
    }
  }

  if (input.messageId) {
    for (const r of pool) {
      if (r.sourceMessageId === input.messageId) {
        idSet.add(r.id);
      }
    }
  }

  if (input.messageHeaderId) {
    const targetHeaderId = normalizeMessageHeaderId(input.messageHeaderId);
    for (const r of pool) {
      if (normalizeMessageHeaderId(r.sourceMessageHeaderId) === targetHeaderId) {
        idSet.add(r.id);
      }
    }
  }

  if (input.sourceThreadId) {
    for (const r of pool) {
      if (r.sourceThreadId === input.sourceThreadId) {
        idSet.add(r.id);
      }
    }
  }

  if (Array.isArray(input.reminderIds)) {
    for (const reminderId of input.reminderIds) {
      const found = pool.find((r) => r.id === reminderId);
      if (!found) continue;
      idSet.add(found.id);
      if (input.cancelChain && found.followUpChainId) {
        for (const r of pool) {
          if (r.followUpChainId === found.followUpChainId) {
            idSet.add(r.id);
          }
        }
      }
    }
  }

  return pool.filter((r) => idSet.has(r.id));
}

async function handleFollowUpCleanup(args, extra) {
  try {
    const input = parseSchema(followUpCleanupSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);

    const targets = await resolveFollowUpCleanupTargets(payload, binding.alias);
    if (targets.length === 0) {
      throw new AppError(
        "No follow-up reminders matched your cleanup criteria for this account.",
        "NOT_FOUND",
        404
      );
    }

    const targetIds = new Set(targets.map((r) => r.id));
    const removed = await deleteFollowUpReminders((r) => r.alias === binding.alias && targetIds.has(r.id));

    const labelResults = [];
    if (payload.removeGmailLabel !== false) {
      const remaining = await listFollowUpReminders();
      const bySource = new Set(
        removed.map((r) => r.sourceMessageId).filter(Boolean)
      );
      for (const sourceMessageId of bySource) {
        const stillTracked = remaining.some(
          (r) => r.alias === binding.alias && r.sourceMessageId === sourceMessageId
        );
        if (!stillTracked) {
          labelResults.push(
            await untagSourceMessageFollowUp(binding.alias, sourceMessageId)
          );
        }
      }
    }

    logger.info("followup_cleanup", {
      alias: binding.alias,
      removedCount: removed.length,
      removedIds: removed.map((r) => r.id)
    });

    return followUpResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "cleanup",
          deletedCount: removed.length,
          deletedReminderIds: removed.map((r) => r.id),
          deletedMessageHeaderIds: removed.map((r) => r.sourceMessageHeaderId).filter(Boolean),
          items: removed,
          gmailLabelUntagged: labelResults.filter((r) => r.ok && !r.skipped).length,
          message:
            removed.length === 1
              ? "Follow-up reminder removed."
              : `Removed ${removed.length} follow-up reminder(s).`,
          nextStep: "Run status or followup_due to confirm nothing remains due."
        })
      )
    );
  } catch (error) {
    logger.error("followup_cleanup failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleSendFollowUp(args, extra) {
  try {
    const input = parseSchema(followUpSendSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);
    // Prefer the live session signer name over the one stored in the reminder,
    // since the reminder may have been created in a different session where the
    // signer had not yet been set (stored as null).
    const sessionSignerName = sessionSignerNames.get(scopeKey) || null;

    const reminder = await getFollowUpReminder(payload.reminderId);
    if (!reminder) {
      throw new AppError("Follow-up reminder not found", "NOT_FOUND", 404);
    }
    if (reminder.alias !== binding.alias) {
      throw new AppError("This reminder belongs to a different Gmail account", "FORBIDDEN", 403);
    }
    if (reminder.status === "sent") {
      throw new AppError("This follow-up has already been sent", "CONFLICT", 409);
    }
    if (reminder.status === "resolved_by_reply") {
      throw new AppError(
        "This thread already received a reply after the reminder was created",
        "CONFLICT",
        409
      );
    }

    const latestState = await refreshDueFollowUpReminder(reminder, { sessionSignerName });
    if (latestState.state === "resolved_by_reply") {
      await updateFollowUpReminder(reminder.id, {
        status: "resolved_by_reply",
        resolvedAt: new Date().toISOString(),
        resolutionReason: "Customer replied after the reminder was created.",
        summary: latestState.summary,
        topic: latestState.topic,
        latestExternalDate: latestState.latestExternalDate,
        draft: {
          ...reminder.draft,
          ...latestState.draft
        },
        lastEvaluatedAt: new Date().toISOString()
      });
      await untagSourceMessageFollowUp(reminder.alias, reminder.sourceMessageId);
      throw new AppError(
        "The customer already replied in this thread, so the follow-up was not sent.",
        "CONFLICT",
        409
      );
    }

    const finalDraft = {
      to: payload.to || latestState.draft.to || reminder.draft?.to,
      subject: payload.subject || latestState.draft.subject || reminder.draft?.subject,
      body: payload.body || latestState.draft.body || reminder.draft?.body
    };

    if (!finalDraft.to || !finalDraft.subject || !finalDraft.body) {
      throw new AppError(
        "to, subject, and body are required before sending a follow-up",
        "VALIDATION_ERROR",
        400
      );
    }

    const parts = resolveOutboundEmailParts({
      body: finalDraft.body,
      html: payload.html,
      format: payload.format
    });

    const sendResult = await sendFollowUpReminder(reminder, {
      to: finalDraft.to,
      subject: finalDraft.subject,
      body: parts.body,
      html: parts.html,
      cc: payload.cc,
      bcc: payload.bcc,
      quoteOriginal: payload.quoteOriginal,
      appendSignature: payload.appendSignature
    });

    const sentReminder = await updateFollowUpReminder(reminder.id, {
      status: "sent",
      sentAt: new Date().toISOString(),
      draft: {
        ...reminder.draft,
        ...finalDraft,
        gmailDraftId: null,
        gmailDraftAction: null,
        gmailDraftError: null
      },
      sentMessageId: sendResult.id,
      sentThreadId: sendResult.threadId,
      deletedDraftId: sendResult.deletedDraftId || null,
      lastEvaluatedAt: new Date().toISOString()
    });

    await untagSourceMessageFollowUp(binding.alias, reminder.sourceMessageId);

    const activatedNext = await activateNextFollowUpInChain(sentReminder);

    return followUpResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "send",
          sent: true,
          sentMessageId: sendResult.id,
          reminder: sentReminder,
          activatedNextReminder: activatedNext,
          message: activatedNext
            ? `Follow-up email sent. Next follow-up scheduled for ${activatedNext.dueAt}.`
            : "Follow-up email sent.",
          nextStep: activatedNext
            ? `Next follow-up (${activatedNext.id}) is due ${activatedNext.dueAt}. Run followup_due when ready.`
            : "Run followup_due to continue remaining due reminders."
        })
      )
    );
  } catch (error) {
    logger.error("followup_send failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

function buildWorkspaceStatusMarkdown(inner) {
  const lines = ["# Workspace status", ""];
  if (!inner.connected) {
    lines.push("**Connected account:** not connected yet", "");
    if (inner.nextSteps?.length) {
      lines.push("### First-time setup", ...inner.nextSteps.map((s) => `- ${s}`), "");
    }
    lines.push(
      "---",
      "",
      "*Advanced (only if your MCP host shares one process across many UI chats): see README for `chatScope`, `accountAlias`, and `pendingAlias`.*"
    );
    return lines.join("\n");
  }

  lines.push(
    `**Connected account:** ${inner.activeEmail}`,
    `**Account key (file alias):** \`${inner.accountKey}\``,
    `**Signer for drafts:** ${
      inner.signerReady ? `"${inner.signerName}"` : "Not set — ask the user, then run `set_signer`."
    }`,
    ""
  );

  if (inner.lastBatch) {
    lines.push(
      `**Last inbox batch:** ${inner.lastBatch.unreadDraftsPrepared} review drafts fetched at ${inner.lastBatch.fetchedAt}`,
      inner.lastBatch.markdownFile
        ? `**Optional file export (last run):** \`${inner.lastBatch.markdownFile}\`${inner.lastBatch.markdownSaved ? " (saved)" : ""}`
        : "**Optional file export (last run):** off",
      ""
    );
  } else {
    lines.push("**Last inbox batch:** none yet in this session — run `fetch` when ready.", "");
  }

  lines.push(`**Follow-ups due:** ${inner.followUpsDue}`, "", "### Paths on this machine", "");
  for (const row of inner.pathRows) {
    lines.push(`- **${row.label}:** \`${row.value}\``);
  }

  if (inner.nextSteps?.length) {
    lines.push("", "### Suggested next steps", ...inner.nextSteps.map((s) => `- ${s}`));
  }

  lines.push(
    "",
    "---",
    "",
    "*Advanced routing (`chatScope`, `accountAlias`, `pendingAlias`): see README — only needed for multiple accounts in one chat or shared MCP sessions.*"
  );

  return lines.join("\n");
}

function workspaceStatusDisplay(payload) {
  if (!payload.ok || !payload.data) {
    return toolResult(payload);
  }
  if (payload.data.responseMode === "compact") {
    const compact = [
      "# Workspace status (compact)",
      "",
      `Connected: ${payload.data.connected ? "yes" : "no"}`,
      `Account: ${payload.data.activeEmail ?? "—"}`,
      `Signer ready: ${payload.data.signerReady ? "yes" : "no"}`,
      `Follow-ups due: ${payload.data.followUpsDue ?? 0}`,
      payload.data.nextSteps?.[0] ? `Next: ${payload.data.nextSteps[0]}` : null,
      ""
    ].filter(Boolean);
    return {
      content: [{ type: "text", text: compact.join("\n") }],
      structuredContent: payload
    };
  }
  return {
    content: [{ type: "text", text: payload.data.displayMarkdown }],
    structuredContent: payload
  };
}

async function handleRunSetupDiagnostics(args, extra) {
  try {
    const input = parseSchema(runSetupDiagnosticsSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const credentialsPath = env.GOOGLE_CREDENTIALS_PATH;
    const accountsDir = env.ACCOUNTS_DIR;
    const remindersPath = env.FOLLOWUP_REMINDERS_PATH;
    const credentialsExists = await pathExists(credentialsPath);
    const accountsDirExists = await pathExists(accountsDir);
    const remindersExists = await pathExists(remindersPath);
    const accounts = await listAccounts().catch(() => []);
    let activeBinding = null;
    try {
      activeBinding = await resolveActiveBinding(scopeKey, input.accountAlias);
    } catch {
      activeBinding = null;
    }

    const checks = {
      credentialsExists,
      accountsDirExists,
      remindersStoreExists: remindersExists,
      savedAccountsCount: accounts.length,
      activeAccountConnected: Boolean(activeBinding)
    };

    const failures = Object.entries(checks).filter(
      ([key, value]) => ["savedAccountsCount"].includes(key) ? value === 0 : value === false
    );

    const nextStep =
      !credentialsExists
        ? "Add OAuth credentials file and retry."
        : accounts.length === 0
          ? "Run connect then connect_finish."
          : !activeBinding
            ? "Run status or pass accountAlias to target a saved account."
            : "Setup looks healthy. Continue with fetch.";

    return toolResult(
      okResponse({
        scopeKeyUsed: scopeKey,
        checks,
        activeEmail: activeBinding?.email || null,
        failedChecks: failures.map(([k]) => k),
        healthy: failures.length === 0,
        nextStep
      })
    );
  } catch (error) {
    logger.error("diagnostics failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleWorkspaceStatus(args, extra) {
  try {
    const input = parseSchema(workspaceStatusSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const signerName = sessionSignerNames.get(scopeKey) || null;
    const signerReady = Boolean(signerName && String(signerName).trim());

    const reviewMdFullPath = path.join(env.GMAIL_REVIEW_MARKDOWN_DIR, env.GMAIL_REVIEW_MARKDOWN_FILENAME);

    const pathRows = [
      { label: "Google OAuth client JSON", value: env.GOOGLE_CREDENTIALS_PATH },
      { label: "Saved accounts (tokens)", value: env.ACCOUNTS_DIR },
      { label: "Follow-up reminders store", value: env.FOLLOWUP_REMINDERS_PATH },
      { label: "Optional inbox review Markdown (if enabled on fetch)", value: reviewMdFullPath }
    ];

    let binding;
    try {
      binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    } catch (bindingError) {
      // If the caller passed an explicit accountAlias but it doesn't match any saved
      // token, return a clear INVALID_ALIAS error rather than the misleading "no account
      // connected / first-time setup" state (BUG-2).
      if (input.accountAlias && String(input.accountAlias).trim()) {
        const validAliases = await listAccounts().catch(() => []);
        const msg =
          `Alias '${input.accountAlias}' not found.` +
          (validAliases.length
            ? ` Valid aliases: ${validAliases.join(", ")}.`
            : " No accounts are connected on this machine yet.");
        return toolResult(
          errorResponse(
            new AppError(msg, "INVALID_ALIAS", 400)
          )
        );
      }

      const nextSteps = [
        "Run **`connect`** with a command like `Connect you@example.com personal`.",
        "Run **`connect_finish`** right after (browser login).",
        "Ask the user how replies should be signed, then **`set_signer`**.",
        'Run **`fetch`** with `mode="list"`, then **`get_thread`** per thread you need to reply to.'
      ];
      return workspaceStatusDisplay(
        okResponse({
          displayMarkdown: buildWorkspaceStatusMarkdown({ connected: false, nextSteps }),
          connected: false,
          scopeKeyUsed: scopeKey,
          signerName: null,
          signerReady: false,
          lastBatch: null,
          followUpsDue: 0,
          paths: Object.fromEntries(pathRows.map((r) => [r.label, r.value])),
          pathRows,
          nextSteps
        })
      );
    }

    const accountsBoundInThisChat = listSessionBindings(scopeKey);
    const dueReminders = (await listDuePendingFollowUps()).filter((r) => r.alias === binding.alias);
    const lastBatch = lastInboxFetchByScope.get(scopeKey) || null;

    const nextSteps = [];
    if (!signerReady) {
      nextSteps.push("Ask the user what name to use on reply drafts, then run **`set_signer`**.");
    }
    if (!lastBatch) {
      nextSteps.push(
        'When ready, run **`fetch`** with `mode="list"`, triage threads, then **`get_thread`** one at a time per thread you will reply to.'
      );
    }
    if (dueReminders.length > 0) {
      nextSteps.push(`**${dueReminders.length} follow-up(s) due** — run \`followup_due\` to review.`);
    }

    const inner = {
      connected: true,
      activeEmail: binding.email,
      accountKey: binding.alias,
      bindingSource: binding.bindingSource,
      signerName,
      signerReady,
      lastBatch,
      followUpsDue: dueReminders.length,
      pathRows,
      nextSteps,
      scopeKeyUsed: scopeKey,
      accountsBoundInThisChat,
      activeAlias: binding.alias
    };

    const displayMarkdown = buildWorkspaceStatusMarkdown(inner);

    return workspaceStatusDisplay(
      okResponse(
        withScopedUiHints(binding, {
          displayMarkdown,
          connected: true,
          signerName,
          signerReady,
          lastInboxBatch: lastBatch,
          followUpsDue: dueReminders.length,
          paths: Object.fromEntries(pathRows.map((r) => [r.label, r.value])),
          pathRows,
          dueFollowUpReminderIds: dueReminders.map((r) => r.id),
          nextSteps,
          accountsBoundInThisChat
        })
      )
    );
  } catch (error) {
    logger.error("status failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

export function registerTools(server) {
  const registerToolWithPrefix = (name, config, handler) => {
    server.registerTool(`multi_gmail_${name}`, config, handler);
    server.registerTool(name, config, handler);
  };

  // ─── Auth tools ────────────────────────────────────────────────────────────

  registerToolWithPrefix(
    "help",
    {
      title: "Simple first-time setup walkthrough",
      description:
        "Shows setup and the recommended inbox workflow: fetch mode=list, triage metadata, get_thread one thread at a time, draft, send after approval.",
      inputSchema: helpOnboardingSchema
    },
    async (args) => {
      try {
        parseSchema(helpOnboardingSchema, args);
        return {
          content: [{ type: "text", text: buildOnboardingMarkdown() }],
          structuredContent: okResponse({ markdown: buildOnboardingMarkdown() })
        };
      } catch (error) {
        logger.error("help failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );

  registerToolWithPrefix(
    "connect",
    {
      title: "Start Gmail login (opens browser)",
      description:
        'Start Gmail login with `Connect you@example.com personal` or `Connect you@example.com work`. Browser opens for approval. ' +
        "Then run `connect_finish` immediately to finish setup.",
      inputSchema: connectAccountSchema
    },
    async (args, extra) => {
      try {
        const input = parseSchema(connectAccountSchema, args);
        const scopeKey = resolveScopeKey(extra, input);
        const data = await beginScopedAuthorization(input.command, scopeKey);
        return toolResult(
          okResponse({
            ...data,
            scopeKeyUsed: scopeKey,
            nextStep:
              (input.chatScope
                ? `Pass the same chatScope ("${input.chatScope}") on connect_finish and every later tool in this chat. `
                : "") +
              "Browser opened automatically. Call connect_finish NOW (no code needed) — it will wait for the user to approve and then complete automatically.",
            scopedChatPolicy: "multi_account_per_chat",
            multiAccountHint:
              "The latest completed connect becomes the default account for tools that omit accountAlias. Pass accountAlias (from accounts or the alias field) to use a specific account."
          })
        );
      } catch (error) {
        logger.error("connect failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );

  registerToolWithPrefix(
    "connect_finish",
    {
      title: "Finish Gmail login (after browser approve)",
      description:
        "Finish Gmail login after browser approval. Waits if needed; no manual code copy required. " +
        "After success, run `set_signer`, then `fetch`.",
      inputSchema: completeConnectAccountSchema
    },
    async (args, extra) => {
      try {
        const input = parseSchema(completeConnectAccountSchema, args);
        const scopeKey = resolveScopeKey(extra, input);
        const binding = await completeScopedAuthorization(input.code, scopeKey, input.pendingAlias);
        const boundInChat = listSessionBindings(scopeKey);

        let gmailMcpLabels = null;
        let gmailMcpLabelsError = null;
        try {
          gmailMcpLabels = await ensureMcpGmailLabelsForAccount(binding.alias);
        } catch (err) {
          gmailMcpLabelsError = err?.message || String(err);
          logger.warn("connect_finish: Gmail MCP labels bootstrap failed", {
            message: gmailMcpLabelsError
          });
        }

        return toolResult(
          okResponse({
            ...binding,
            activeEmail: binding.email,
            scoped: true,
            scopeKeyUsed: scopeKey,
            accountsBoundInThisChat: boundInChat,
            renameChatTo: binding.suggestedChatTitle,
            requiresSignerName: true,
            gmailMcpLabels,
            gmailMcpLabelsError,
            nextStep:
              boundInChat.length > 1
                ? "Multiple accounts are connected here. Tools without accountAlias use the most recently completed one. Pass accountAlias to target a specific inbox. Ask the user what name to use for signers (you may need set_signer per account workflow)."
                : "Ask the user: 'What name should I use to sign your draft emails?' then call set_signer with their answer."
          })
        );
      } catch (error) {
        logger.error("connect_finish failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );

  registerToolWithPrefix(
    "setup_labels",
    {
      title: "Create MCP Gmail sidebar labels if missing",
      description:
        "Calls the Gmail API to **create** the configured user labels (`FOLLOW_UP_GMAIL_LABEL_*`, `GMAIL_REVIEW_GMAIL_LABEL_*`) so they appear under **Labels** in Gmail—no manual label setup. " +
        "Use this if labels did not appear after connect or fetch (e.g. old OAuth token missing **gmail.modify** — re-run `npm run auth -- --alias ...` then reconnect). " +
        "Pass accountAlias / chatScope like other Gmail tools.",
      inputSchema: ensureMcpGmailLabelsSchema
    },
    async (args, extra) => {
      try {
        const input = parseSchema(ensureMcpGmailLabelsSchema, args);
        const scopeKey = resolveScopeKey(extra, input);
        const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
        const data = await ensureMcpGmailLabelsForAccount(binding.alias);
        return toolResult(okResponse(withScopedUiHints(binding, data)));
      } catch (error) {
        logger.error("setup_labels failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );

  registerToolWithPrefix(
    "accounts",
    {
      title: "List Gmail accounts saved on this computer",
      description:
        "Returns token file aliases (strings). Pass one as accountAlias on other tools when the MCP client shares one default session across chats.",
      inputSchema: listAccountsSchema
    },
    async (args) => {
      try {
        parseSchema(listAccountsSchema, args);
        const accounts = await listAccounts();
        return toolResult(okResponse({ accounts }));
      } catch (error) {
        logger.error("accounts failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );

  registerToolWithPrefix(
    "set_signer",
    {
      title: "Set the name signed on reply drafts",
      description:
        "Saves the display name used on reply drafts for this session, and optionally the Gmail follow-up label name. Call after login when the user says how they want to sign. " +
        "Advanced: `chatScope` / `accountAlias` only if README multi-account or shared-session section applies.",
      inputSchema: setSignerNameSchema
    },
    async (args, extra) => {
      try {
        const input = parseSchema(setSignerNameSchema, args);
        const scopeKey = resolveScopeKey(extra, input);
        const trimmedName = input.name.trim();

        // Defense-in-depth: reject any remaining control characters even after
        // Zod validation, in case the MCP host passes args before schema enforcement.
        // \r / \n would allow header injection; \x00 is a null-byte poison.
        if (/[\r\n\t\x00]/.test(trimmedName)) {
          throw new AppError(
            "Signer name must not contain control characters (CR, LF, TAB, or null byte).",
            "VALIDATION_ERROR",
            400
          );
        }

        sessionSignerNames.set(scopeKey, trimmedName);
        logger.info("set_signer: stored", { scopeKey, name: trimmedName });
        if (input.followUpLabel) {
          const trimmedLabel = input.followUpLabel.trim();
          sessionFollowUpLabels.set(scopeKey, trimmedLabel);
          logger.info("set_signer: stored followUpLabel", { scopeKey, label: trimmedLabel });
        }
        return toolResult(
          okResponse({
            signerName: trimmedName,
            followUpLabel: sessionFollowUpLabels.get(scopeKey) || null,
            stored: true,
            message: `Saved. Replies will be signed as "${trimmedName}".`
          })
        );
      } catch (error) {
        logger.error("set_signer failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );

  registerToolWithPrefix(
    "set_mode",
    {
      title: "Set response style for this chat",
      description:
        "Choose `standard` (default) or `compact` response mode for this chat scope.",
      inputSchema: setResponseModeSchema
    },
    async (args, extra) => {
      try {
        const input = parseSchema(setResponseModeSchema, args);
        const scopeKey = resolveScopeKey(extra, input);
        sessionResponseModes.set(scopeKey, input.mode);
        return toolResult(
          okResponse({
            scopeKeyUsed: scopeKey,
            responseMode: input.mode,
            nextStep: "Run status to confirm output in the selected style."
          })
        );
      } catch (error) {
        logger.error("set_mode failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );

  registerToolWithPrefix(
    "status",
    {
      title: "Workspace summary (account, signer, follow-ups, paths)",
      description:
        "Shows account connection, signer name, last inbox batch, due follow-ups, and local paths. Use this first when unsure what to do next.",
      inputSchema: workspaceStatusSchema
    },
    handleWorkspaceStatus
  );

  registerToolWithPrefix(
    "diagnostics",
    {
      title: "Check setup health in one command",
      description:
        "Verifies credentials path, accounts storage, reminders store, and active account binding, then suggests the next action.",
      inputSchema: runSetupDiagnosticsSchema
    },
    handleRunSetupDiagnostics
  );

  // ─── Inbox: fetch drafts + send approved reply ──────────────────────────────

  registerToolWithPrefix(
    "fetch",
    {
      title: "List inbox threads or batch-fetch (legacy)",
      description:
        "Recommended: mode=list (default) returns lightweight metadata for triage (subject, snippet, threadId). Snippets are not full email bodies — call get_thread(threadId) for each thread the user should read or reply to, and present message.text verbatim (do not summarize). Never load multiple full threads in one context. " +
        "queryMode=inbox (default) prepends inbox review filters (in:inbox, exclude follow-up label). queryMode=raw passes query to Gmail unchanged — use for sent mail, archives, all-mail, and date-filtered analysis (e.g. in:sent after:2026/01/01). " +
        "Legacy mode=full batch-loads bodies and auto-drafts every thread (token-heavy; avoid for normal inbox review). Nothing is sent automatically.",
      inputSchema: fetchUnreadSmartDraftsSchema
    },
    handleFetchUnreadSmartDrafts
  );

  registerToolWithPrefix(
    "get_thread",
    {
      title: "Get one Gmail thread as a clean transcript",
      description:
        "Load one Gmail thread at a time (use after fetch mode=list). format=full (default) returns plain-text message bodies. Use stripped=false to read the full email; stripped=true removes quoted reply history when drafting in multi-message threads. format=latest trims to first + latestN messages. Present message.text verbatim to the user — do not summarize. Call separately per thread.",
      inputSchema: getThreadSchema
    },
    handleGetThread
  );

  registerToolWithPrefix(
    "archive",
    {
      title: "Archive one Gmail thread",
      description:
        "Archive a Gmail thread for the active account by removing the INBOX label. Use threadId from fetch, followup_due, or get_thread.",
      inputSchema: archiveThreadSchema
    },
    handleArchiveThread
  );

  registerToolWithPrefix(
    "send",
    {
      title: "Send one approved reply",
      description:
        "Send one approved **reply**. Requires `messageId` (marks source read, threads send). Provide `body`; set `format` to `text/html` for HTML (default `text/plain`). Legacy `html` still supported. " +
        "`quoteOriginal` (default true) appends Gmail-style quoted parent history below the new body. " +
        "`appendSignature` (default true) appends the account Gmail signature from Settings above the quote block. " +
        "For new outbound / campaigns use `send_new` instead. Never run without explicit approval.",
      inputSchema: sendSmartReplyBaseSchema
    },
    handleSendSmartReply
  );

  registerToolWithPrefix(
    "send_new",
    {
      title: "Send one approved new outbound email",
      description:
        "Send one approved **new** email. Use for campaigns and cold outreach — no `messageId`. " +
        "Optional `threadId` from a prior send to add the next message in the same Gmail thread (campaign email 2+). " +
        "Requires `to` and `subject`; German/Unicode subjects are RFC 2047–encoded automatically. " +
        "Provide `body` with `format` `text/html` for HTML campaigns (default `text/plain`). Legacy `htmlBody` still supported. Never run without explicit approval.",
      inputSchema: sendNewEmailBaseSchema
    },
    handleSendNewEmail
  );

  // ─── Follow-up reminders ───────────────────────────────────────────────────

  registerToolWithPrefix(
    "set_draft",
    {
      title: "Save or update a Gmail draft reply",
      description:
        "Save/update a Gmail draft reply for a thread without sending. Requires `messageId`, `to`, `subject`, and `body`; use `format` `text/html` for HTML drafts (default `text/plain`). " +
        "`quoteOriginal` (default true) appends Gmail-style quoted parent history so drafts show the collapsible history expander in Gmail. " +
        "`appendSignature` (default true) appends the account Gmail signature from Settings above the quote block.",
      inputSchema: setDraftReplySchema
    },
    handleSetDraftReply
  );

  registerToolWithPrefix(
    "followup_trigger",
    {
      title: "Create or update follow-up reminders for a thread",
      description:
        "Create follow-up reminders using `daysList` or `pattern`, or update the existing open follow-up plan for the same thread. " +
        "For `daysList: [1, 3]`: follow-up 1 is due in 1 day from now; follow-up 2 is due 3 days after follow-up 1 is sent (not 3 days from today). " +
        "Each value after the first is always an interval after the previous follow-up send. Example: 1 day, then 3 days after the first — use `[1, 3]`, not `[1, 2]`.",
      // Use base schema (plain z.object) for MCP registration — the SDK's JSON Schema
      // normaliser cannot serialise ZodEffects (from superRefine) and would produce an
      // empty properties block, stripping all arguments before the handler runs (BUG-1).
      // Cross-field validation (pattern vs daysList) is enforced inside the
      // handler via parseSchema(followUpTriggerSchema, args).
      inputSchema: followUpTriggerBaseSchema
    },
    handleTriggerFollowUp
  );

  registerToolWithPrefix(
    "followup_due",
    {
      title: "List follow-up reminders that are due now",
      description:
        "List reminders due now for the active account and refresh thread state before review. " +
        "Returns the refreshed full thread context for each due reminder. Always present the full draft to the user for proof-reading before any send action. Never call followup_send without explicit user approval.",
      inputSchema: followUpCheckDueSchema
    },
    handleCheckDueFollowUps
  );

  registerToolWithPrefix(
    "followup_send",
    {
      title: "Send one follow-up the user approved",
      description:
        "Send one approved follow-up reminder. Re-checks the thread first and blocks send if customer already replied. " +
        "Optional overrides: `body`, `format` (`text/plain` default, `text/html` for HTML), `quoteOriginal` (default true), `appendSignature` (default true). IMPORTANT: NEVER call without explicit user approval after showing the draft.",
      inputSchema: followUpSendSchema
    },
    handleSendFollowUp
  );

  registerToolWithPrefix(
    "followup_cleanup",
    {
      title: "Delete stored follow-up reminders",
      description:
        "Remove follow-up reminder(s) from the local store. Pass reminderIds, messageId, messageHeaderId, sourceThreadId, or followUpChainId. " +
        "Use cancelChain: true with reminderIds to drop an entire chained sequence. " +
        "Use deleteAll: true with confirm: true to clear all reminders for the account. " +
        "Optionally removes the Gmail follow-up label when no reminders remain for a thread.",
      inputSchema: followUpCleanupBaseSchema
    },
    handleFollowUpCleanup
  );

  registerToolWithPrefix(
    "fetch_drafts",
    {
      title: "List Gmail Drafts folder",
      description: "List drafts saved in Gmail Drafts folder. Separate from inbox. Use to review unsent drafts.",
      inputSchema: fetchDraftsSchema
    },
    async (args, extra) => {
      try {
        const input = parseSchema(fetchDraftsSchema, args);
        const scopeKey = resolveScopeKey(extra, input);
        const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
        const data = await fetchGmailDrafts({ alias: binding.alias, maxResults: input.maxResults });
        return toolResult(okResponse(withScopedUiHints(binding, data)));
      } catch (error) {
        logger.error("fetch_drafts failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );

  registerToolWithPrefix(
    "fetch_sent",
    {
      title: "List Gmail Sent folder (deprecated)",
      description:
        "Deprecated — prefer multi_gmail_fetch with queryMode=raw and a Gmail query such as in:sent after:2026/01/01 before:2026/04/01 for filtered sent-mail analysis. " +
        "This tool still lists the latest messages in Gmail Sent without date/query filters.",
      inputSchema: fetchSentSchema
    },
    async (args, extra) => {
      try {
        const input = parseSchema(fetchSentSchema, args);
        const scopeKey = resolveScopeKey(extra, input);
        const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
        const data = await fetchGmailSent({ alias: binding.alias, maxResults: input.maxResults });
        return toolResult(
          okResponse(
            withScopedUiHints(binding, {
              ...data,
              deprecated: true,
              deprecationNotice:
                "Use multi_gmail_fetch with queryMode=raw and query like in:sent after:2026/01/01 before:2026/04/01 instead."
            })
          )
        );
      } catch (error) {
        logger.error("fetch_sent failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );
}
