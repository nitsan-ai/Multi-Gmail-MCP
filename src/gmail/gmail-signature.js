import { env } from "../config/env.js";
import { stripHtmlToText } from "../utils/html-text.js";

/** Detect an existing Gmail signature block to avoid double-appending. */
export function bodyContainsSignature(text) {
  return /class=["'][^"']*gmail_signature/i.test(String(text || ""));
}

/** Pick the send-as alias whose signature should be used for outbound mail. */
export function resolveSendAsAlias(aliases = [], fromAddress) {
  if (!Array.isArray(aliases) || aliases.length === 0) return null;

  const normalizedFrom = String(fromAddress || "").toLowerCase().trim();
  if (normalizedFrom) {
    const match = aliases.find(
      (alias) => String(alias.sendAsEmail || "").toLowerCase() === normalizedFrom
    );
    if (match) return match;
  }

  return (
    aliases.find((alias) => alias.isDefault) ||
    aliases.find((alias) => alias.isPrimary) ||
    aliases[0] ||
    null
  );
}

/** Trim trailing whitespace and empty HTML blocks from a compose body. */
function normalizeHtmlBodyEnd(html) {
  let body = String(html || "");
  body = body.replace(/[\s\u00a0]+$/u, "");

  const trailingEmpty =
    /(?:<br\s*\/?>\s*|<(?:p|div|span)(?:\s[^>]*)?>\s*(?:&nbsp;|\u00a0|<br\s*\/?>\s*)*<\/(?:p|div|span)>\s*)+$/iu;

  let prev;
  do {
    prev = body;
    body = body.replace(trailingEmpty, "").replace(/[\s\u00a0]+$/u, "");
  } while (body !== prev);

  return body;
}

/** Trim trailing blank lines and whitespace from a plain-text compose body. */
function normalizeTextBodyEnd(text) {
  return String(text || "")
    .replace(/(?:[ \t\u00a0]*\n[ \t\u00a0]*)+$/u, "")
    .replace(/[ \t\u00a0]+$/u, "");
}

function wrapSignatureHtml(signatureHtml) {
  const sig = String(signatureHtml || "").trim();
  if (!sig) return "";
  if (bodyContainsSignature(sig)) return sig;
  return (
    `<div class="gmail_signature" data-smartmail="gmail_signature">` +
    `<div dir="ltr">-- <br>${sig}</div></div>`
  );
}

const SIGNATURE_TEXT_DELIMITER = "\n\n-- \n";

/**
 * Append signature HTML after the new body and before any existing gmail_quote block.
 * Matches Gmail compose: one blank line, RFC 3676 "-- " delimiter, then signature.
 */
export function appendSignatureToHtml(html, signatureHtml) {
  const sig = String(signatureHtml || "").trim();
  if (!sig) return normalizeHtmlBodyEnd(html);

  let body = normalizeHtmlBodyEnd(html);
  if (!body) return sig;
  if (bodyContainsSignature(body)) return body;

  const quoteMatch = body.match(/<(?:div|blockquote)\b[^>]*class=["'][^"']*gmail_quote/i);
  if (quoteMatch && quoteMatch.index > 0) {
    const before = normalizeHtmlBodyEnd(body.slice(0, quoteMatch.index));
    const after = body.slice(quoteMatch.index);
    return `${before}<br>${sig}<br><br>${after}`;
  }

  return `${body}<br>${sig}`;
}

/**
 * Append plain-text signature after the new body and before any quoted reply trailer.
 * Matches Gmail compose: one blank line, RFC 3676 "-- " delimiter, then signature.
 */
export function appendSignatureToText(body, signaturePlain) {
  const sig = String(signaturePlain || "").trim();
  if (!sig) return normalizeTextBodyEnd(body);

  let text = normalizeTextBodyEnd(body);
  if (!text) return `-- \n${sig}`;
  if (bodyContainsSignature(text)) return text;

  const onWroteMatch = text.match(/\nOn .+ wrote:\s*(\n|$)/i);
  if (onWroteMatch && onWroteMatch.index > 0) {
    const before = normalizeTextBodyEnd(text.slice(0, onWroteMatch.index));
    const after = text.slice(onWroteMatch.index).trimStart();
    return `${before}${SIGNATURE_TEXT_DELIMITER}${sig}\n\n${after}`;
  }

  return `${text}${SIGNATURE_TEXT_DELIMITER}${sig}`;
}

/**
 * Fetch the Gmail Settings signature for the resolved send-as alias.
 * Returns HTML string or null when none is configured or the API is unavailable.
 */
export async function getGmailSignature(gmail, fromAddress) {
  try {
    const response = await gmail.users.settings.sendAs.list({
      userId: env.DEFAULT_GMAIL_USER_ID
    });
    const aliases = response.data.sendAs || [];
    const match = resolveSendAsAlias(aliases, fromAddress);
    const signature = String(match?.signature || "").trim();
    return signature || null;
  } catch {
    return null;
  }
}

/**
 * Append the account Gmail signature to outbound plain/HTML parts (before quoted reply).
 */
export async function applyAccountSignature({
  gmail,
  fromAddress,
  body,
  html,
  appendSignature = true
}) {
  if (appendSignature === false) {
    return { body, html };
  }

  const plainSeed = typeof body === "string" ? body : "";
  const htmlSeed = typeof html === "string" && html.trim() ? html.trim() : undefined;

  if (bodyContainsSignature(plainSeed) || (htmlSeed && bodyContainsSignature(htmlSeed))) {
    return { body: plainSeed, html: htmlSeed };
  }

  const signatureHtml = await getGmailSignature(gmail, fromAddress);
  if (!signatureHtml) {
    return { body: plainSeed, html: htmlSeed };
  }

  const signaturePlain = stripHtmlToText(signatureHtml);
  const wrappedHtml = wrapSignatureHtml(signatureHtml);

  return {
    body: appendSignatureToText(plainSeed, signaturePlain),
    html: htmlSeed ? appendSignatureToHtml(htmlSeed, wrappedHtml) : htmlSeed
  };
}
