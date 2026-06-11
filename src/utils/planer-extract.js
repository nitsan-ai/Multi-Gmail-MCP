import { createRequire } from "module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const planer = require("planer");

let cachedDocument = null;

function getDocument() {
  if (!cachedDocument) {
    cachedDocument = new JSDOM("").window.document;
  }
  return cachedDocument;
}

/**
 * Extract new reply text using planer (JS port of Mailgun talon).
 * @param {string} bodyText
 * @param {{ contentType?: 'text/plain' | 'text/html' }} options
 */
export function extractQuotesWithPlaner(bodyText, { contentType = "text/plain" } = {}) {
  const raw = String(bodyText || "");
  if (!raw.trim()) return "";

  try {
    if (contentType === "text/html") {
      return String(planer.extractFromHtml(raw, getDocument()) || "").trim();
    }
    return String(planer.extractFromPlain(raw) || "").trim();
  } catch {
    return "";
  }
}
