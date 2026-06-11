import { htmlToPlainBody, looksLikeHtml, stripHtmlToText } from "./html-text.js";
import { decodeMimeHeaderValue } from "./mime-headers.js";

export { stripHtmlToText, looksLikeHtml, htmlToPlainBody } from "./html-text.js";

function getHeader(headers = [], name) {
  const match = headers.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  const value = match?.value ?? "";
  return decodeMimeHeaderValue(value);
}

/** Extract bare email from a From/To header value. */
export function normalizeEmailAddress(value) {
  const raw = String(value || "").trim().toLowerCase();
  const bracketMatch = raw.match(/<([^>]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }
  const emailMatch = raw.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
  return emailMatch ? emailMatch[0].toLowerCase() : raw;
}

export { extractNewReplyContent, stripQuotedReplyContent } from "./email-body-stripper.js";

function extractPlainText(parts = []) {
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf8");
    }
    if (part.parts?.length) {
      const nested = extractPlainText(part.parts);
      if (nested) return nested;
    }
  }
  return "";
}

function extractHtmlText(parts = []) {
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      return htmlToPlainBody(Buffer.from(part.body.data, "base64").toString("utf8"));
    }
    if (part.parts?.length) {
      const nested = extractHtmlText(part.parts);
      if (nested) return nested;
    }
  }
  return "";
}

function extractRawHtml(parts = []) {
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf8");
    }
    if (part.parts?.length) {
      const nested = extractRawHtml(part.parts);
      if (nested) return nested;
    }
  }
  return "";
}

/** Original message bodies for reply quoting (not quote-stripped). */
export function extractRawMessageBodies(message) {
  const payload = message.payload ?? {};
  let rawBodyPlain = extractPlainText(payload.parts ?? []);
  if (!rawBodyPlain && payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64").toString("utf8");
    rawBodyPlain = looksLikeHtml(decoded) ? "" : decoded;
  }

  let rawBodyHtml = extractRawHtml(payload.parts ?? []);
  if (!rawBodyHtml && payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64").toString("utf8");
    if (looksLikeHtml(decoded)) rawBodyHtml = decoded;
  }

  return { rawBodyPlain: rawBodyPlain || "", rawBodyHtml: rawBodyHtml || "" };
}

export function formatMessageSummary(message) {
  const payload = message.payload ?? {};
  const headers = payload.headers ?? [];

  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet ?? "",
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    internalDate: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null
  };
}

export function formatFullMessage(message) {
  const payload = message.payload ?? {};
  const headers = payload.headers ?? [];

  // Prefer text/plain — never pass raw HTML into bodyText (BUG-3).
  // HTML parts: planer (talon) quote removal, then plaintext conversion.
  let bodyText = extractPlainText(payload.parts ?? []);
  if (!bodyText) {
    if (payload.body?.data) {
      const decoded = Buffer.from(payload.body.data, "base64").toString("utf8");
      bodyText = looksLikeHtml(decoded) ? htmlToPlainBody(decoded) : decoded;
    } else {
      bodyText = extractHtmlText(payload.parts ?? []);
    }
  }

  const { rawBodyPlain, rawBodyHtml } = extractRawMessageBodies(message);

  return {
    ...formatMessageSummary(message),
    labelIds: message.labelIds ?? [],
    bodyText,
    rawBodyPlain: rawBodyPlain || bodyText,
    rawBodyHtml,
    listUnsubscribeHeader: getHeader(headers, "List-Unsubscribe"),
    replyToHeader: getHeader(headers, "Reply-To"),
    messageHeaderId: getHeader(headers, "Message-ID") || getHeader(headers, "Message-Id"),
    referencesHeader: getHeader(headers, "References")
  };
}

export function encodeEmail(rawEmail) {
  return Buffer.from(rawEmail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
