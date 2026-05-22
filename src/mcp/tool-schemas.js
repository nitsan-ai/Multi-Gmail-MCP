import { z } from "zod";
import { DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT } from "../config/constants.js";

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

/** Fetch inbox mail (all inbox categories), summarize, draft replies. */
export const fetchUnreadSmartDraftsSchema = z
  .object({
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS_LIMIT)
      .optional()
      .default(DEFAULT_MAX_RESULTS),
    query: z.string().optional().default(""),
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

/** Send an approved smart-reply and mark the source message as read. Use messageId from fetch. */
export const sendSmartReplySchema = z
  .object({
    messageId: z.string().min(1),
    to: z.union([z.string().email(), z.array(z.string().email())]),
    subject: z.string().min(1),
    body: z.string().min(1),
    cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

/** Save/update a Gmail draft reply for a thread without sending. */
export const setDraftReplySchema = z
  .object({
    messageId: z.string().min(1),
    to: z.union([z.string().email(), z.array(z.string().email())]),
    subject: z.string().min(1),
    body: z.string().min(1),
    cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();

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

/** Send a stored follow-up after explicit user approval. Overrides to/subject/body are optional if the draft is complete. */
export const followUpSendSchema = z
  .object({
    reminderId: z.string().min(1),
    to: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    ...accountAliasField,
    ...chatScopeField
  })
  .strict();
