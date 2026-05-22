function getHeader(headers = [], name) {
  const match = headers.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? "";
}

/**
 * Strip HTML tags so bodyText is always plain text (BUG-3).
 * Handles common entities, removes <style>/<script> blocks, and converts
 * <br> / </p> to newlines to preserve paragraph structure.
 */
export function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHtml(text) {
  return /<[a-z][\s\S]*>/i.test(String(text).trimStart().slice(0, 300));
}

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
      return stripHtmlToText(Buffer.from(part.body.data, "base64").toString("utf8"));
    }
    if (part.parts?.length) {
      const nested = extractHtmlText(part.parts);
      if (nested) return nested;
    }
  }
  return "";
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
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    internalDate: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null
  };
}

export function formatFullMessage(message) {
  const payload = message.payload ?? {};
  const headers = payload.headers ?? [];

  // Prefer text/plain — never pass raw HTML into bodyText (BUG-3).
  // Priority: text/plain from parts → plain top-level body → stripped HTML from parts
  //           → stripped top-level HTML body.
  let bodyText = extractPlainText(payload.parts ?? []);
  if (!bodyText) {
    if (payload.body?.data) {
      const decoded = Buffer.from(payload.body.data, "base64").toString("utf8");
      bodyText = looksLikeHtml(decoded) ? stripHtmlToText(decoded) : decoded;
    } else {
      bodyText = extractHtmlText(payload.parts ?? []);
    }
  }

  return {
    ...formatMessageSummary(message),
    labelIds: message.labelIds ?? [],
    bodyText,
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
