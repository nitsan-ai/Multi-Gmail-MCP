import {
  DEFAULT_THREAD_LATEST_N,
  MAX_THREAD_LATEST_N
} from "../config/constants.js";
import { extractNewReplyContent } from "../utils/email-body-stripper.js";
import { formatMessageSummary, normalizeEmailAddress } from "../utils/gmail-formatters.js";

export function sortMessagesAscByInternalDate(messages) {
  return [...messages].sort((left, right) => {
    const leftTime = left.internalDate ? new Date(Number(left.internalDate)).getTime() : 0;
    const rightTime = right.internalDate ? new Date(Number(right.internalDate)).getTime() : 0;
    return leftTime - rightTime;
  });
}

export function lastMessageDirection(lastFrom, accountEmail) {
  const sender = normalizeEmailAddress(lastFrom);
  const account = normalizeEmailAddress(accountEmail);
  if (!sender || !account) return "inbound";
  return sender === account ? "outbound" : "inbound";
}

export function threadMetadataToListItem(threadData, accountEmail) {
  const messages = sortMessagesAscByInternalDate(threadData.messages || []);
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return null;

  const summary = formatMessageSummary(lastMessage);
  const lastMessageDate = summary.internalDate || summary.date || null;

  return {
    threadId: threadData.id,
    latestMessageId: summary.id,
    subject: summary.subject || "",
    participants: {
      from: summary.from || "",
      to: summary.to || "",
      cc: summary.cc || ""
    },
    lastMessageDate,
    messageCount: messages.length,
    lastMessageDirection: lastMessageDirection(summary.from, accountEmail),
    snippet: threadData.snippet || summary.snippet || ""
  };
}

/** Build a list-mode inbox scan payload shape (for tests and size checks). */
export function buildInboxListScanPayload(items, extra = {}) {
  const threadCount = items.length;
  return {
    mode: "list",
    threadCount,
    uniqueThreadCount: threadCount,
    inboxThreadCount: threadCount,
    inboxCount: threadCount,
    items,
    ...extra
  };
}

function mergeParticipantHeaders(messages, field) {
  const seen = new Set();
  const values = [];
  for (const message of messages) {
    const value = String(message[field] || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values.join(", ");
}

function messageTranscriptText(message) {
  const raw = String(message.bodyText || "").trim();
  const fromBody = extractNewReplyContent(raw);
  if (fromBody) return fromBody;
  // Never substitute Gmail's ~100-char snippet when a full body exists — that hides the real email.
  if (raw) return raw;
  return extractNewReplyContent(message.snippet || "");
}

function messageRawText(message) {
  return String(message.bodyText || message.snippet || "").trim();
}

function threadIncludesBodies(format) {
  return format !== "metadata";
}

function threadSubjectFromMessages(messages) {
  const lastMessage = messages[messages.length - 1];
  return (
    messages.find((message) => String(message.subject || "").trim())?.subject ||
    lastMessage?.subject ||
    ""
  );
}

function threadTranscriptHeader(rawThread, messages) {
  const lastMessage = messages[messages.length - 1];
  return {
    threadId: rawThread.id,
    subject: threadSubjectFromMessages(messages),
    messageCount: messages.length,
    participants: {
      from: mergeParticipantHeaders(messages, "from"),
      to: mergeParticipantHeaders(messages, "to"),
      cc: mergeParticipantHeaders(messages, "cc")
    },
    latestMessageId: lastMessage?.id || null
  };
}

export function formatTranscriptMessage(message, accountEmail, { includeText, stripped, includeRaw }) {
  const entry = {
    messageId: message.id,
    direction: lastMessageDirection(message.from, accountEmail),
    from: message.from || "",
    to: message.to || "",
    date: message.internalDate || message.date || null
  };
  if (!includeText) return entry;

  const raw = messageRawText(message);
  if (stripped) {
    entry.text = messageTranscriptText(message);
    if (includeRaw) entry.rawText = raw;
  } else {
    entry.text = raw;
    entry.bodyText = raw;
    if (includeRaw) entry.rawText = raw;
  }
  return entry;
}

/** First message plus latest N trailing messages; returns omitted middle count. */
export function partitionLatestMessages(messages, latestN) {
  const boundedN = Math.min(Math.max(1, latestN), MAX_THREAD_LATEST_N);
  if (messages.length <= 1) {
    return { entries: messages, omittedCount: 0 };
  }

  const first = messages[0];
  const tail = messages.slice(-boundedN);

  if (messages.length <= 1 + boundedN) {
    const seen = new Set();
    const entries = [];
    for (const message of [first, ...tail]) {
      if (!message?.id || seen.has(message.id)) continue;
      seen.add(message.id);
      entries.push(message);
    }
    return { entries, omittedCount: 0 };
  }

  return {
    entries: [first, ...tail],
    omittedCount: messages.length - 1 - boundedN
  };
}

export function buildTranscriptMessageList(messages, accountEmail, format, latestN, bodyOptions) {
  const textOpts = { includeText: true, ...bodyOptions };

  if (format === "metadata") {
    return messages.map((message) => formatTranscriptMessage(message, accountEmail, { includeText: false }));
  }

  if (format === "full") {
    return messages.map((message) => formatTranscriptMessage(message, accountEmail, textOpts));
  }

  const { entries, omittedCount } = partitionLatestMessages(messages, latestN);
  const items = [];

  for (let index = 0; index < entries.length; index++) {
    if (index === 1 && omittedCount > 0) {
      items.push({ marker: `[${omittedCount} earlier messages omitted]` });
    }
    items.push(formatTranscriptMessage(entries[index], accountEmail, textOpts));
  }

  return items;
}

export function buildThreadTranscript(
  rawThread,
  accountEmail,
  { format = "full", latestN = DEFAULT_THREAD_LATEST_N, stripped = false, includeRaw = false } = {}
) {
  const messages = rawThread.messages || [];
  const header = threadTranscriptHeader(rawThread, messages);
  const includesBodies = threadIncludesBodies(format);

  return {
    format,
    ...(format === "latest" ? { latestN } : {}),
    stripped: includesBodies ? stripped : false,
    includeRaw: includesBodies ? includeRaw : false,
    ...header,
    messages: buildTranscriptMessageList(messages, accountEmail, format, latestN, {
      stripped: includesBodies ? stripped : true,
      includeRaw: includesBodies ? includeRaw : false
    })
  };
}

export function buildThreadMetadataTranscript(rawThread, accountEmail) {
  const messages = rawThread.messages || [];
  return {
    format: "metadata",
    ...threadTranscriptHeader(rawThread, messages),
    stripped: false,
    includeRaw: false,
    messages: messages.map((message) => formatTranscriptMessage(message, accountEmail, { includeText: false }))
  };
}
