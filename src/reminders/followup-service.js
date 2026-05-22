import { promises as fs } from "fs";
import { createGmailClient } from "../gmail/gmail-client.js";
import { sendEmail } from "../gmail/gmail-service.js";
import { env } from "../config/env.js";
import { formatFullMessage, encodeEmail } from "../utils/gmail-formatters.js";

function sanitizeHeaderValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function normalizeEmailAddress(value) {
  const raw = String(value || "").trim().toLowerCase();
  const bracketMatch = raw.match(/<([^>]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }

  const emailMatch = raw.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
  return emailMatch ? emailMatch[0].toLowerCase() : raw;
}

function extractDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const bracketIndex = raw.indexOf("<");
  const candidate = bracketIndex >= 0 ? raw.slice(0, bracketIndex).trim() : raw;
  return candidate.replace(/^["']|["']$/g, "").trim();
}

function buildReplyHeaders(sourceEmail, reminderId) {
  const headers = [];
  const messageHeaderId = sanitizeHeaderValue(sourceEmail?.messageHeaderId);
  const referencesHeader = sanitizeHeaderValue(sourceEmail?.referencesHeader);
  const sourceMessageId = sanitizeHeaderValue(sourceEmail?.id);
  const sourceThreadId = sanitizeHeaderValue(sourceEmail?.threadId);

  if (messageHeaderId) {
    headers.push(`In-Reply-To: ${messageHeaderId}`);
    const references = [referencesHeader, messageHeaderId].filter(Boolean).join(" ").trim();
    if (references) headers.push(`References: ${references}`);
  }
  if (sourceMessageId) headers.push(`X-Smart-Email-Source-Message-Id: ${sourceMessageId}`);
  if (sourceThreadId) headers.push(`X-Smart-Email-Source-Thread-Id: ${sourceThreadId}`);
  if (reminderId) headers.push(`X-FollowUp-Reminder-Id: ${sanitizeHeaderValue(reminderId)}`);
  return headers;
}

function buildRawEmail({ to, subject, body, cc, bcc, extraHeaders = [] }) {
  const formatAddress = (addr) => (Array.isArray(addr) ? addr.join(", ") : addr);

  let headers = `To: ${formatAddress(to)}\r\n`;
  headers += `Subject: ${subject}\r\n`;
  if (cc) headers += `Cc: ${formatAddress(cc)}\r\n`;
  if (bcc) headers += `Bcc: ${formatAddress(bcc)}\r\n`;
  for (const headerLine of extraHeaders) {
    const trimmed = String(headerLine || "").trim();
    if (trimmed) headers += `${trimmed}\r\n`;
  }
  headers += "Content-Type: text/plain; charset=utf-8\r\n\r\n";
  headers += body;
  return encodeEmail(headers);
}

async function findExistingFollowUpDraftId(gmail, { reminderId, sourceMessageId }) {
  let pageToken;

  do {
    const listRes = await gmail.users.drafts.list({
      userId: env.DEFAULT_GMAIL_USER_ID,
      maxResults: 100,
      pageToken
    });
    const drafts = listRes.data.drafts || [];

    for (const draft of drafts) {
      const draftRes = await gmail.users.drafts.get({
        userId: env.DEFAULT_GMAIL_USER_ID,
        id: draft.id,
        format: "metadata",
        metadataHeaders: ["X-FollowUp-Reminder-Id", "X-Smart-Email-Source-Message-Id"]
      });
      const headers = draftRes.data.message?.payload?.headers || [];
      const followUpHeader = headers.find(
        (header) => header.name?.toLowerCase() === "x-followup-reminder-id"
      );
      if (reminderId && followUpHeader?.value?.trim() === reminderId) {
        return draft.id;
      }

      const sourceHeader = headers.find(
        (header) => header.name?.toLowerCase() === "x-smart-email-source-message-id"
      );
      if (sourceMessageId && sourceHeader?.value?.trim() === sourceMessageId) {
        return draft.id;
      }
    }

    pageToken = listRes.data.nextPageToken || null;
  } while (pageToken);

  return null;
}

function cleanBodyForSummary(bodyText) {
  return String(bodyText || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith(">") && !/^on .+wrote:$/i.test(trimmed);
    })
    .join("\n")
    .trim();
}

function extractTopic(subject, bodyText) {
  const cleanBody = cleanBodyForSummary(bodyText);
  const firstSentence = cleanBody
    .split(/\n|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => sentence.length >= 24);

  if (firstSentence) {
    return firstSentence.replace(/\s+/g, " ").slice(0, 180);
  }

  const cleanSubject = String(subject || "").replace(/^re:\s*/i, "").trim();
  return cleanSubject || "your earlier message";
}

function extractRecipient(sourceEmail) {
  const to = normalizeEmailAddress(sourceEmail.replyToHeader || sourceEmail.from);
  const name = extractDisplayName(sourceEmail.from) || "there";
  return { to, name };
}

function replySubjectLine(subject) {
  const clean = String(subject || "").trim();
  if (!clean) return "Re: Follow-up";
  return /^re:\s/i.test(clean) ? clean : `Re: ${clean}`;
}

function fallbackSigner(alias, signerName) {
  return String(signerName || "").trim() || String(alias || "").trim() || "Support";
}

function buildEnglishFollowUp({ recipientName, topic, signer }) {
  const open = recipientName && recipientName.toLowerCase() !== "there" ? `Hi ${recipientName},` : "Hi,";
  return [
    open,
    "",
    `I wanted to follow up on your earlier message about ${topic}.`,
    "If this is still on your list, I am happy to help with the next step or answer any open questions.",
    "Just reply here whenever convenient and I will take it from there.",
    "",
    "Best regards,",
    `${signer}`
  ].join("\n");
}

function buildThreadSummary(anchorMessage, threadMessages, accountEmail) {
  const externalMessages = threadMessages.filter(
    (message) => normalizeEmailAddress(message.from) !== normalizeEmailAddress(accountEmail)
  );
  const latestExternal = externalMessages[externalMessages.length - 1] || anchorMessage;
  const topic = extractTopic(latestExternal.subject, latestExternal.bodyText);

  return {
    topic,
    summary: `Latest customer context: ${topic}`,
    latestExternalMessageId: latestExternal.id,
    latestExternalDate: latestExternal.internalDate || latestExternal.date || null
  };
}

async function loadThreadContext(alias, messageId) {
  const { gmail } = await createGmailClient(alias);
  const sourceRes = await gmail.users.messages.get({
    userId: env.DEFAULT_GMAIL_USER_ID,
    id: messageId,
    format: "full"
  });
  const sourceEmail = formatFullMessage(sourceRes.data);

  const threadRes = await gmail.users.threads.get({
    userId: env.DEFAULT_GMAIL_USER_ID,
    id: sourceEmail.threadId,
    format: "full"
  });
  const threadMessages = (threadRes.data.messages || [])
    .map((message) => formatFullMessage(message))
    .sort((left, right) => {
      const leftTime = left.internalDate ? new Date(left.internalDate).getTime() : 0;
      const rightTime = right.internalDate ? new Date(right.internalDate).getTime() : 0;
      return leftTime - rightTime;
    });

  return {
    gmail,
    sourceEmail,
    threadMessages
  };
}

function threadHasExternalReplyAfter(threadMessages, accountEmail, createdAt) {
  const threshold = new Date(createdAt).getTime();
  return threadMessages.some((message) => {
    const messageTime = message.internalDate ? new Date(message.internalDate).getTime() : 0;
    if (!Number.isFinite(messageTime) || messageTime <= threshold) {
      return false;
    }
    return normalizeEmailAddress(message.from) !== normalizeEmailAddress(accountEmail);
  });
}

export async function upsertFollowUpDraft({
  gmail,
  reminderId,
  sourceEmail,
  to,
  subject,
  body
}) {
  if (!to) {
    return {
      gmailDraftId: null,
      gmailDraftAction: null,
      gmailDraftError: "No reply-to address was available for this thread."
    };
  }

  try {
    const existingDraftId = await findExistingFollowUpDraftId(gmail, {
      reminderId,
      sourceMessageId: sourceEmail?.id
    });
    const raw = buildRawEmail({
      to,
      subject,
      body,
      extraHeaders: buildReplyHeaders(sourceEmail, reminderId)
    });
    const requestBody = {
      message: {
        raw,
        ...(sourceEmail?.threadId ? { threadId: sourceEmail.threadId } : {})
      }
    };

    const response = existingDraftId
      ? await gmail.users.drafts.update({
          userId: env.DEFAULT_GMAIL_USER_ID,
          id: existingDraftId,
          requestBody: {
            id: existingDraftId,
            ...requestBody
          }
        })
      : await gmail.users.drafts.create({
          userId: env.DEFAULT_GMAIL_USER_ID,
          requestBody
        });

    return {
      gmailDraftId: response.data.id,
      gmailDraftAction: existingDraftId ? "updated" : "created",
      gmailDraftError: null
    };
  } catch (error) {
    return {
      gmailDraftId: null,
      gmailDraftAction: null,
      gmailDraftError: error?.message || String(error)
    };
  }
}

export async function generateFollowUpDraft({
  alias,
  activeEmail,
  messageId,
  signerName,
  reminderId,
  createGmailDraft = false
}) {
  const { gmail, sourceEmail, threadMessages } = await loadThreadContext(alias, messageId);
  const signer = fallbackSigner(alias, signerName);
  const { to, name } = extractRecipient(sourceEmail);
  const threadSummary = buildThreadSummary(sourceEmail, threadMessages, activeEmail);
  const englishTopic =
    threadSummary.topic.toLowerCase() === "your earlier message"
      ? "your earlier message"
      : `"${threadSummary.topic}"`;
  const body = buildEnglishFollowUp({ recipientName: name, topic: englishTopic, signer });

  const draft = {
    to: to || null,
    subject: replySubjectLine(sourceEmail.subject),
    body
  };

  const gmailDraft = createGmailDraft
    ? await upsertFollowUpDraft({
        gmail,
        reminderId,
        sourceEmail,
        ...draft
      })
    : {
        gmailDraftId: null,
        gmailDraftAction: null,
        gmailDraftError: null
      };

  return {
    sourceEmail,
    threadMessages,
    summary: threadSummary.summary,
    topic: threadSummary.topic,
    latestExternalDate: threadSummary.latestExternalDate,
    draft,
    gmailDraft
  };
}

/**
 * Refresh a due reminder's draft and check whether the thread was already replied to.
 *
 * @param {object} reminder - The stored reminder record.
 * @param {object} [opts]
 * @param {string|null} [opts.sessionSignerName] - Signer name from the current MCP
 *   session. When set it takes precedence over the value stored in the reminder
 *   (which may be null if the session was restarted since the reminder was created).
 */
export async function refreshDueFollowUpReminder(reminder, opts = {}) {
  // Prefer: caller-supplied session name → stored reminder name → fallback in generateFollowUpDraft
  const signerName = opts.sessionSignerName || reminder.signerName || null;

  const result = await generateFollowUpDraft({
    alias: reminder.alias,
    activeEmail: reminder.activeEmail,
    messageId: reminder.sourceMessageId,
    signerName,
    reminderId: reminder.id,
    createGmailDraft: Boolean(reminder.createGmailDraft)
  });

  if (threadHasExternalReplyAfter(result.threadMessages, reminder.activeEmail, reminder.createdAt)) {
    return {
      state: "resolved_by_reply",
      summary: result.summary,
      topic: result.topic,
      latestExternalDate: result.latestExternalDate,
      draft: result.draft,
      gmailDraft: result.gmailDraft
    };
  }

  return {
    state: "due",
    summary: result.summary,
    topic: result.topic,
    latestExternalDate: result.latestExternalDate,
    draft: result.draft,
    gmailDraft: result.gmailDraft
  };
}

export async function sendFollowUpReminder(reminder, overrides = {}) {
  const to = overrides.to || reminder.draft?.to;
  const subject = overrides.subject || reminder.draft?.subject;
  const body = overrides.body || reminder.draft?.body;

  return sendEmail({
    alias: reminder.alias,
    to,
    subject,
    body,
    cc: overrides.cc,
    bcc: overrides.bcc,
    sourceMessageId: reminder.sourceMessageId
  });
}

export async function ensureFollowUpStoreDirectory() {
  await fs.mkdir(env.FOLLOWUP_DATA_DIR, { recursive: true });
}
