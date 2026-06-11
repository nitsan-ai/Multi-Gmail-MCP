/**
 * RFC 2047 encoded-words for non-ASCII email headers (Subject, etc.).
 */

/** Max UTF-8 bytes per encoded-word so the full header line stays under ~75 octets. */
const MAX_UTF8_BYTES_PER_WORD = 40;

/** Strip CR/LF from header values (header injection guard). */
export function sanitizeMimeHeaderValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

/** True when every char is ASCII (RFC 5322 header without encoded-words). */
function isAsciiHeaderValue(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Encode a header value for use in a raw RFC 822 message (e.g. Subject).
 * ASCII-only values pass through; UTF-8 uses =?UTF-8?B?…?= with folding.
 * Splits on Unicode character boundaries so each encoded-word decodes to valid UTF-8.
 */
export function encodeMimeHeaderValue(value) {
  const text = sanitizeMimeHeaderValue(value);
  if (!text) return "";
  if (isAsciiHeaderValue(text)) return text;

  const words = [];
  let chunk = "";
  let chunkByteLen = 0;

  for (const char of text) {
    const charLen = Buffer.byteLength(char, "utf8");
    if (chunk && chunkByteLen + charLen > MAX_UTF8_BYTES_PER_WORD) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
      chunkByteLen = 0;
    }
    chunk += char;
    chunkByteLen += charLen;
  }

  if (chunk) {
    words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  }

  return words.join("\r\n ");
}

const ENCODED_WORD_RE = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function decodeQuotedPrintableUtf8(q) {
  const bytes = [];
  const cleaned = q.replace(/_/g, " ");
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "=" && i + 2 < cleaned.length) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(cleaned.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeEncodedWord(charset, encoding, payload) {
  const enc = encoding.toUpperCase();
  const normalizedCharset = (charset || "utf-8").toLowerCase();
  if (enc === "B") {
    return Buffer.from(payload, "base64").toString(normalizedCharset === "utf-8" ? "utf8" : normalizedCharset);
  }
  if (enc === "Q") {
    return decodeQuotedPrintableUtf8(payload);
  }
  return payload;
}

/**
 * Decode RFC 2047 encoded-words in a header returned by Gmail (or other MUAs).
 * Plain UTF-8 / ASCII values are returned unchanged.
 */
export function decodeMimeHeaderValue(value) {
  const raw = String(value || "");
  if (!raw.includes("=?")) return raw;

  const unfolded = raw.replace(/\r\n[ \t]+/g, "");
  let out = "";
  let cursor = 0;
  ENCODED_WORD_RE.lastIndex = 0;
  let match = ENCODED_WORD_RE.exec(unfolded);
  while (match) {
    out += unfolded.slice(cursor, match.index);
    out += decodeEncodedWord(match[1], match[2], match[3]);
    cursor = ENCODED_WORD_RE.lastIndex;
    match = ENCODED_WORD_RE.exec(unfolded);
  }
  out += unfolded.slice(cursor);
  return out;
}
