import { randomBytes } from "crypto";
import { env } from "../config/env.js";
import { DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT } from "../config/constants.js";
import { formatFullMessage, formatMessageSummary, encodeEmail } from "../utils/gmail-formatters.js";
import { safeNumber } from "../utils/validators.js";
import { createGmailClient } from "./gmail-client.js";
import { getOrCreateUserLabelId, addLabelToMessage, removeLabelFromMessage, ensureMcpSidebarLabels } from "./gmail-labels.js";
import { AppError } from "../utils/errors.js";
import { promises as fs } from "fs";
import path from "path";

/** All messages in Inbox across all categories (Primary/Promotions/Social/Updates/Forums). */
const INBOX_QUERY = "in:inbox";

/** Keep listing scoped to Inbox only. */
const INBOX_LABEL_IDS = ["INBOX"];

function inboxListRequest(boundedMaxResults, query, pageToken) {
  const trimmed = query?.trim() ? query.trim() : "";
  const q = trimmed ? `${INBOX_QUERY} ${trimmed}` : INBOX_QUERY;
  return {
    userId: env.DEFAULT_GMAIL_USER_ID,
    q,
    labelIds: INBOX_LABEL_IDS,
    includeSpamTrash: false,
    maxResults: boundedMaxResults,
    pageToken
  };
}

function withFooterAndSignoff(coreLines, relatedBlock, contactFooter, signer) {
  const parts = [...coreLines];
  if (relatedBlock) parts.push("", relatedBlock);
  if (contactFooter) parts.push("", contactFooter);
  parts.push("", "Best regards,", `${signer}`);
  return parts.join("\n");
}

function fencedMarkdownBlock(body, info = "markdown") {
  let n = 3;
  const re = /`{3,}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    n = Math.max(n, m[0].length + 1);
  }
  const fence = "`".repeat(n);
  return `${fence}${info}\n${body}\n${fence}`;
}

export async function searchEmails({ alias, query, maxResults, pageToken }) {
  const { gmail } = await createGmailClient(alias);
  const boundedMaxResults = safeNumber(maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT);

  const response = await gmail.users.messages.list({
    userId: env.DEFAULT_GMAIL_USER_ID,
    q: query || "",
    maxResults: boundedMaxResults,
    pageToken
  });

  const messages = response.data.messages || [];
  const details = await Promise.all(
    messages.map((message) =>
      gmail.users.messages.get({
        userId: env.DEFAULT_GMAIL_USER_ID,
        id: message.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"]
      })
    )
  );

  return {
    nextPageToken: response.data.nextPageToken || null,
    resultSizeEstimate: response.data.resultSizeEstimate || 0,
    messages: details.map((item) => formatMessageSummary(item.data))
  };
}

export async function getEmail({ alias, messageId }) {
  const { gmail } = await createGmailClient(alias);
  const response = await gmail.users.messages.get({
    userId: env.DEFAULT_GMAIL_USER_ID,
    id: messageId,
    format: "full"
  });
  return formatFullMessage(response.data);
}

export async function listThreads({ alias, query, maxResults, pageToken }) {
  const { gmail } = await createGmailClient(alias);
  const boundedMaxResults = safeNumber(maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT);

  const response = await gmail.users.threads.list({
    userId: env.DEFAULT_GMAIL_USER_ID,
    q: query || "",
    maxResults: boundedMaxResults,
    pageToken
  });

  const threads = response.data.threads || [];
  const threadDetails = await Promise.all(
    threads.map((thread) =>
      gmail.users.threads.get({
        userId: env.DEFAULT_GMAIL_USER_ID,
        id: thread.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"]
      })
    )
  );

  return {
    nextPageToken: response.data.nextPageToken || null,
    resultSizeEstimate: response.data.resultSizeEstimate || 0,
    threads: threadDetails.map((item) => {
      const firstMessage = item.data.messages?.[0];
      const lastMessage = item.data.messages?.[item.data.messages.length - 1];
      return {
        id: item.data.id,
        historyId: item.data.historyId,
        messageCount: item.data.messages?.length || 0,
        snippet: item.data.snippet || "",
        firstMessage: firstMessage ? formatMessageSummary(firstMessage) : null,
        lastMessage: lastMessage ? formatMessageSummary(lastMessage) : null
      };
    })
  };
}

function sanitizeHeaderValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function buildReplyHeaders(sourceEmail) {
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
  return headers;
}

function buildRawEmail({ to, subject, body, cc, bcc, html, extraHeaders = [] }) {
  const formatAddress = (addr) => (Array.isArray(addr) ? addr.join(", ") : addr);

  const boundary = randomBytes(16).toString("hex");
  let headers = `To: ${formatAddress(to)}\r\n`;
  headers += `Subject: ${subject}\r\n`;
  if (cc) headers += `Cc: ${formatAddress(cc)}\r\n`;
  if (bcc) headers += `Bcc: ${formatAddress(bcc)}\r\n`;
  for (const headerLine of extraHeaders) {
    const trimmed = String(headerLine || "").trim();
    if (trimmed) headers += `${trimmed}\r\n`;
  }

  if (html) {
    headers += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
    headers += `--${boundary}\r\n`;
    headers += `Content-Type: text/plain; charset=utf-8\r\n\r\n`;
    headers += `${body}\r\n\r\n`;
    headers += `--${boundary}\r\n`;
    headers += `Content-Type: text/html; charset=utf-8\r\n\r\n`;
    headers += `${html}\r\n\r\n`;
    headers += `--${boundary}--`;
  } else {
    headers += `Content-Type: text/plain; charset=utf-8\r\n\r\n`;
    headers += `${body}`;
  }

  return encodeEmail(headers);
}

/** Saves a reply draft to the Gmail Drafts folder. Returns { gmailDraftId, gmailDraftError }. */
async function findExistingGmailDraftId(gmail, sourceMessageId) {
  if (!sourceMessageId) return null;
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
        metadataHeaders: ["X-Smart-Email-Source-Message-Id"]
      });
      const headers = draftRes.data.message?.payload?.headers || [];
      const match = headers.find((header) => header.name?.toLowerCase() === "x-smart-email-source-message-id");
      if (match?.value?.trim() === sourceMessageId) {
        return draft.id;
      }
    }

    pageToken = listRes.data.nextPageToken || null;
  } while (pageToken);

  return null;
}

async function saveGmailDraft(gmail, { to, subject, body, cc, bcc, sourceEmail }) {
  if (!to) return { gmailDraftId: null, gmailDraftError: "No reply-to address — draft not saved to Gmail." };
  try {
    const extraHeaders = buildReplyHeaders(sourceEmail);
    const raw = buildRawEmail({ to, subject, body, cc, bcc, extraHeaders });
    const existingDraftId = await findExistingGmailDraftId(gmail, sourceEmail?.id);
    const requestBody = {
      message: {
        raw,
        ...(sourceEmail?.threadId ? { threadId: sourceEmail.threadId } : {})
      }
    };

    const res = existingDraftId
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
      gmailDraftId: res.data.id,
      gmailDraftError: null,
      gmailDraftAction: existingDraftId ? "updated" : "created"
    };
  } catch (err) {
    return {
      gmailDraftId: null,
      gmailDraftError: err?.message || String(err),
      gmailDraftAction: null
    };
  }
}

async function deleteGmailDraftById(gmail, draftId) {
  if (!draftId) {
    return {
      deleted: false,
      draftId: null,
      error: null
    };
  }

  try {
    await gmail.users.drafts.delete({
      userId: env.DEFAULT_GMAIL_USER_ID,
      id: draftId
    });
    return {
      deleted: true,
      draftId,
      error: null
    };
  } catch (err) {
    return {
      deleted: false,
      draftId,
      error: err?.message || String(err)
    };
  }
}

export async function sendEmail({ alias, to, subject, body, cc, bcc, html, sourceMessageId }) {
  const { gmail } = await createGmailClient(alias);
  let sourceEmail = null;
  if (sourceMessageId) {
    let sourceRes;
    try {
      sourceRes = await gmail.users.messages.get({
        userId: env.DEFAULT_GMAIL_USER_ID,
        id: sourceMessageId,
        format: "full"
      });
    } catch (err) {
      // Gmail returns HTTP 404 or an "Invalid id value" message for unknown IDs.
      // Map this to NOT_FOUND so callers get a meaningful code instead of
      // INTERNAL_ERROR (BUG-4).
      const status = err?.status ?? err?.code ?? err?.response?.status;
      const message = err?.message || "";
      if (status === 404 || /invalid id value|not found/i.test(message)) {
        throw new AppError(
          "Message not found — the messageId is no longer valid.",
          "NOT_FOUND",
          404
        );
      }
      throw err;
    }
    sourceEmail = formatFullMessage(sourceRes.data);
  }

  const raw = buildRawEmail({
    to,
    subject,
    body,
    cc,
    bcc,
    html,
    extraHeaders: buildReplyHeaders(sourceEmail)
  });

  const response = await gmail.users.messages.send({
    userId: env.DEFAULT_GMAIL_USER_ID,
    requestBody: {
      raw,
      ...(sourceEmail?.threadId ? { threadId: sourceEmail.threadId } : {})
    }
  });

  const deletedDraft = sourceMessageId
    ? await deleteGmailDraftById(gmail, await findExistingGmailDraftId(gmail, sourceMessageId))
    : { deleted: false, draftId: null, error: null };

  return {
    id: response.data.id,
    threadId: response.data.threadId,
    labelIds: response.data.labelIds || [],
    deletedDraftId: deletedDraft.draftId,
    deletedDraft: deletedDraft.deleted,
    deletedDraftError: deletedDraft.error || undefined
  };
}

export async function setReplyDraft({ alias, sourceMessageId, to, subject, body, cc, bcc }) {
  if (!sourceMessageId) {
    throw new AppError("sourceMessageId is required to save a reply draft", "VALIDATION_ERROR", 400);
  }

  const { gmail } = await createGmailClient(alias);
  const sourceRes = await gmail.users.messages.get({
    userId: env.DEFAULT_GMAIL_USER_ID,
    id: sourceMessageId,
    format: "full"
  });
  const sourceEmail = formatFullMessage(sourceRes.data);
  const finalTo = Array.isArray(to) ? to.join(", ") : to;
  const draftResult = await saveGmailDraft(gmail, {
    to: finalTo,
    subject,
    body,
    sourceEmail
  });

  return {
    ...draftResult,
    sourceMessageId: sourceEmail.id,
    sourceThreadId: sourceEmail.threadId,
    to,
    subject,
    cc: cc || null,
    bcc: bcc || null
  };
}


/**
 * Classify the email's intent.
 *
 * Receives the full email object (not just subject + body) so the promotional
 * classifier can inspect labelIds and listUnsubscribeHeader (BUG-3 / BUG-10).
 *
 * Type hierarchy (highest wins):
 *   promotional → informational → actionable
 *
 * Default is now "informational" to prevent generating noisy drafts for
 * newsletters and digests (BUG-10).
 */
function extractIntent(email) {
  const subject = email.subject || "";
  const bodyText = email.bodyText || "";
  const text = `${subject}\n${bodyText}`.toLowerCase();
  const from = String(email.from || "").toLowerCase();

  // ── Promotional / no-reply ──────────────────────────────────────────────────
  // Signals: noreply-style From address, List-Unsubscribe header, or Gmail
  // CATEGORY_PROMOTIONS / CATEGORY_UPDATES label.
  const isNoreplyFrom = /\b(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|notifications?|automated|bounce)\b/.test(from) ||
    /^(noreply|no-?reply|donotreply|notifications?|automated)@/.test(from.split("<").pop() ?? from);
  const hasUnsubscribeHeader = Boolean(email.listUnsubscribeHeader);
  const hasPromotionsLabel = Array.isArray(email.labelIds) &&
    email.labelIds.some((l) => l === "CATEGORY_PROMOTIONS" || l === "CATEGORY_UPDATES");

  if (isNoreplyFrom || hasUnsubscribeHeader || hasPromotionsLabel) {
    return { type: "promotional", summary: "Promotional or automated message — no reply needed." };
  }

  // ── Actionable ──────────────────────────────────────────────────────────────
  const hasQuestion = text.includes("?");
  const actionWords = [
    "please", "can you", "could you", "kindly", "need", "request", "let me know",
    "would like", "looking for", "want to", "how do", "how can", "what is", "what are",
    "when will", "where can", "i have an issue", "problem", "not working", "error", "help"
  ];

  if (hasQuestion || actionWords.some((w) => text.includes(w))) {
    return { type: "actionable", summary: "Customer is requesting help or asking a question." };
  }

  // ── Default: informational (BUG-10) ─────────────────────────────────────────
  // Only escalate to actionable when there is a clear signal. Emails that
  // match none of the above are likely digests, notifications, or FYIs.
  return { type: "informational", summary: "Informational message; no direct action required." };
}

/** Extract the customer's key question or request from the email body. */
function extractKeyRequest(bodyText) {
  if (!bodyText) return null;
  const clean = bodyText.replace(/\r/g, "").trim();
  const sentences = clean
    .split(/\n|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[>\-*•\s]+/, "").trim())
    .filter((s) => s.length > 20 && s.length < 300);

  const question = sentences.find((s) => s.includes("?"));
  if (question) return question;

  const request = sentences.find((s) =>
    /\b(please|can you|could you|kindly|need|would like|want to|looking for|request|how (do|can|should)|what (is|are|should))\b/i.test(s)
  );
  if (request) return request;

  return sentences[0] || null;
}

function threadFormatLabelFromCount(threadMessageCount) {
  if (threadMessageCount >= 4) return "Last follow-up thread";
  if (threadMessageCount >= 2) return "Follow-up thread";
  return "New thread";
}

function buildReplyDraft(email, analysis, alias, signerName, threadMessageCount) {
  return buildCustomerReplyFromAnalysis(email, analysis, alias, signerName, threadMessageCount);
}

function extractReplyToAddress(fromHeader) {
  const raw = String(fromHeader || "").trim();
  const bracket = raw.match(/<([^>]+)>/);
  if (bracket) return bracket[1].trim();
  const emailMatch = raw.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return emailMatch ? emailMatch[0] : "";
}

function replySubjectLine(original) {
  const s = String(original || "").trim();
  if (/^re:\s/i.test(s)) return s;
  return s ? `Re: ${s}` : "Re: (no subject)";
}

function excerptBody(bodyText, maxLen) {
  const t = (bodyText || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

function firstSentencePreview(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "No preview.";
  const sentence = t.split(/(?<=[.!?])\s+/)[0];
  const clip = sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence;
  return clip;
}

function cleanEmailBodyForAnalysis(bodyText) {
  const text = String(bodyText || "").replace(/\r/g, "");
  const lines = text.split("\n");
  const kept = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (/^>/.test(line)) continue;
    if (/^[-_]{2,}\s*original message\s*[-_]{2,}$/i.test(line)) break;
    if (/^on .+wrote:$/i.test(line)) break;
    if (/^(from|sent|subject|to|cc):\s+/i.test(line)) continue;
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function splitMeaningfulSentences(text) {
  const normalized = String(text || "").replace(/\r/g, " ").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 18 && sentence.length <= 320);
}

function extractSenderDisplayName(fromHeader) {
  const raw = String(fromHeader || "").split("<")[0].trim();
  const cleaned = raw.replace(/^["']|["']$/g, "").trim();
  return cleaned || "there";
}

function buildReviewSummary(sentences, request, subject, preview) {
  const parts = [];
  if (request) parts.push(request);
  for (const sentence of sentences) {
    if (parts.join(" ").includes(sentence)) continue;
    parts.push(sentence);
    if (parts.join(" ").length >= 220 || parts.length >= 2) break;
  }
  const summary = parts.join(" ").trim();
  if (summary) return summary;
  return preview && preview !== "No preview." ? preview : subject || "Customer email received.";
}

function analyzeEmail(email, threadMessageCount) {
  const cleanBody = cleanEmailBodyForAnalysis(email.bodyText || email.snippet || "");
  const sentences = splitMeaningfulSentences(cleanBody);
  const preview = firstSentencePreview(cleanBody || email.snippet || "");
  // Pass the full email object so extractIntent can inspect labelIds and
  // listUnsubscribeHeader for promotional classification (BUG-3 / BUG-10).
  const intent = extractIntent({ ...email, bodyText: cleanBody });
  const senderGoal = extractKeyRequest(cleanBody || email.bodyText || "") || preview || email.subject || "help with their request";
  const summary = buildReviewSummary(sentences, senderGoal, email.subject, preview);
  const attachmentMentioned = /\b(attachment|attached|attach|anhang|angehängt|screenshot|screen shot|log file|video)\b/i.test(cleanBody);
  const urgentTone = /\b(urgent|asap|immediately|as soon as possible|frustrat|angry|upset|still not working|dringend|sofort|escala)/i.test(cleanBody);
  const pricingNeedsHumanReview =
    /\b(t3ac|t3as|t3aa|t3al|t3ab)\b/i.test(`${email.subject || ""}\n${cleanBody}`) &&
    /\b(price|pricing|cost|quote|angebot|preis)\b/i.test(`${email.subject || ""}\n${cleanBody}`);

  return {
    cleanBody,
    sentences,
    preview,
    intent,
    senderGoal,
    summary,
    senderName: extractSenderDisplayName(email.from),
    attachmentMentioned,
    urgentTone,
    pricingNeedsHumanReview
  };
}

function buildAgentNotes(analysis, replyTo, threadMessageCount) {
  const notes = [
    `Thread shape (by message count): ${threadFormatLabelFromCount(threadMessageCount)}.`,
    `Customer intent: ${analysis.intent.summary}`
  ];

  if (analysis.attachmentMentioned) {
    notes.push("⚠️ Attachment detected — not readable via MCP. Please review manually before sending.");
  }
  if (analysis.urgentTone) {
    notes.push("⚠️ Sentiment appears urgent or frustrated — review carefully before sending.");
  }
  if (analysis.pricingNeedsHumanReview) {
    notes.push("⚠️ Pricing details may need human review — verify before quoting figures.");
  }
  if (!replyTo) {
    notes.push("⚠️ Reply-to address could not be parsed automatically — verify recipient before sending.");
  }
  return notes;
}

function buildCustomerReplyFromAnalysis(email, analysis, alias, signerName, threadMessageCount) {
  if (analysis.intent.type === "informational" || analysis.intent.type === "promotional") {
    return "No reply needed";
  }

  const signer = signerName || String(alias || "").trim() || "Support";
  const subjectLine = email.subject || "your email";
  const lines = [
    `Hi ${analysis.senderName},`,
    "",
    `Thank you for reaching out regarding "${subjectLine}".`,
    ""
  ];

  if (analysis.senderGoal) {
    lines.push(`From your email, I understand that you need help with: "${analysis.senderGoal.slice(0, 220)}"`, "");
  }

  lines.push(
    "I will review the details and reply with the next steps as soon as possible.",
    ""
  );

  if (threadMessageCount >= 4) {
    lines.push(
      "This is my final follow-up in this thread for now, but you are always welcome to reopen it by replying here or by submitting a new ticket.",
      ""
    );
  } else {
    lines.push("Please let me know if you would like me to check anything else in the meantime.", "");
  }

  return withFooterAndSignoff(lines, "", "", signer);
}

/** Used when intent is informational: still a full draft in chat (not sent automatically). */
function buildGenericReplyDraft(email, analysis, alias, signerName) {
  const signer = signerName || String(alias || "").trim() || "Support";
  const lines = [
    `Hi ${analysis.senderName},`,
    "",
    `Thank you for your message regarding "${email.subject || "your message"}".`,
    "",
    "I have reviewed it and noted the details on our side.",
    "",
    "If any action is needed from our side, we will follow up with you shortly.",
    ""
  ];

  return withFooterAndSignoff(lines, "", "", signer);
}

function formatDraftReplyAsText({ to, subject, body }) {
  const toLine = to || "(add recipient)";
  return [`To: ${toLine}`, `Subject: ${subject}`, "", body].join("\n");
}

async function saveUnreadDraftsMarkdownFile({ alias, listQuery, draftsMarkdown, itemCount }) {
  const draftsDir = env.GMAIL_REVIEW_MARKDOWN_DIR;
  await fs.mkdir(draftsDir, { recursive: true });
  const filename = env.GMAIL_REVIEW_MARKDOWN_FILENAME;
  const absPath = path.join(draftsDir, filename);
  const reviewDirRel = path.relative(env.PROJECT_ROOT, draftsDir);
  const header = [
    "# Inbox reply drafts",
    "",
    "> **This file is overwritten** every time you run `fetch` with `writeMarkdownFile: true` — there is only **one** review file at this path.",
    "",
    "> **Review here** in your editor. Edit bodies below if needed, then tell the assistant to **`send`** with the final text — nothing is sent from this file alone.",
    "> When generating or editing drafts, avoid reusing previously addressed content from the thread history and generate a fresh, context-aware response instead.",
    "",
    `- **Account alias:** ${alias}`,
    `- **File:** \`${path.join(reviewDirRel, filename).replace(/\\/g, "/")}\``,
    `- **Gmail list query:** \`${listQuery}\``,
    `- **Messages in this file:** ${itemCount}`,
    `- **Generated (UTC):** ${new Date().toISOString()}`,
    "",
    "---",
    "",
    ""
  ].join("\n");
  await fs.writeFile(absPath, header + draftsMarkdown, "utf8");
  return path.relative(env.PROJECT_ROOT, absPath);
}

function formatDraftReplyMarkdown(
  draftReply,
  messageId,
  gmailDraftId,
  gmailDraftAction,
  { reviewOnlyNoGmailDraft = false } = {}
) {
  const to = draftReply.to || "*(add recipient)*";
  const { subject, body } = draftReply;
  let statusLine;
  if (gmailDraftId) {
    statusLine = `- **Gmail Draft:** \`${gmailDraftId}\` ✓ ${gmailDraftAction === "updated" ? "updated" : "created"} in Gmail Drafts`;
  } else if (reviewOnlyNoGmailDraft) {
    statusLine =
      "- **Gmail Draft:** _(skipped — review the proposed reply below; after approval use send to deliver to the recipient.)_";
  } else {
    statusLine = "- **Gmail Draft:** _(not saved — no reply-to address)_";
  }
  const bodyHeading = gmailDraftId ? "**Body saved to Gmail:**" : "**Proposed reply:**";
  const lines = [
    "### Reply draft",
    "",
    `- **messageId:** \`${messageId}\``,
    statusLine,
    `- **To:** ${to}`,
    `- **Subject:** ${subject}`,
    "",
    bodyHeading,
    "",
    fencedMarkdownBlock(body, "text")
  ];
  return lines.join("\n");
}

/**
 * Marks a Gmail message as read by removing the UNREAD label.
 * Called automatically by send after a confirmed send.
 */
export async function markAsRead({ alias, messageId }) {
  const { gmail } = await createGmailClient(alias);
  const response = await gmail.users.messages.modify({
    userId: env.DEFAULT_GMAIL_USER_ID,
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] }
  });
  return {
    messageId: response.data.id,
    labelIds: response.data.labelIds || []
  };
}

/** Removes the MCP inbox-review sidebar label after send (no-op if feature disabled). */
export async function removeInboxReviewGmailLabel({ alias, messageId }) {
  if (!env.GMAIL_REVIEW_GMAIL_LABEL_ENABLED || !messageId) {
    return { removed: false };
  }
  const { gmail } = await createGmailClient(alias);
  const labelId = await getOrCreateUserLabelId(gmail, env.GMAIL_REVIEW_GMAIL_LABEL_NAME);
  await removeLabelFromMessage(gmail, messageId, labelId);
  return { removed: true, labelName: env.GMAIL_REVIEW_GMAIL_LABEL_NAME };
}

/** Verifies/creates MCP Gmail labels for one account (useful if sidebar labels are missing). */
export async function ensureMcpGmailLabelsForAccount(alias) {
  const { gmail } = await createGmailClient(alias);
  const { followUpLabelId, inboxReviewLabelId } = await ensureMcpSidebarLabels(gmail);
  return {
    followUp: env.FOLLOW_UP_GMAIL_LABEL_ENABLED
      ? { name: env.FOLLOW_UP_GMAIL_LABEL_NAME, labelId: followUpLabelId }
      : { skipped: true, reason: "FOLLOW_UP_GMAIL_LABEL_ENABLED=false" },
    inboxReview: env.GMAIL_REVIEW_GMAIL_LABEL_ENABLED
      ? { name: env.GMAIL_REVIEW_GMAIL_LABEL_NAME, labelId: inboxReviewLabelId }
      : { skipped: true, reason: "GMAIL_REVIEW_GMAIL_LABEL_ENABLED=false" },
    message:
      "Gmail user labels are present (any missing ones were created). Open Gmail → **Labels** and refresh the page if you do not see them yet."
  };
}

export async function fetchUnreadSummariesAndReplyDrafts({
  alias,
  maxResults,
  query,
  writeMarkdownFile = true,
  signerName = null,
  saveGmailDrafts = false
}) {
  const { gmail } = await createGmailClient(alias);
  const boundedMaxResults = safeNumber(maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT);
  const listParams = inboxListRequest(boundedMaxResults, query, undefined);

  /** Eagerly create user labels so they appear under Gmail’s Labels list before any message is tagged. */
  const { inboxReviewLabelId } = await ensureMcpSidebarLabels(gmail);

  const response = await gmail.users.messages.list(listParams);

  const inboxMessages = response.data.messages || [];
  const items = [];

  for (const item of inboxMessages) {
    const fullRes = await gmail.users.messages.get({
      userId: env.DEFAULT_GMAIL_USER_ID,
      id: item.id,
      format: "full"
    });
    const fullEmail = formatFullMessage(fullRes.data);
    const threadRes = await gmail.users.threads.get({
      userId: env.DEFAULT_GMAIL_USER_ID,
      id: fullEmail.threadId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"]
    });
    const threadMessageCount = threadRes.data.messages?.length || 1;

    const analysis = analyzeEmail(fullEmail, threadMessageCount);
    const replyTo = extractReplyToAddress(fullEmail.replyToHeader || fullEmail.from);
    const agentNotes = buildAgentNotes(analysis, replyTo, threadMessageCount);
    const subject = replySubjectLine(fullEmail.subject);
    const mailSummary = analysis.summary;
    const bodyExcerpt = excerptBody(analysis.cleanBody || fullEmail.bodyText, 500) || null;
    const draftBody =
      analysis.intent.type === "promotional"
        ? "Promotional or automated message — no reply draft generated."
        : analysis.intent.type === "actionable"
          ? buildReplyDraft(fullEmail, analysis, alias, signerName, threadMessageCount)
          : buildGenericReplyDraft(fullEmail, analysis, alias, signerName);
    const replyRecommended =
      analysis.intent.type === "actionable" && draftBody !== "No reply needed";

    const draftReply = {
      to: replyTo || null,
      subject,
      body: draftBody
    };
    const draftReplyAsText = formatDraftReplyAsText(draftReply);

    let gmailDraftId = null;
    let gmailDraftError = null;
    let gmailDraftAction;

    if (saveGmailDrafts) {
      const saved = await saveGmailDraft(gmail, {
        ...draftReply,
        sourceEmail: fullEmail
      });
      gmailDraftId = saved.gmailDraftId;
      gmailDraftError = saved.gmailDraftError;
      gmailDraftAction = saved.gmailDraftAction;
    }

    let gmailInboxReviewLabelError = null;
    if (inboxReviewLabelId) {
      try {
        await addLabelToMessage(gmail, fullEmail.id, inboxReviewLabelId);
      } catch (err) {
        gmailInboxReviewLabelError = err?.message || String(err);
      }
    }

    const draftReplyMarkdown = formatDraftReplyMarkdown(draftReply, fullEmail.id, gmailDraftId, gmailDraftAction, {
      reviewOnlyNoGmailDraft: !saveGmailDrafts
    });

    items.push({
      messageId: fullEmail.id,
      threadId: fullEmail.threadId,
      from: fullEmail.from,
      to: fullEmail.to,
      subject: fullEmail.subject,
      date: fullEmail.date || fullEmail.internalDate,
      threadMessageCount,
      intentType: analysis.intent.type,
      intentDetail: analysis.intent.summary,
      mailSummary,
      mailSummaryMarkdown: `**Summary** (${fullEmail.id}): ${mailSummary}`,
      bodyExcerpt,
      senderGoal: analysis.senderGoal,
      selectedFormat: threadFormatLabelFromCount(threadMessageCount),
      selectedFormatGuidance: [],
      selectedContextSections: [],
      agentNotes,
      replyRecommended,
      draftReply,
      draftReplyAsText,
      draftReplyMarkdown,
      gmailDraftId: gmailDraftId || null,
      gmailDraftAction: gmailDraftAction || undefined,
      gmailDraftError: gmailDraftError || undefined,
      gmailInboxReviewLabelError: gmailInboxReviewLabelError || undefined,
      parseNote: replyTo ? null : "Could not parse reply address from From; set draftReply.to in send."
    });
  }

  const draftsMarkdown =
    items.length === 0
      ? "*No inbox messages matched this run — no reply drafts.*"
      : items.map((row) => row.draftReplyMarkdown).join("\n\n---\n\n");

  let markdownFile = null;
  let markdownSaveError = null;
  if (writeMarkdownFile && items.length > 0) {
    try {
      markdownFile = await saveUnreadDraftsMarkdownFile({
        alias,
        listQuery: listParams.q,
        draftsMarkdown,
        itemCount: items.length
      });
    } catch (err) {
      markdownSaveError = err?.message || String(err);
    }
  }

  const gmailInboxReviewTaggedCount =
    env.GMAIL_REVIEW_GMAIL_LABEL_ENABLED && items.length > 0
      ? items.filter((i) => !i.gmailInboxReviewLabelError).length
      : 0;

  return {
    /** Helps MCP clients: one run = drafts for every inbox message listed (up to maxResults). */
    batchDraftPolicy: "all_fetched_inbox",
    saveGmailDrafts,
    nextPageToken: response.data.nextPageToken || null,
    gmailListQuery: listParams.q,
    gmailListLabelIds: INBOX_LABEL_IDS,
    inboxCount: items.length,
    unreadCount: items.length,
    awaitingUserFeedback: items.length > 0,
    chatOutputNote: (() => {
      const fileNote = markdownFile
        ? `Saved reply drafts to **${markdownFile}** (single Markdown file, overwritten each fetch). Use send after user approval.`
        : writeMarkdownFile && items.length > 0 && markdownSaveError
          ? `Could not write .md file: ${markdownSaveError}. Use draftsMarkdown from JSON.`
          : items.length === 0
            ? "No inbox messages matched — no .md file written. draftsMarkdown explains why."
            : !writeMarkdownFile
              ? "writeMarkdownFile was false — no .md on disk; use draftsMarkdown in JSON."
              : "Use draftsMarkdown from JSON.";
      return fileNote;
    })(),
    draftsMarkdown,
    markdownFile,
    markdownSaved: Boolean(markdownFile),
    markdownSaveError: markdownSaveError || undefined,
    gmailSidebarLabels: {
      followUpLabelEnsured: env.FOLLOW_UP_GMAIL_LABEL_ENABLED ? env.FOLLOW_UP_GMAIL_LABEL_NAME : null,
      inboxReviewLabelName: env.GMAIL_REVIEW_GMAIL_LABEL_ENABLED ? env.GMAIL_REVIEW_GMAIL_LABEL_NAME : null,
      inboxReviewMessagesTagged: gmailInboxReviewTaggedCount
    },

    noUnreadHint:
      items.length === 0
        ? "No inbox messages matched this query. Your mail may be archived, in Spam/Trash, or filtered by query."
        : null,
    items
  };
}

/** List Gmail Drafts folder. Returns draft metadata. */
export async function fetchGmailDrafts({ alias, maxResults }) {
  const { gmail } = await createGmailClient(alias);
  const bounded = safeNumber(maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT);
  const listRes = await gmail.users.drafts.list({
    userId: env.DEFAULT_GMAIL_USER_ID,
    maxResults: bounded
  });
  const drafts = listRes.data.drafts || [];
  const details = await Promise.all(
    drafts.map((d) =>
      gmail.users.drafts.get({
        userId: env.DEFAULT_GMAIL_USER_ID,
        id: d.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"]
      })
    )
  );
  return {
    count: details.length,
    nextPageToken: listRes.data.nextPageToken || null,
    drafts: details.map((res) => ({
      draftId: res.data.id,
      ...formatMessageSummary(res.data.message || {})
    }))
  };
}

/** List Gmail Sent folder. Returns message metadata. */
export async function fetchGmailSent({ alias, maxResults }) {
  const { gmail } = await createGmailClient(alias);
  const bounded = safeNumber(maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT);
  const listRes = await gmail.users.messages.list({
    userId: env.DEFAULT_GMAIL_USER_ID,
    labelIds: ["SENT"],
    maxResults: bounded
  });
  const messages = listRes.data.messages || [];
  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: env.DEFAULT_GMAIL_USER_ID,
        id: m.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"]
      })
    )
  );
  return {
    count: details.length,
    nextPageToken: listRes.data.nextPageToken || null,
    messages: details.map((res) => formatMessageSummary(res.data))
  };
}
