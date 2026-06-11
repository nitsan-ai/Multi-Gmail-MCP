import { AppError } from "./errors.js";
import { stripHtmlToText } from "./html-text.js";

export const EMAIL_FORMAT_PLAIN = "text/plain";
export const EMAIL_FORMAT_HTML = "text/html";

/**
 * Resolve plain + optional HTML parts for outbound email (send, draft, follow-up).
 * Legacy `html` / `htmlBody` still imply HTML when set.
 */
export function resolveOutboundEmailParts({
  body,
  html,
  htmlBody,
  format = EMAIL_FORMAT_PLAIN
} = {}) {
  const legacyHtml = (typeof html === "string" ? html : typeof htmlBody === "string" ? htmlBody : "")
    .trim();
  const bodyText = typeof body === "string" ? body.trim() : "";

  if (legacyHtml) {
    return {
      body: bodyText || stripHtmlToText(legacyHtml).trim() || "(no plain-text version)",
      html: legacyHtml,
      format: EMAIL_FORMAT_HTML
    };
  }

  if (!bodyText) {
    throw new AppError(
      "body is required (use format text/html when body contains HTML)",
      "VALIDATION_ERROR",
      400
    );
  }

  if (format === EMAIL_FORMAT_HTML) {
    return {
      body: stripHtmlToText(bodyText).trim() || "(no plain-text version)",
      html: bodyText,
      format: EMAIL_FORMAT_HTML
    };
  }

  if (format !== EMAIL_FORMAT_PLAIN) {
    throw new AppError(
      `format must be "${EMAIL_FORMAT_PLAIN}" or "${EMAIL_FORMAT_HTML}"`,
      "VALIDATION_ERROR",
      400
    );
  }

  return {
    body: bodyText,
    html: undefined,
    format: EMAIL_FORMAT_PLAIN
  };
}
