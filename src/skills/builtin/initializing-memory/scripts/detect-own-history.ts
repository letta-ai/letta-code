/**
 * Detect the current agent's conversation history.
 *
 * Lists conversations, gets the overall date range, and reports whether
 * there is enough history to warrant a full analysis pass.
 *
 * Usage:
 *   LETTA_AGENT_ID=agent-xxx LETTA_API_KEY=sk-xxx bun <this-file>
 *
 * Outputs JSON to stdout.
 */

import Letta from "@letta-ai/letta-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function extractDate(msg: Record<string, unknown>): string | null {
  if ("date" in msg && typeof msg.date === "string") return msg.date;
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const agentId = process.env.LETTA_AGENT_ID;
  if (!agentId) die("LETTA_AGENT_ID environment variable is required");

  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) die("LETTA_API_KEY environment variable is required");

  const baseURL = process.env.LETTA_BASE_URL || "https://api.letta.com";

  const client = new Letta({
    apiKey,
    baseURL,
    defaultHeaders: { "X-Letta-Source": "letta-code" },
  });

  // 1. List conversations for this agent
  const conversations = await client.conversations.list({
    agent_id: agentId,
  });

  const convSummaries = conversations.map((c: any) => ({
    id: c.id,
    summary: c.summary ?? null,
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
  }));

  // 2. Get date range from the default agent message stream
  //    (oldest first, newest first — one message each)
  let oldestDate: string | null = null;
  let newestDate: string | null = null;

  try {
    const oldestPage = await client.agents.messages.list(agentId, {
      limit: 1,
      order: "asc",
    });
    const oldestMsg = oldestPage.data?.[0] ?? oldestPage.items?.[0];
    if (oldestMsg) oldestDate = extractDate(oldestMsg as any);
  } catch {
    // ignore — agent may have zero messages
  }

  try {
    const newestPage = await client.agents.messages.list(agentId, {
      limit: 1,
      order: "desc",
    });
    const newestMsg = newestPage.data?.[0] ?? newestPage.items?.[0];
    if (newestMsg) newestDate = extractDate(newestMsg as any);
  } catch {
    // ignore
  }

  // 3. Determine if history is significant
  //    (messages exist AND span > 1 day)
  let hasSignificantHistory = false;
  if (oldestDate && newestDate) {
    const spanMs =
      new Date(newestDate).getTime() - new Date(oldestDate).getTime();
    const ONE_DAY_MS = 86_400_000;
    hasSignificantHistory = spanMs > ONE_DAY_MS;
  }

  // 4. Output
  const result = {
    agent_id: agentId,
    conversations: convSummaries,
    conversation_count: convSummaries.length,
    date_range: {
      oldest: oldestDate,
      newest: newestDate,
    },
    has_significant_history: hasSignificantHistory,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
