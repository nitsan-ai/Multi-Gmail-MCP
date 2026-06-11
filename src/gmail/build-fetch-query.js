const INBOX_QUERY = "in:inbox";

export const FETCH_INBOX_LABEL_IDS = ["INBOX"];

/**
 * Builds the Gmail `q` parameter for multi_gmail_fetch.
 *
 * @param {{ query?: string, queryMode?: "inbox" | "raw", followUpLabelName?: string, followUpLabelEnabled?: boolean }} options
 */
export function buildFetchGmailListQuery({
  query,
  queryMode = "inbox",
  followUpLabelName,
  followUpLabelEnabled = true
} = {}) {
  const mode = queryMode || "inbox";
  let finalQuery = query?.trim() || "";

  if (mode === "inbox") {
    const followUpExclusion =
      followUpLabelEnabled && followUpLabelName
        ? `-label:"${followUpLabelName}"`
        : "";
    const inboxBaseQuery = followUpExclusion
      ? `${INBOX_QUERY} ${followUpExclusion}`
      : INBOX_QUERY;
    finalQuery = finalQuery ? `${inboxBaseQuery} ${finalQuery}`.trim() : inboxBaseQuery;
  }

  return finalQuery;
}

/** Inbox mode scopes listing to INBOX; raw mode relies on the caller query only. */
export function fetchListLabelIds(queryMode = "inbox") {
  return (queryMode || "inbox") === "inbox" ? FETCH_INBOX_LABEL_IDS : undefined;
}
