import { env } from "../config/env.js";

function userId() {
  return env.DEFAULT_GMAIL_USER_ID;
}

function findUserLabelByName(labels, wantedName) {
  const want = String(wantedName || "").trim();
  if (!want) return null;
  return labels?.find((l) => l.type === "user" && String(l.name).trim() === want) || null;
}

/**
 * Ensures a user Gmail label exists (visible in the left sidebar under Labels) and returns its id.
 */
export async function getOrCreateUserLabelId(gmail, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    throw new Error("Gmail label name is empty (check FOLLOW_UP_GMAIL_LABEL_NAME / GMAIL_REVIEW_GMAIL_LABEL_NAME in src/config/env.js)");
  }

  const uid = userId();
  const listOnce = async () => {
    const listRes = await gmail.users.labels.list({ userId: uid });
    return listRes.data.labels || [];
  };

  const existing = findUserLabelByName(await listOnce(), trimmed);
  if (existing?.id) {
    return existing.id;
  }

  try {
    const createRes = await gmail.users.labels.create({
      userId: uid,
      requestBody: {
        name: trimmed,
        labelListVisibility: "labelShow",
        messageListVisibility: "show"
      }
    });
    return createRes.data.id;
  } catch (err) {
    const code = err?.code;
    const msg = err?.message || String(err);
    const status = err?.response?.data?.error?.status;
    const isDup =
      code === 409 ||
      status === "ALREADY_EXISTS" ||
      /already exists|duplicate|Label name exists/i.test(msg);

    if (isDup) {
      const after = findUserLabelByName(await listOnce(), trimmed);
      if (after?.id) {
        return after.id;
      }
    }

    if (code === 403 || /Insufficient Permission|insufficient authentication scopes|ACCESS_TOKEN_SCOPE/i.test(msg)) {
      throw new Error(
        `${msg}\n\n` +
          "Gmail needs the **gmail.modify** scope to create labels. Re-authorize this account:\n" +
          "  npm run auth -- --alias <your-alias>\n" +
          "Then reconnect in your MCP client (connect + connect_finish)."
      );
    }

    throw err;
  }
}

export async function getOrCreateFollowUpLabelId(gmail) {
  return getOrCreateUserLabelId(gmail, env.FOLLOW_UP_GMAIL_LABEL_NAME);
}

/**
 * Creates MCP sidebar labels if missing (follow-up + inbox-review). Safe to call often.
 * @returns {{ followUpLabelId: string|null, inboxReviewLabelId: string|null }}
 */
export async function ensureMcpSidebarLabels(gmail) {
  let followUpLabelId = null;
  let inboxReviewLabelId = null;

  if (env.FOLLOW_UP_GMAIL_LABEL_ENABLED) {
    followUpLabelId = await getOrCreateFollowUpLabelId(gmail);
  }
  if (env.GMAIL_REVIEW_GMAIL_LABEL_ENABLED) {
    inboxReviewLabelId = await getOrCreateUserLabelId(gmail, env.GMAIL_REVIEW_GMAIL_LABEL_NAME);
  }

  return { followUpLabelId, inboxReviewLabelId };
}

export async function addLabelToMessage(gmail, messageId, labelId) {
  await gmail.users.messages.modify({
    userId: env.DEFAULT_GMAIL_USER_ID,
    id: messageId,
    requestBody: { addLabelIds: [labelId], removeLabelIds: [] }
  });
}

export async function removeLabelFromMessage(gmail, messageId, labelId) {
  await gmail.users.messages.modify({
    userId: env.DEFAULT_GMAIL_USER_ID,
    id: messageId,
    requestBody: { removeLabelIds: [labelId], addLabelIds: [] }
  });
}
