/** Recommended inbox processing — avoids loading multiple full threads into one LLM context. */

export const INBOX_WORKFLOW_POLICY =
  "Never load multiple full threads into one LLM context. Use fetch mode=list, then get_thread one selected thread at a time.";

export const INBOX_WORKFLOW_STEPS = [
  'Call `fetch` with `mode="list"` to load inbox thread metadata.',
  "Use metadata (subject, participants, snippet, direction, dates) to decide which threads need a reply or follow-up.",
  'For each selected thread, call `get_thread` once (default `format=full`, `stripped=true`).',
  "Generate one draft from that thread's cleaned stripped transcript.",
  "After review/approval, use `send` or `set_draft`, then move to the next thread."
];

export const INBOX_WORKFLOW_AVOID =
  "Do not use `fetch` with `mode=full` to batch-load many threads for drafting — it can cause token overflow.";

export function inboxWorkflowMarkdown({ heading = "### Recommended inbox workflow" } = {}) {
  return [
    heading,
    "",
    `> ${INBOX_WORKFLOW_POLICY}`,
    "",
    ...INBOX_WORKFLOW_STEPS.map((step, index) => `${index + 1}. ${step}`),
    "",
    `> ${INBOX_WORKFLOW_AVOID}`,
    ""
  ].join("\n");
}

export function inboxWorkflowPayload() {
  return {
    policy: INBOX_WORKFLOW_POLICY,
    steps: INBOX_WORKFLOW_STEPS,
    avoid: INBOX_WORKFLOW_AVOID
  };
}
