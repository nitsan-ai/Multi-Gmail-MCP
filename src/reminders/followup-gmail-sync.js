import { createGmailClient } from "../gmail/gmail-client.js";
import {
  addLabelToMessage,
  getOrCreateFollowUpLabelId,
  removeLabelFromMessage
} from "../gmail/gmail-labels.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Apply the follow-up label to the original Gmail message so the thread appears under that label in Gmail.
 */
export async function tagSourceMessageForFollowUp(alias, sourceMessageId) {
  if (!env.FOLLOW_UP_GMAIL_LABEL_ENABLED || !sourceMessageId) {
    return { ok: true, skipped: true };
  }
  try {
    const { gmail } = await createGmailClient(alias);
    const labelId = await getOrCreateFollowUpLabelId(gmail);
    await addLabelToMessage(gmail, sourceMessageId, labelId);
    logger.info("follow-up Gmail label applied", {
      alias,
      sourceMessageId,
      labelName: env.FOLLOW_UP_GMAIL_LABEL_NAME
    });
    return { ok: true, labelName: env.FOLLOW_UP_GMAIL_LABEL_NAME };
  } catch (error) {
    logger.warn("follow-up Gmail label apply failed", {
      alias,
      sourceMessageId,
      message: error?.message || String(error)
    });
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Remove the follow-up label when the reminder is sent or no longer needed.
 */
export async function untagSourceMessageFollowUp(alias, sourceMessageId) {
  if (!env.FOLLOW_UP_GMAIL_LABEL_ENABLED || !sourceMessageId) {
    return { ok: true, skipped: true };
  }
  try {
    const { gmail } = await createGmailClient(alias);
    const labelId = await getOrCreateFollowUpLabelId(gmail);
    await removeLabelFromMessage(gmail, sourceMessageId, labelId);
    logger.info("follow-up Gmail label removed", {
      alias,
      sourceMessageId,
      labelName: env.FOLLOW_UP_GMAIL_LABEL_NAME
    });
    return { ok: true };
  } catch (error) {
    logger.warn("follow-up Gmail label remove failed", {
      alias,
      sourceMessageId,
      message: error?.message || String(error)
    });
    return { ok: false, error: error?.message || String(error) };
  }
}
