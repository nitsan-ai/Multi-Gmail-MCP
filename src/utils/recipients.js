import { z } from "zod";

const EMAIL_CHECK = z.string().email();

/**
 * Split a recipient header value on commas outside angle brackets.
 * Supports: "a@b.com, c@d.com" and "Name <a@b.com>, Other <c@d.com>".
 */
export function splitRecipientTokens(value) {
  const str = String(value || "").trim();
  if (!str) return [];

  const tokens = [];
  let current = "";
  let bracketDepth = 0;
  let inQuotes = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && str[i - 1] !== "\\") {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "<") bracketDepth++;
      if (ch === ">") bracketDepth = Math.max(0, bracketDepth - 1);
      if (ch === "," && bracketDepth === 0) {
        if (current.trim()) tokens.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }

  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

/** Parse one token into { display, email, formatted }. */
export function parseRecipientToken(token) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return { display: null, email: "", formatted: "" };
  }

  const bracketMatch = trimmed.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (bracketMatch) {
    const display = bracketMatch[1].trim().replace(/^["']|["']$/g, "");
    const email = bracketMatch[2].trim();
    return {
      display: display || null,
      email,
      formatted: display ? `${display} <${email}>` : email
    };
  }

  return { display: null, email: trimmed, formatted: trimmed };
}

function isValidEmail(email) {
  return EMAIL_CHECK.safeParse(email).success;
}

/**
 * Normalize to/cc/bcc input for Gmail raw headers.
 * Accepts comma-separated string, array of strings, or RFC 5322 display-name form.
 * @returns {string | string[] | undefined} comma-joined string (or single-element semantics via join)
 */
export function normalizeRecipients(value) {
  if (value === undefined || value === null || value === "") return undefined;

  const rawTokens = Array.isArray(value)
    ? value.flatMap((item) => splitRecipientTokens(item))
    : splitRecipientTokens(value);

  if (rawTokens.length === 0) {
    throw new Error("At least one recipient email is required.");
  }

  const formatted = [];
  for (const token of rawTokens) {
    const { email, formatted: entry } = parseRecipientToken(token);
    if (!email) {
      throw new Error(`Invalid recipient: "${token}"`);
    }
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email: "${email}"`);
    }
    formatted.push(entry);
  }

  return formatted.join(", ");
}

/** Zod helper — required recipient field (to). */
export function recipientsField() {
  return z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .transform((value) => normalizeRecipients(value));
}

/** Zod helper — optional cc / bcc. */
export function optionalRecipientsField() {
  return z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional()
    .transform((value) => normalizeRecipients(value));
}
