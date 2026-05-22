import { google } from "googleapis";
import { getOAuthClientForAlias } from "../auth/account-manager.js";
import { writeTokens } from "../auth/token-store.js";

export async function createGmailClient(alias) {
  const oauth2Client = await getOAuthClientForAlias(alias);

  // Persist updated access/refresh tokens whenever Google rotates them.
  oauth2Client.on("tokens", async (tokens) => {
    const current = oauth2Client.credentials ?? {};
    const merged = {
      ...current,
      ...tokens
    };
    await writeTokens(alias, merged);
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  return { gmail, oauth2Client };
}

export async function sendMessage(gmail, raw) {
  return await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw }
  });
}
