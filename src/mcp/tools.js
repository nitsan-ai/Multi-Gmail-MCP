import {
  beginScopedAuthorization,
  completeScopedAuthorization,
  resolveActiveBinding,
  listAccounts,
  listSessionBindings
} from "../auth/account-manager.js";
import { env } from "../config/env.js";
import {
  sendEmail,
  setReplyDraft,
  fetchUnreadSummariesAndReplyDrafts,
  markAsRead,
  removeInboxReviewGmailLabel,
  ensureMcpGmailLabelsForAccount,
  fetchGmailDrafts,
  fetchGmailSent
} from "../gmail/gmail-service.js";
import {
  createFollowUpReminder,
  getFollowUpReminder,
  listDuePendingFollowUps,
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
import { promises as fs } from "fs";
import path from "path";
import { AppError, errorResponse, okResponse } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  helpOnboardingSchema,
  ensureMcpGmailLabelsSchema,
  completeConnectAccountSchema,
  connectAccountSchema,
  fetchUnreadSmartDraftsSchema,
  fetchDraftsSchema,
  fetchSentSchema,
  followUpCheckDueSchema,
  followUpTriggerBaseSchema,
  followUpTriggerSchema,
  followUpSendSchema,
  listAccountsSchema,
  runSetupDiagnosticsSchema,
  sendSmartReplySchema,
  setDraftReplySchema,
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

function buildCompactInboxMarkdown(data) {
  const lines = [
    "# Inbox review (compact)",
    "",
    `Account: ${data.activeEmail ?? "—"}`,
    `Inbox messages in batch: ${data.inboxCount ?? data.unreadCount ?? 0}`,
    "Safety: nothing is sent automatically",
    ""
  ];

  if (Array.isArray(data.items) && data.items.length > 0) {
    for (const [index, item] of data.items.entries()) {
      lines.push(
        `${index + 1}) ${item.subject || "(no subject)"}`,
        `   from: ${item.from || "—"}`,
        `   messageId: ${item.messageId}`,
        ""
      );
    }
    lines.push(
      "Next: say send/edit/cancel for each item, then use send only for approved drafts.",
      "Note: When generating or editing drafts, avoid reusing previously addressed content from the thread history and generate a fresh, context-aware response instead.",
      ""
    );
  } else {
    lines.push("No inbox messages in this batch.", "");
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
    "# Inbox review",
    "",
    "> **Review drafts** — Every message below has a proposed reply in this run. **Do not send** until the user confirms each one. When generating or editing drafts, avoid reusing previously addressed content from the thread history and generate a fresh, context-aware response instead. When they approve, call **`send`** to deliver to the recipient and mark the original as read. Show **all** items; the user chooses send / edit / skip **per** message. Raise **`maxResults`** if they want more than one batch.",
    ""
  ];

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
    `**Inbox messages in this batch:** ${data.inboxCount ?? data.unreadCount ?? 0}`,
    `**Ready to send:** only after explicit approval per message (nothing sent automatically)`,
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
      lines.push(`- **messageId:** \`${item.messageId}\``);
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
      "- **send** — sends the draft and marks the email as read",
      "- **edit** — paste your revised text and confirm",
      "- **cancel** — discard this draft",
      "",
      "> IMPORTANT: Nothing is sent until you explicitly say **send** for a specific email.",
      ""
    );
  } else {
    lines.push(data.draftsMarkdown || "_No inbox messages in this run._", "");
  }

  return lines.join("\n");
}

function smartAssistantFetchResult(payload) {
  if (!payload.ok || !payload.data) {
    return toolResult(payload);
  }
  const chatMarkdown =
    payload.data.responseMode === "compact"
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
    `- **From:** ${item.sourceFrom || "—"}`,
    `- **Due:** ${item.dueAt || "—"}`,
    `- **Status:** ${item.status || "pending"}`,
    `- **Summary:** ${item.summary || "—"}`,
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
    "> Nothing is sent automatically. Only call `followup_send` when the user explicitly says `send`.",
    ""
  ];

  return lines.join("\n");
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
    "5. Run `fetch` and review drafts.",
    "6. Send only approved drafts with `send`.",
    "",
    "Safety:",
    "- Nothing is sent automatically.",
    "- You must explicitly approve each send action.",
    "",
    "Optional:",
    "- Run `set_mode` with `compact` for shorter responses.",
    "- Run `diagnostics` if setup/auth feels broken.",
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
  const now = new Date();
  const base = options.businessDaysOnly
    ? addBusinessDaysUtc(now, days)
    : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
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

function parseFollowUpPattern(pattern) {
  const text = String(pattern || "").trim();
  if (!text) return [];
  const matches = text.match(/\d+/g) || [];
  return Array.from(new Set(matches.map((item) => Number.parseInt(item, 10)).filter(Number.isFinite))).sort((a, b) => a - b);
}

async function handleFetchUnreadSmartDrafts(args, extra) {
  try {
    const input = parseSchema(fetchUnreadSmartDraftsSchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const signerName = sessionSignerNames.get(scopeKey) || null;
    const payload = omitRoutingFields(input);

    logger.info("fetch", {
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
      writeMarkdownFile: payload.writeMarkdownFile,
      signerName,
      saveGmailDrafts: payload.saveGmailDrafts
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

async function handleSendSmartReply(args, extra) {
  try {
    const input = parseSchema(sendSmartReplySchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);

    logger.info("send", {
      messageId: payload.messageId,
      to: payload.to,
      subject: payload.subject
    });

    const sendResult = await sendEmail({
      alias: binding.alias,
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      cc: payload.cc,
      bcc: payload.bcc,
      sourceMessageId: payload.messageId
    });

    const markResult = await markAsRead({
      alias: binding.alias,
      messageId: payload.messageId
    });

    const reviewLabelRemoved = await removeInboxReviewGmailLabel({
      alias: binding.alias,
      messageId: payload.messageId
    });

    logger.info("send complete", {
      sentId: sendResult.id,
      markedRead: markResult.messageId
    });

    return toolResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "send",
          sent: true,
          sentMessageId: sendResult.id,
          threadId: sendResult.threadId,
          deletedDraftId: sendResult.deletedDraftId,
          deletedDraft: sendResult.deletedDraft,
          deletedDraftError: sendResult.deletedDraftError,
          markedReadMessageId: markResult.messageId,
          gmailInboxReviewLabelRemoved: reviewLabelRemoved.removed,
          gmailInboxReviewLabelName: reviewLabelRemoved.labelName,
          summary: (() => {
            const to = Array.isArray(payload.to) ? payload.to.join(", ") : payload.to;
            let tail = "";
            if (reviewLabelRemoved.removed) {
              tail += `, inbox-review label "${reviewLabelRemoved.labelName}" removed from source`;
            }
            if (sendResult.deletedDraft) {
              tail += ", and the matching Gmail draft was removed";
            } else if (sendResult.deletedDraftError) {
              tail += `, but draft cleanup failed: ${sendResult.deletedDraftError}`;
            }
            return `Email sent to ${to}, source message marked as read${tail}.`;
          })(),
          nextStep:
            "Run fetch to review the next batch, or followup_due to review due follow-ups."
        })
      )
    );
  } catch (error) {
    logger.error("send failed", { message: error.message });
    return toolResult(errorResponse(error));
  }
}

async function handleSetDraftReply(args, extra) {
  try {
    const input = parseSchema(setDraftReplySchema, args);
    const scopeKey = resolveScopeKey(extra, input);
    const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
    const payload = omitRoutingFields(input);

    logger.info("set_draft", {
      messageId: payload.messageId,
      to: payload.to,
      subject: payload.subject
    });

    const result = await setReplyDraft({
      alias: binding.alias,
      sourceMessageId: payload.messageId,
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      cc: payload.cc,
      bcc: payload.bcc
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

    const reminders = [];
    for (const days of reminderDaysList) {
      const reminder = await createFollowUpReminder({
        alias: binding.alias,
        activeEmail: binding.email,
        signerName,
        createGmailDraft: payload.createGmailDraft,
        reminderDays: days,
        dueAt: resolveReminderDueAt(days, {
          businessDaysOnly: schedulePolicy.businessDaysOnly,
          dueWeekday: schedulePolicy.dueWeekday
        }),
        scheduleRule: {
          businessDaysOnly: schedulePolicy.businessDaysOnly,
          dueWeekday: schedulePolicy.dueWeekday
        },
        sourceMessageId: generated.sourceEmail.id,
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
      });
      reminders.push(reminder);
    }

    logger.info("followup_trigger", {
      reminderIds: reminders.map((r) => r.id),
      sourceMessageId: generated.sourceEmail.id,
      dueAt: reminders.map((r) => r.dueAt)
    });

    const labelSync = await tagSourceMessageForFollowUp(binding.alias, generated.sourceEmail.id);

    return followUpResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "create",
          createdReminderId: reminders[0]?.id || null,
          createdReminderIds: reminders.map((r) => r.id),
          reminder: reminders.length === 1 ? reminders[0] : undefined,
          items: reminders,
          message:
            reminders.length === 1
              ? "Follow-up reminder created."
              : `Follow-up reminders created (${reminders.length} milestones).`,
          schedule: {
            reminderDays: reminderDaysList,
            businessDaysOnly: schedulePolicy.businessDaysOnly,
            dueWeekday: schedulePolicy.dueWeekday
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
        dueItems.push(updatedReminder);
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

    const sendResult = await sendFollowUpReminder(reminder, {
      ...finalDraft,
      cc: payload.cc,
      bcc: payload.bcc
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

    return followUpResult(
      okResponse(
        withScopedUiHints(binding, {
          action: "send",
          sent: true,
          sentMessageId: sendResult.id,
          reminder: sentReminder,
          message: "Follow-up email sent.",
          nextStep: "Run followup_due to continue remaining due reminders."
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
        "Run **`fetch`** to load unread mail and review drafts in chat."
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
      nextSteps.push("When ready, run **`fetch`** once — it builds reply drafts and review text in chat (and the review `.md` by default; set `writeMarkdownFile: false` to skip the file).");
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
        "Shows a step-by-step beginner flow: connect account, finish auth, set signer, review drafts, and send safely.",
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
      title: "Fetch inbox emails and draft a reply for each",
      description:
        "Fetch inbox emails (all inbox categories) and generate a draft reply for each (default up to 10). " +
        "Nothing is sent automatically. Review drafts first, then call `send` only after explicit approval. " +
        "When generating drafts, avoid reusing previously addressed content from the thread history and generate a fresh, context-aware response instead.",
      inputSchema: fetchUnreadSmartDraftsSchema
    },
    handleFetchUnreadSmartDrafts
  );

  registerToolWithPrefix(
    "send",
    {
      title: "Send one reply the user approved (real email)",
      description:
        "Send one approved reply and mark the source message as read. Requires `messageId`, `to`, `subject`, and `body` from a reviewed draft. Never run without explicit approval.",
      inputSchema: sendSmartReplySchema
    },
    handleSendSmartReply
  );

  // ─── Follow-up reminders ───────────────────────────────────────────────────

  registerToolWithPrefix(
    "set_draft",
    {
      title: "Save or update a Gmail draft reply",
      description:
        "Save/update a Gmail draft reply for a thread without sending. Requires `messageId`, `to`, `subject`, and `body` from a reviewed draft.",
      inputSchema: setDraftReplySchema
    },
    handleSetDraftReply
  );

  registerToolWithPrefix(
    "followup_trigger",
    {
      title: "Create follow-up reminders using pattern or days list",
      description:
        "Create follow-up reminders for a thread using either `pattern` (e.g. '1st follow after 10 days, 2nd follow after 15 days') or explicit `daysList`.",
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
        "List reminders due now for the active account and refresh thread state before review.",
      inputSchema: followUpCheckDueSchema
    },
    handleCheckDueFollowUps
  );

  registerToolWithPrefix(
    "followup_send",
    {
      title: "Send one follow-up the user approved",
      description:
        "Send one approved follow-up reminder. Re-checks the thread first and blocks send if customer already replied.",
      inputSchema: followUpSendSchema
    },
    handleSendFollowUp
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
      title: "List Gmail Sent folder",
      description: "List messages in Gmail Sent folder. Separate from inbox. Use to review previously sent emails.",
      inputSchema: fetchSentSchema
    },
    async (args, extra) => {
      try {
        const input = parseSchema(fetchSentSchema, args);
        const scopeKey = resolveScopeKey(extra, input);
        const binding = await resolveActiveBinding(scopeKey, input.accountAlias);
        const data = await fetchGmailSent({ alias: binding.alias, maxResults: input.maxResults });
        return toolResult(okResponse(withScopedUiHints(binding, data)));
      } catch (error) {
        logger.error("fetch_sent failed", { message: error.message });
        return toolResult(errorResponse(error));
      }
    }
  );
}
