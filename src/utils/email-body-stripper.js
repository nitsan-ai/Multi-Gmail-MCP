import EmailReplyParser from "email-reply-parser";
import { extractQuotesWithPlaner } from "./planer-extract.js";
import { looksLikeHtml } from "./html-text.js";

const replyParser = new EmailReplyParser();

const LEGAL_BOILERPLATE_LINE =
  /^(?:confidentiality notice|disclaimer|privileged(?:\s+and\s+confidential)?|important:\s*this\s+(?:e-?mail|message)|this\s+(?:e-?mail|message)\s+(?:and\s+any\s+attachments\s+)?(?:is\s+)?(?:intended|confidential|privileged)|the\s+information\s+(?:in|contained\s+in)\s+this|if\s+you\s+(?:are\s+not|have\s+received)\s+the\s+intended|please\s+consider\s+the\s+environment|this\s+communication\s+is\s+for|unauthorized\s+(?:use|disclosure|review)|avast\s+antivirus|scanned\s+by\s+(?:mail|email)\s+security)/i;

const TRAILING_SIGNATURE_PATTERNS = [
  /^--\s*$/,
  /^_{5,}$/,
  /^sent from my (?:iphone|ipad|mac|galaxy|android|phone)/i,
  /^get outlook for/i,
  /^envoyé (?:de mon|depuis)/i,
  /^verzonden vanaf/i,
  /^gesendet von/i
];

/** Horizontal rules used as signature dividers (e.g. ——————, ------). */
function isSignatureSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 4) return false;
  if (/^[\s\-–—―═_]{4,}$/.test(trimmed)) return true;
  return false;
}

/** Gmail/Outlook/Apple quote header with no quoted body left after stripping. */
const ORPHAN_QUOTE_HEADER_PATTERNS = [
  /^on\s.+?\bwrote\s*:\s*$/i,
  /^on\s.+?<[^>]+>\s+wrote\s*:\s*$/i,
  /^am\s.+?\bschrieb\s*:\s*$/i,
  /^le\s.+?\ba\s+écrit\s*:\s*$/i,
  /^el\s.+?\bescribió\s*:\s*$/i
];

function isOrphanQuoteHeaderLine(line) {
  const trimmed = lineForPatternMatch(line);
  if (!trimmed) return false;
  if (ORPHAN_QUOTE_HEADER_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return /^on\s.+?\bwrote\s*:?\s*$/i.test(trimmed);
}

/** True when a line starts a quoted / forwarded block (fallback path). */
function isQuoteBoundaryLine(line) {
  if (/^>/.test(line)) return false;
  if (/^[-_]{2,}\s*original message\s*[-_]{2,}$/i.test(line)) return true;
  if (/^-----original message-----$/i.test(line)) return true;
  if (/^_{5,}$/.test(line)) return true;
  if (/^on\s.+?\bwrote\s*:\s*$/i.test(line)) return true;
  if (/^am .+schrieb( .+)?:\s*$/i.test(line)) return true;
  if (/^le .+ a écrit\s*:\s*$/i.test(line)) return true;
  if (/^el .+ escribió\s*:\s*$/i.test(line)) return true;
  if (/^begin forwarded message:\s*$/i.test(line)) return true;
  if (/^-{5,}\s*forwarded message\s*-{5,}$/i.test(line)) return true;
  if (/^from:\s+.+\[?mailto:/i.test(line)) return true;
  return false;
}

function normalizeBodyText(bodyText) {
  return String(bodyText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

/** Flatten simple HTML left by parsers so line-based rules still apply. */
function stripHtmlEnvelopeForProcessing(text) {
  if (!looksLikeHtml(text)) return text;
  return text
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(?:p|div|tr|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function lineForPatternMatch(line) {
  return stripHtmlEnvelopeForProcessing(line).replace(/\s+/g, " ").trim();
}

function meaningfulCharCount(text) {
  return String(text || "").replace(/\s/g, "").length;
}

/**
 * Line-based fallback for Gmail, Outlook, and Apple Mail when parsers miss edge cases.
 */
export function stripQuotedReplyContentFallback(bodyText) {
  const text = normalizeBodyText(bodyText);
  if (!text) return "";

  const lines = text.split("\n");
  const kept = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (/^>/.test(line)) continue;
    if (isQuoteBoundaryLine(line)) break;
    if (/^(from|sent|date|subject|to|cc|bcc|reply-to):\s+/i.test(line)) continue;
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isLegalBoilerplateLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (LEGAL_BOILERPLATE_LINE.test(trimmed)) return true;
  if (trimmed.length > 200 && /\b(confidential|privileged|intended recipient|unauthorized)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

/** Remove leading confidentiality / legal disclaimer blocks. */
function stripLeadingLegalDisclaimer(text) {
  const lines = text.split("\n");
  const kept = [];
  let skipping = true;
  let removedAny = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (skipping) {
      if (!line) continue;
      if (isLegalBoilerplateLine(line)) {
        removedAny = true;
        continue;
      }
      skipping = false;
    }
    kept.push(rawLine);
  }

  return removedAny ? kept.join("\n").trim() : text;
}

/** Remove trailing signature blocks (after --, mobile clients, Outlook footers). */
function stripTrailingSignatures(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    if (
      TRAILING_SIGNATURE_PATTERNS.some((pattern) => pattern.test(line)) ||
      isSignatureSeparatorLine(line)
    ) {
      return lines.slice(0, index).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return text;
}

/** Remove dash-rule signature blocks (——————) and everything below them. */
function stripDashSignatureBlocks(text) {
  const lines = text.split("\n");
  let cutAt = lines.length;

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    if (isSignatureSeparatorLine(line)) {
      cutAt = index;
      continue;
    }
    break;
  }

  if (cutAt < lines.length) {
    return lines
      .slice(0, cutAt)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const kept = [];
  for (let index = 0; index < lines.length; index++) {
    if (isSignatureSeparatorLine(lines[index].trim())) {
      while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
      break;
    }
    kept.push(lines[index]);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tailHasSubstantiveContent(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^>/.test(line)) return true;
    if (isOrphanQuoteHeaderLine(line) || isQuoteBoundaryLine(line)) continue;
    if (meaningfulCharCount(line) > 0) return true;
  }
  return false;
}

/** Remove `>` quoted lines and quote-header lines parsers left behind. */
function stripQuotedArtifacts(text) {
  const lines = text.split("\n");
  const kept = [];

  for (const line of lines) {
    const trimmed = lineForPatternMatch(line);
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (/^>/.test(trimmed)) continue;
    if (isQuoteBoundaryLine(trimmed) || isOrphanQuoteHeaderLine(trimmed)) continue;
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Remove "On Wed … wrote:" lines whose quoted body was already stripped away. */
function stripOrphanQuoteHeaderLines(text) {
  const lines = text.split("\n");
  const kept = [];

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (isOrphanQuoteHeaderLine(trimmed) && !tailHasSubstantiveContent(lines, index + 1)) {
      continue;
    }
    kept.push(lines[index]);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\n\s*On\s.+?\bwrote\s*:\s*)+$/i, "")
    .trim();
}

const CLOSING_LINE =
  /^(?:best regards|kind regards|warm regards|thanks|thank you|sincerely|cheers|regards),?!?\s*$/i;

function isLikelySignatureLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^\+?[\d\s().-]{10,}$/.test(trimmed)) return true;
  if (/\|/.test(trimmed) && trimmed.length < 120) return true;
  if (
    /\b(senior|junior|lead|head|director|manager|engineer|consultant|analyst|specialist)\b/i.test(
      trimmed
    ) &&
    trimmed.length < 120
  ) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/@[\w.-]+\.[a-z]{2,}/i.test(trimmed) && trimmed.length < 80) return true;
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(trimmed)) return true;
  return false;
}

/** Remove name/title/contact lines after a standard email closing. */
function stripClosingSignatureBlock(text) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!CLOSING_LINE.test(lines[index].trim())) continue;
    const tail = lines.slice(index + 1).filter((line) => line.trim());
    if (tail.length === 0) {
      return lines.slice(0, index).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    if (tail.every(isLikelySignatureLine)) {
      return lines.slice(0, index).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return text;
}

/** Drop repeated legal footer lines at the end of the message. */
function stripTrailingLegalFooter(text) {
  const lines = text.split("\n");
  let end = lines.length;

  while (end > 0) {
    const line = lines[end - 1].trim();
    if (!line) {
      end--;
      continue;
    }
    if (isLegalBoilerplateLine(line)) {
      end--;
      continue;
    }
    break;
  }

  if (end === lines.length) return text;
  return lines.slice(0, end).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function postProcessStripped(text) {
  let result = normalizeBodyText(stripHtmlEnvelopeForProcessing(normalizeBodyText(text)));
  if (!result) return "";
  result = stripLeadingLegalDisclaimer(result);
  result = stripTrailingLegalFooter(result);
  result = stripQuotedArtifacts(result);
  result = stripOrphanQuoteHeaderLines(result);
  result = stripDashSignatureBlocks(result);
  result = stripTrailingSignatures(result);
  result = stripClosingSignatureBlock(result);
  result = stripOrphanQuoteHeaderLines(result);
  result = stripQuotedArtifacts(result);
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function parseWithPlaner(bodyText, isHtml) {
  try {
    return normalizeBodyText(
      extractQuotesWithPlaner(bodyText, { contentType: isHtml ? "text/html" : "text/plain" })
    );
  } catch {
    return "";
  }
}

function parseWithEmailReplyParser(bodyText) {
  try {
    return normalizeBodyText(replyParser.parseReply(bodyText));
  } catch {
    return "";
  }
}

function scoreCandidate(candidate, originalLength) {
  const len = meaningfulCharCount(candidate);
  if (len === 0) return -Infinity;

  let score = len;
  if (originalLength > 100) {
    const ratio = len / originalLength;
    if (ratio > 0.95) score -= 1000;
    if (ratio < 0.05) score -= 500;
  }
  return score;
}

function pickBestFromCandidates(candidates, original) {
  const origLen = meaningfulCharCount(original);
  const unique = [...new Set(candidates.filter(Boolean))];
  if (unique.length === 0) return "";
  if (unique.length === 1) return unique[0];

  let best = unique[0];
  let bestScore = scoreCandidate(best, origLen);
  for (let index = 1; index < unique.length; index++) {
    const score = scoreCandidate(unique[index], origLen);
    if (score > bestScore) {
      best = unique[index];
      bestScore = score;
    }
  }
  return best;
}

/**
 * Extract only the new human-written reply (no quotes, forwards, signatures, or legal boilerplate).
 * Pipeline: planer (talon) → email-reply-parser → line fallback → signature/disclaimer post-process.
 */
export function extractNewReplyContent(bodyText) {
  const normalized = normalizeBodyText(bodyText);
  if (!normalized) return "";

  const isHtml = looksLikeHtml(normalized);
  const planerResult = postProcessStripped(parseWithPlaner(normalized, isHtml));
  const parserResult = postProcessStripped(parseWithEmailReplyParser(normalized));
  const fallbackResult = postProcessStripped(stripQuotedReplyContentFallback(normalized));

  const merged = pickBestFromCandidates([planerResult, parserResult, fallbackResult], normalized);
  const finalText = postProcessStripped(merged);

  if (!finalText && meaningfulCharCount(normalized) > 0) {
    const safeFallback = postProcessStripped(stripQuotedReplyContentFallback(normalized));
    if (safeFallback) return safeFallback;
    return normalized;
  }

  return finalText;
}

/** @deprecated Use extractNewReplyContent — kept for existing imports. */
export function stripQuotedReplyContent(bodyText) {
  return extractNewReplyContent(bodyText);
}
