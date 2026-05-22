import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import {
  listDuePendingFollowUps,
  updateFollowUpReminder
} from "./reminder-store.js";
import { untagSourceMessageFollowUp } from "./followup-gmail-sync.js";
import { refreshDueFollowUpReminder } from "./followup-service.js";

let timer = null;
let isTickRunning = false;

function buildReminderNotification(reminder) {
  const lines = [
    `Follow-up reminder due for ${reminder.sourceFrom || reminder.draft?.to || "thread"}.`,
    `Reminder ID: ${reminder.id}`,
    `Subject: ${reminder.draft?.subject || reminder.sourceSubject || "(no subject)"}`,
    `Suggested message:`,
    "",
    reminder.draft?.body || "(no draft body available)"
  ];
  return lines.join("\n");
}

async function processReminder(server, reminder) {
  const evaluation = await refreshDueFollowUpReminder(reminder);

  if (evaluation.state === "resolved_by_reply") {
    await updateFollowUpReminder(reminder.id, {
      status: "resolved_by_reply",
      resolvedAt: new Date().toISOString(),
      resolutionReason: "Customer replied after the reminder was created.",
      summary: evaluation.summary,
      topic: evaluation.topic,
      latestExternalDate: evaluation.latestExternalDate,
      draft: {
        ...reminder.draft,
        ...evaluation.draft,
        gmailDraftId: evaluation.gmailDraft.gmailDraftId || reminder.draft?.gmailDraftId || null,
        gmailDraftAction: evaluation.gmailDraft.gmailDraftAction || null,
        gmailDraftError: evaluation.gmailDraft.gmailDraftError || null
      },
      lastEvaluatedAt: new Date().toISOString()
    });
    await untagSourceMessageFollowUp(reminder.alias, reminder.sourceMessageId);
    return;
  }

  const updatedReminder = await updateFollowUpReminder(reminder.id, {
    status: "due",
    summary: evaluation.summary,
    topic: evaluation.topic,
    latestExternalDate: evaluation.latestExternalDate,
    draft: {
      ...reminder.draft,
      ...evaluation.draft,
      gmailDraftId: evaluation.gmailDraft.gmailDraftId || reminder.draft?.gmailDraftId || null,
      gmailDraftAction: evaluation.gmailDraft.gmailDraftAction || null,
      gmailDraftError: evaluation.gmailDraft.gmailDraftError || null
    },
    notifiedAt: reminder.notifiedAt || new Date().toISOString(),
    lastEvaluatedAt: new Date().toISOString()
  });

  if (!reminder.notifiedAt && updatedReminder) {
    await server.sendLoggingMessage({
      level: "info",
      logger: "FollowUp",
      data: buildReminderNotification(updatedReminder)
    });
  }
}

async function tick(server) {
  if (isTickRunning) return;
  isTickRunning = true;

  try {
    const dueReminders = (await listDuePendingFollowUps()).filter(
      (reminder) => !reminder.notifiedAt
    );
    for (const reminder of dueReminders) {
      await processReminder(server, reminder);
    }
  } catch (error) {
    logger.error("FollowUp reminder notifier failed", {
      message: error?.message || String(error)
    });
  } finally {
    isTickRunning = false;
  }
}

export function startFollowUpNotifier(server) {
  if (timer) {
    return;
  }

  const intervalMs = env.FOLLOWUP_CHECK_INTERVAL_MS;
  timer = setInterval(() => {
    void tick(server);
  }, intervalMs);

  timer.unref?.();
  void tick(server);
}
