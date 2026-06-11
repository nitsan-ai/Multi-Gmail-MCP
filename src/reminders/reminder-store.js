import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { env } from "../config/env.js";

const EMPTY_STORE = {
  version: 1,
  reminders: []
};

let storeMutation = Promise.resolve();

async function ensureStoreFile() {
  const storePath = env.FOLLOWUP_REMINDERS_PATH;
  await fs.mkdir(path.dirname(storePath), { recursive: true });

  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify(EMPTY_STORE, null, 2), "utf8");
  }
}

async function readStoreFile() {
  await ensureStoreFile();
  const raw = await fs.readFile(env.FOLLOWUP_REMINDERS_PATH, "utf8");
  if (!raw.trim()) {
    return { ...EMPTY_STORE };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_STORE };
  }
  return {
    version: 1,
    reminders: Array.isArray(parsed?.reminders) ? parsed.reminders : []
  };
}

async function writeStoreFile(store) {
  await ensureStoreFile();
  await fs.writeFile(env.FOLLOWUP_REMINDERS_PATH, JSON.stringify(store, null, 2), "utf8");
}

function queueMutation(work) {
  const run = storeMutation.then(work);
  storeMutation = run.catch(() => {});
  return run;
}

export async function listFollowUpReminders() {
  const store = await readStoreFile();
  return [...store.reminders];
}

export async function getFollowUpReminder(reminderId) {
  const reminders = await listFollowUpReminders();
  return reminders.find((reminder) => reminder.id === reminderId) || null;
}

export async function createFollowUpReminder(data) {
  return queueMutation(async () => {
    const store = await readStoreFile();
    const now = new Date().toISOString();
    const reminder = {
      id: randomUUID(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      notifiedAt: null,
      sentAt: null,
      resolvedAt: null,
      resolutionReason: null,
      lastEvaluatedAt: null,
      ...data
    };

    store.reminders.push(reminder);
    await writeStoreFile(store);
    return reminder;
  });
}

export async function updateFollowUpReminder(reminderId, updater) {
  return queueMutation(async () => {
    const store = await readStoreFile();
    const index = store.reminders.findIndex((reminder) => reminder.id === reminderId);
    if (index === -1) {
      return null;
    }

    const current = store.reminders[index];
    const patch = typeof updater === "function" ? await updater(current) : updater;
    const updated = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    store.reminders[index] = updated;
    await writeStoreFile(store);
    return updated;
  });
}

export async function listDuePendingFollowUps(now = new Date()) {
  const dueAt = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const reminders = await listFollowUpReminders();

  return reminders.filter((reminder) => {
    if (!["pending", "due"].includes(reminder.status)) {
      return false;
    }

    const reminderDueAt = new Date(reminder.dueAt).getTime();
    return Number.isFinite(reminderDueAt) && reminderDueAt <= dueAt;
  });
}

/**
 * Remove reminders matching `predicate`. Returns removed records (newest-first stable order).
 */
export async function deleteFollowUpReminders(predicate) {
  return queueMutation(async () => {
    const store = await readStoreFile();
    const removed = [];
    store.reminders = store.reminders.filter((reminder) => {
      if (predicate(reminder)) {
        removed.push(reminder);
        return false;
      }
      return true;
    });
    if (removed.length > 0) {
      await writeStoreFile(store);
    }
    return removed;
  });
}
