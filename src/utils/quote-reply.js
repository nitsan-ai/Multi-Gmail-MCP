import { normalizeEmailAddress } from "./gmail-formatters.js";
import { looksLikeHtml, sanitizeHtmlForQuote, stripHtmlToText } from "./html-text.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Detect caller-supplied quote block — avoid double-quoting when quoteOriginal defaults true. */
export function bodyAlreadyQuoted(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (/class=["']gmail_quote/i.test(value)) return true;
  if (/\nOn .+ wrote:\s*(\n|$)/i.test(value)) return true;
  if (/\n> .+/m.test(value) && /\nOn .+ wrote:/i.test(value)) return true;
  return false;
}

function parseFromHeader(from) {
  const raw = String(from || "").trim();
  const bracket = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (bracket) {
    return { display: bracket[1].trim().replace(/^["']|["']$/g, ""), email: bracket[2].trim() };
  }
  const email = normalizeEmailAddress(raw);
  return { display: raw || email, email };
}

function quoteAttributionDate(sourceEmail) {
  const raw = sourceEmail?.internalDate || sourceEmail?.date;
  const parsed = raw ? new Date(raw) : new Date();
  if (Number.isNaN(parsed.getTime())) return "unknown date";

  const day = WEEKDAYS[parsed.getDay()];
  const dd = parsed.getDate();
  const mon = MONTHS[parsed.getMonth()];
  const yyyy = parsed.getFullYear();
  const hh = String(parsed.getHours()).padStart(2, "0");
  const mm = String(parsed.getMinutes()).padStart(2, "0");
  return `${day}, ${dd} ${mon} ${yyyy} at ${hh}:${mm}`;
}

/** Plain-text attribution: On Wed, 4 Jun 2025 at 14:15, Name <email> wrote: */
export function buildPlainAttribution(sourceEmail) {
  const { display, email } = parseFromHeader(sourceEmail?.from);
  const sender = display && email && display !== email ? `${display} <${email}>` : display || email || "sender";
  return `On ${quoteAttributionDate(sourceEmail)}, ${sender} wrote:`;
}

function prefixPlainQuoteLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plainToHtmlBlock(text) {
  return `<div dir="ltr">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
}

function isUsablePlainText(text) {
  const value = String(text || "").trim();
  return value.length > 0 && !looksLikeHtml(value);
}

/** Readable plain text for quoted parent body (preserves nested history). */
export function resolveQuotePlainText(originalPlain, originalHtml) {
  if (isUsablePlainText(originalPlain)) {
    return String(originalPlain).trim();
  }
  if (String(originalHtml || "").trim()) {
    return stripHtmlToText(originalHtml);
  }
  if (String(originalPlain || "").trim()) {
    return stripHtmlToText(originalPlain);
  }
  return "";
}

/** Sanitized parent HTML for Gmail-style blockquote (preserves nested history). */
export function resolveQuoteHtml(originalHtml, originalPlain) {
  if (String(originalHtml || "").trim()) {
    const sanitized = sanitizeHtmlForQuote(originalHtml);
    if (sanitized) return sanitized;
  }
  if (String(originalPlain || "").trim()) {
    return plainToHtmlBlock(originalPlain);
  }
  return "";
}

/** Gmail-style HTML quote wrapper around the parent message's original HTML/plain. */
export function buildHtmlQuoteBlock(sourceEmail, originalHtml, originalPlain) {
  const { display, email } = parseFromHeader(sourceEmail?.from);
  const sender =
    display && email && display !== email
      ? `${escapeHtml(display)} &lt;${escapeHtml(email)}&gt;`
      : escapeHtml(display || email || "sender");
  const dateStr = escapeHtml(quoteAttributionDate(sourceEmail));
  const quotedInner = resolveQuoteHtml(originalHtml, originalPlain);

  return (
    `<div class="gmail_quote">` +
    `<div dir="ltr" class="gmail_attr">On ${dateStr}, ${sender} wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">` +
    `${quotedInner}` +
    `</blockquote></div>`
  );
}

/**
 * Append quoted parent message below the new reply body (Gmail-native reply trailer).
 * Uses the parent's raw/un-stripped body so nested history cascades naturally.
 */
export function appendQuotedReply({ body = "", html, sourceEmail, quoteOriginal = true }) {
  const newBody = String(body || "").trim();
  const newHtml = typeof html === "string" && html.trim() ? html.trim() : undefined;

  if (!quoteOriginal || !sourceEmail) {
    return { body: newBody, html: newHtml };
  }

  if (bodyAlreadyQuoted(newBody) || (newHtml && bodyAlreadyQuoted(newHtml))) {
    return { body: newBody, html: newHtml };
  }

  const originalPlain = String(sourceEmail.rawBodyPlain || sourceEmail.bodyText || "").trim();
  const originalHtml = String(sourceEmail.rawBodyHtml || "").trim();

  if (!originalPlain && !originalHtml) {
    return { body: newBody, html: newHtml };
  }

  const attribution = buildPlainAttribution(sourceEmail);
  const quotePlainSource = resolveQuotePlainText(originalPlain, originalHtml);
  const quotedPlain = prefixPlainQuoteLines(quotePlainSource);
  const bodyWithQuote = newBody ? `${newBody}\n\n${attribution}\n${quotedPlain}` : `${attribution}\n${quotedPlain}`;

  let htmlWithQuote = newHtml;
  if (newHtml) {
    htmlWithQuote = `${newHtml}<br><br>${buildHtmlQuoteBlock(sourceEmail, originalHtml, originalPlain)}`;
  }

  return { body: bodyWithQuote, html: htmlWithQuote };
}
