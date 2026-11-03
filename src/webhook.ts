import { DreamingError, errorMessage } from "./errors.js";
import type { RunRecord } from "./inbox/schema.js";

/**
 * Optional run summary for a chat webhook. The text carries counts only: no
 * proposal content, quotes or paths leave the machine.
 *
 * Two body shapes, chosen by `webhook.format`:
 *  - "text": `{"text": "..."}`, the shape Slack incoming webhooks (and Teams'
 *    older Office 365 connector webhooks) accept;
 *  - "adaptive-card": a message with one Adaptive Card attachment, the shape
 *    Microsoft Teams Workflows webhooks expect.
 */
export type WebhookFormat = "text" | "adaptive-card";

export function summaryText(record: RunRecord): string {
  const counts = { add: 0, update: 0, delete: 0 };
  for (const proposal of record.proposals) counts[proposal.action] += 1;
  const sessions = `${record.sessions.length} session${record.sessions.length === 1 ? "" : "s"}`;
  const total = record.proposals.length;
  if (total === 0) return `dreaming: read ${sessions}; nothing new to propose.`;
  const parts = (["add", "update", "delete"] as const)
    .filter((action) => counts[action] > 0)
    .map((action) => `${counts[action]} ${action}`);
  return `dreaming: read ${sessions}; ${total} proposal${total === 1 ? "" : "s"} waiting for review (${parts.join(", ")}). Run \`dreaming review\` to decide.`;
}

export function webhookBody(record: RunRecord, format: WebhookFormat): unknown {
  const text = summaryText(record);
  if (format === "text") return { text };
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [{ type: "TextBlock", text, wrap: true }],
        },
      },
    ],
  };
}

/** Webhook URLs are secrets; errors name the origin only. */
function describe(url: string): string {
  return new URL(url).origin;
}

export async function postWebhook(
  url: string,
  body: unknown,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // A redirect could move the request somewhere the URL check never saw.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new DreamingError(`webhook to ${describe(url)} failed: ${errorMessage(error)}`, { cause: error });
  }
  // The response body is not needed; release the connection.
  await response.body?.cancel();
  if (!response.ok) {
    throw new DreamingError(`webhook to ${describe(url)} returned HTTP ${response.status}`);
  }
}
