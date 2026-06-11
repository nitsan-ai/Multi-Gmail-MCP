import { z } from "zod";
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_THREAD_LATEST_N,
  MAX_FETCH_LIST_WITH_BODY,
  MAX_RESULTS_LIMIT,
  MAX_THREAD_LATEST_N
} from "../config/constants.js";
import { EMAIL_FORMAT_HTML, EMAIL_FORMAT_PLAIN } from "../utils/send-content.js";
import { optionalRecipientsField, recipientsField } from "../utils/recipients.js";

/** MIME type for outbound body: plain (default) or HTML in multipart/alternative. */
export const emailFormatField = {
  format: z
    .enum([EMAIL_FORMAT_PLAIN, EMAIL_FORMAT_HTML])
    .optional()
    .default(EMAIL_FORMAT_PLAIN)
};

/** Append Gmail-style quoted parent message below reply body (default true). */
export const quoteOriginalField = {
  quoteOriginal: z.boolean().optional().default(true)
};

/** Append the account Gmail signature from Settings (default true). */
export const appendSignatureField = {
  appendSignature: z.boolean().optional().default(true)
};

export const listAccountsSchema = z.object({}).strict();

export const helpOnboardingSchema = z.object({}).strict();

/** Use a token file alias from accounts when the client shares one "default" MCP session across chats. */
export const accountAliasField = {
  accountAlias: z.string().min(1).optional()
};

/**
 * When your MCP host reuses one server/session for every UI chat, pass the same unique chatScope on
 * connect, connect_finish, set_signer, and every Gmail tool in that chat so each
 * email/task keeps its own OAuth binding. Example: chatScope: "japan-inbox" vs "work-us".
 */
export const chatScopeField = {
  chatScope: z.string().min(1).max(128).optional()
};

export const connectAccountSchema = z
  .object({
    command: z.string().min(1),
    ...chatScopeField
  })
  .strict();

// `code` is optional — when omitted the MCP server awaits the authorization code
// delivered automatically via the local loopback server started by connect.
// Providing it explicitly still works for backward compatibility.
export const completeConnectAccountSchema = z
  .object({
    code: z.string().min(1).optional(),
    /** Same as the `alias` (or `pendingAlias`) returned by connect. Required only if multiple connects are in flight in one chat. */
    pendingAlias: z.string().min(1).optional(),
    ...chatScopeField
  })
  .strict();

/** Optional routing for multi-account / shared-session hosts. */
export const workspaceStatusSchema = z
  .object({
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

export const setResponseModeSchema = z
  .object({
    mode: z.enum(["standard", "compact"]),
    ...chatScopeField
  })
  .strict();

export const runSetupDiagnosticsSchema = z
  .object({
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

/** Create MCP sidebar labels in Gmail if missing (same as bootstrap on fetch). */
export const ensureMcpGmailLabelsSchema = z
  .object({
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();


export const setSignerNameSchema = z
  .object({
    // max 100 chars; no CR/LF/TAB — guards against header-injection when the
    // name is interpolated into outgoing email bodies (BUG-6).
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^\r\n\t]+$/, "Name must not contain control characters (CR, LF, or TAB)."),
    followUpLabel: z.string().min(1).max(100).optional(),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

/** Fetch inbox threads. Recommended: mode=list, then get_thread per selected thread. */
export const fetchUnreadSmartDraftsSchema = z
  .object({
    /**
     * list = metadata-only triage (default). full = legacy batch load + auto-draft (avoid — token-heavy).
     */
    mode: z.enum(["list", "full"]).optional().default("list"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS_LIMIT)
      .optional()
      .default(DEFAULT_MAX_RESULTS),
    query: z.string().optional().default(""),
    /**
     * inbox = prepend inbox review filters (in:inbox, exclude follow-up label). raw = pass query to Gmail unchanged.
     */
    queryMode: z.enum(["inbox", "raw"]).optional().default("inbox"),
    /**
     * list mode only: fetch full plain-text body of the latest message per thread (not just Gmail snippet).
     * Capped at MAX_FETCH_LIST_WITH_BODY threads per call. Attachments are metadata only. Prefer get_thread for one thread.
     */
    includeLatestBody: z.boolean().optional().default(false),
    /**
     * true = also create/update a Gmail Draft per message. Default false — review drafts in chat (and optional .md) first; use send to send; set true only if you want copies in Gmail Drafts.
     */
    saveGmailDrafts: z.boolean().optional().default(false),
    /**
     * Write one combined review .md under GMAIL_REVIEW_MARKDOWN_DIR (same run as drafts in chat). Default true — one fetch = reply drafts + review in chat and on disk. Set false for chat/JSON only.
     */
    writeMarkdownFile: z.boolean().optional().default(true),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

/**
 * Send approved reply. Plain z.object for MCP registration.
 * New outbound / campaigns: use sendNewEmailBaseSchema (`send_new`).
 */
export const sendSmartReplyBaseSchema = z
  .object({
    /** Source message to reply to — marks read and threads the send. */
    messageId: z.string().min(1),
    to: recipientsField(),
    subject: z.string().min(1),
    /** Message content. With format=text/html this is the HTML part (plain fallback auto-generated). */
    body: z.string().min(1).optional(),
    /** @deprecated Prefer body + format=text/html. Legacy HTML part (multipart/alternative). */
    html: z.string().min(1).optional(),
    ...emailFormatField,
    cc: optionalRecipientsField(),
    bcc: optionalRecipientsField(),
    ...quoteOriginalField,
    ...appendSignatureField,
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

function requireBodyOrHtml(value, ctx, htmlKeys = ["html"]) {
  const hasBody = typeof value.body === "string" && value.body.trim().length > 0;
  const hasHtml = htmlKeys.some(
    (key) => typeof value[key] === "string" && value[key].trim().length > 0
  );
  if (!hasBody && !hasHtml) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body"],
      message:
        "Provide body (use format text/html for HTML), and/or legacy html / htmlBody."
    });
  }
}

export const sendSmartReplySchema = sendSmartReplyBaseSchema.superRefine((value, ctx) => {
  requireBodyOrHtml(value, ctx, ["html"]);
});

/**
 * New outbound email (new Gmail thread). No messageId — for campaigns and cold outreach.
 * Plain z.object() for MCP registration; cross-field rules in sendNewEmailSchema.
 */
export const sendNewEmailBaseSchema = z
  .object({
    to: recipientsField(),
    /** Optional — append to an existing thread (e.g. campaign email 2). From prior send_new `threadId`. */
    threadId: z.string().min(1).optional(),
    subject: z.string().min(1),
    /** Message content. With format=text/html this is the HTML part (plain fallback auto-generated). */
    body: z.string().min(1).optional(),
    /** @deprecated Prefer body + format=text/html. Legacy HTML body for campaigns. */
    htmlBody: z.string().min(1).optional(),
    ...emailFormatField,
    cc: optionalRecipientsField(),
    bcc: optionalRecipientsField(),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

export const sendNewEmailSchema = sendNewEmailBaseSchema.superRefine((value, ctx) => {
  requireBodyOrHtml(value, ctx, ["htmlBody"]);
});

/** Save/update a Gmail draft reply for a thread without sending. */
export const setDraftReplySchema = z
  .object({
    messageId: z.string().min(1),
    to: recipientsField(),
    subject: z.string().min(1),
    body: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    ...emailFormatField,
    cc: optionalRecipientsField(),
    bcc: optionalRecipientsField(),
    ...quoteOriginalField,
    ...appendSignatureField,
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

export const setDraftReplyValidatedSchema = setDraftReplySchema.superRefine((value, ctx) => {
  requireBodyOrHtml(value, ctx, ["html"]);
});

/**
 * Plain z.object() registered with MCP's registerTool — the SDK normalises only z.object()
 * shapes to JSON Schema. Wrapping with .superRefine() produces a ZodEffects node that the SDK
 * cannot serialise, yielding an empty "properties" block and stripping all arguments before
 * the handler runs (BUG-1). Cross-field rules are enforced in handleTriggerFollowUp
 * after parsing with this same schema.
 */
export const followUpTriggerBaseSchema = z
  .object({
    messageId: z.string().min(1),
    pattern: z.string().min(1).optional(),
    daysList: z.array(z.number().int().min(1).max(365)).min(1).max(10).optional(),
    businessDaysOnly: z.boolean().optional().default(false),
    dueWeekday: z
      .enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"])
      .optional(),
    createGmailDraft: z.boolean().optional().default(false),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

/** Full schema (with cross-field validation) used only inside parseSchema in the handler. */
export const followUpTriggerSchema = followUpTriggerBaseSchema.superRefine((value, ctx) => {
  const hasPattern = typeof value.pattern === "string" && value.pattern.trim().length > 0;
  const hasDaysList = Array.isArray(value.daysList);
  if (hasPattern && hasDaysList) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["daysList"],
      message: "Use either pattern or daysList, not both."
    });
  }
  if (!hasPattern && !hasDaysList) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pattern"],
      message: "Provide either pattern or daysList."
    });
  }
  if (hasDaysList) {
    const unique = Array.from(new Set(value.daysList));
    const sorted = [...value.daysList].sort((a, b) => a - b);
    if (unique.length !== value.daysList.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daysList"],
        message: "daysList cannot contain duplicates."
      });
    }
    if (sorted.some((item, index) => item !== value.daysList[index])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daysList"],
        message: "daysList must be sorted in ascending order."
      });
    }
  }
});

export const followUpCheckDueSchema = z
  .object({
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

export const getThreadSchema = z
  .object({
    threadId: z.string().min(1),
    /**
     * metadata = headers/dates only (no bodies).
     * latest = first message + latest N messages (with omission marker).
     * full = complete plain-text transcript (default).
     */
    format: z.enum(["metadata", "latest", "full"]).optional().default("full"),
    /** Used when format=latest; how many trailing messages to include after the first. */
    latestN: z
      .number()
      .int()
      .min(1)
      .max(MAX_THREAD_LATEST_N)
      .optional()
      .default(DEFAULT_THREAD_LATEST_N),
    /** true = remove quoted reply history (use when drafting in multi-message threads). false = full plain-text body (default). */
    stripped: z.boolean().optional().default(false),
    /** true = include `rawText` alongside stripped `text` (when stripped=true). Ignored when format=metadata. */
    includeRaw: z.boolean().optional().default(false),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

export const archiveThreadSchema = z
  .object({
    threadId: z.string().min(1),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

/** List Gmail Drafts folder. */
export const fetchDraftsSchema = z
  .object({
    maxResults: z.number().int().min(1).max(MAX_RESULTS_LIMIT).optional().default(DEFAULT_MAX_RESULTS),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

/** List Gmail Sent folder. */
export const fetchSentSchema = z
  .object({
    maxResults: z.number().int().min(1).max(MAX_RESULTS_LIMIT).optional().default(DEFAULT_MAX_RESULTS),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

/** Remove stored follow-up reminders (local store only; optional Gmail label removal). */
export const followUpCleanupBaseSchema = z
  .object({
    reminderIds: z.array(z.string().min(1)).min(1).optional(),
    messageId: z.string().min(1).optional(),
    messageHeaderId: z.string().min(1).optional(),
    sourceThreadId: z.string().min(1).optional(),
    followUpChainId: z.string().min(1).optional(),
    /** When deleting by reminderIds, also remove all reminders in the same followUpChainId. */
    cancelChain: z.boolean().optional().default(false),
    /** Delete every reminder for the active account. Requires confirm: true. */
    deleteAll: z.boolean().optional().default(false),
    confirm: z.boolean().optional().default(false),
    statuses: z
      .array(z.enum(["pending", "due", "waiting", "sent", "resolved_by_reply"]))
      .optional(),
    /** Remove Multi-Gmail-MCP Follow-up label when no reminders remain for a source message. Default true. */
    removeGmailLabel: z.boolean().optional().default(true),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

export const followUpCleanupSchema = followUpCleanupBaseSchema.superRefine((value, ctx) => {
  const hasIds = Array.isArray(value.reminderIds) && value.reminderIds.length > 0;
  const hasMessage = Boolean(value.messageId?.trim());
  const hasMessageHeader = Boolean(value.messageHeaderId?.trim());
  const hasThread = Boolean(value.sourceThreadId?.trim());
  const hasChain = Boolean(value.followUpChainId?.trim());
  const hasDeleteAll = value.deleteAll === true;

  if (!hasIds && !hasMessage && !hasMessageHeader && !hasThread && !hasChain && !hasDeleteAll) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reminderIds"],
      message:
        "Provide reminderIds, messageId, messageHeaderId, sourceThreadId, followUpChainId, or deleteAll with confirm."
    });
  }
  if (hasDeleteAll && value.confirm !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confirm"],
      message: "deleteAll requires confirm: true."
    });
  }
});

/** Send a stored follow-up after explicit user approval. Overrides to/subject/body are optional if the draft is complete. */
export const followUpSendSchema = z
  .object({
    reminderId: z.string().min(1),
    to: optionalRecipientsField(),
    subject: z.string().optional(),
    body: z.string().optional(),
    html: z.string().min(1).optional(),
    ...emailFormatField,
    cc: optionalRecipientsField(),
    bcc: optionalRecipientsField(),
    ...quoteOriginalField,
    ...appendSignatureField,
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();
