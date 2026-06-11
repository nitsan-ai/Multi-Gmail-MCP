import { JSDOM } from "jsdom";
import { extractQuotesWithPlaner } from "./planer-extract.js";

const OFFICE_XML_TAG = /^(?:o|w|v|m|st\d):/i;

/**
 * Strip HTML tags so bodyText is always plain text (BUG-3).
 * Handles common entities, removes <style>/<script> blocks, and converts
 * <br> / </p> to newlines to preserve paragraph structure.
 * Anchor tags become "label (url)" before generic tag removal.
 */
export function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, inner) => {
        const label = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (!label || label === href) return href;
        return `${label} (${href})`;
      }
    )
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

export function looksLikeHtml(text) {
  return /<[a-z][\s\S]*>/i.test(String(text).trimStart().slice(0, 300));
}

/** Strip document envelope / MSO noise; keep renderable body HTML for reply quotes. */
export function sanitizeHtmlForQuote(html) {
  let raw = String(html || "").trim();
  if (!raw) return "";

  raw = raw
    .replace(/<!\s*--\[if[\s\S]*?<!\[endif]\s*-->/gi, "")
    .replace(/<!\s*--[\s\S]*?-->/g, "")
    .replace(/<!\s*doctype[^>]*>/gi, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "");

  try {
    const { document } = new JSDOM(raw).window;
    for (const node of [...document.querySelectorAll("style, script, head, meta, link, title, xml")]) {
      node.remove();
    }
    for (const node of [...document.querySelectorAll("*")]) {
      const tag = node.tagName || "";
      if (OFFICE_XML_TAG.test(tag)) node.remove();
    }

    const inner = document.body?.innerHTML?.trim() || "";
    if (inner) return inner;
  } catch {
    // Fall through to regex cleanup below.
  }

  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
    .trim();
}

/** Planer (talon) quote removal on HTML, then convert to readable plaintext. */
export function htmlToPlainBody(html) {
  const raw = String(html || "");
  if (!raw.trim()) return "";
  const withoutQuotes = extractQuotesWithPlaner(raw, { contentType: "text/html" }) || raw;
  return stripHtmlToText(withoutQuotes);
}
