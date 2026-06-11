export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic"
];

export const DEFAULT_MAX_RESULTS = 20;
export const MAX_RESULTS_LIMIT = 100;
export const DEFAULT_THREAD_LATEST_N = 5;
export const MAX_THREAD_LATEST_N = 50;
/** Max threads when fetch list mode loads full latest message bodies (API cost). */
export const MAX_FETCH_LIST_WITH_BODY = 15;
