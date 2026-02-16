/**
 * Extract messages from the current agent's history into a readable text file.
 *
 * The main agent runs this BEFORE launching history-analyzer subagents so each
 * subagent can simply read its pre-extracted chunk — no API access required.
 *
 * Usage:
 *   LETTA_API_KEY=sk-xxx LETTA_BASE_URL=https://api.letta.com \
 *     bun <this-file> \
 *       --agent-id agent-xxx \
 *       --output /tmp/letta-history-splits/chunk-1.txt \
 *       [--conversation-id conv-xxx] \
 *       [--start-date 2025-06-01T00:00:00Z] \
 *       [--end-date 2025-09-01T00:00:00Z]
 *
 * Outputs a human-readable text file with timestamped messages.
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Letta from "@letta-ai/letta-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max output file size in characters (keep within subagent context limits) */
const MAX_OUTPUT_CHARS = 200_000;

/** Message types we care about (high signal, low noise) */
const KEEP_TYPES = new Set([
  "user_message",
  "assistant_message",
  "reasoning_message",
  "tool_call_message",
]);

/** Truncation limits per message type (chars). User messages kept in full. */
const TRUNCATE_LIMITS: Record<string, number> = {
  assistant_message: 500,
  reasoning_message: 200,
};

/** Page size for API pagination */
const PAGE_LIMIT = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "...";
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ");
    return text || null;
  }
  return null;
}

/** Format a message into a single readable line (or small block). */
function formatMessage(msg: Record<string, any>): string | null {
  const date = msg.date ? new Date(msg.date).toISOString().replace("T", " ").replace(/\.\d+Z$/, "") : "????-??-?? ??:??:??";

  const type: string = msg.message_type ?? "";

  if (type === "user_message") {
    const content = extractText(msg.content);
    if (!content) return null;
    // User messages kept in full — highest signal (feedback, corrections)
    return `[${date}] USER: ${content}`;
  }

  if (type === "assistant_message") {
    const content = extractText(msg.content);
    if (!content) return null;
    return `[${date}] ASSISTANT: ${truncate(content, TRUNCATE_LIMITS.assistant_message)}`;
  }

  if (type === "reasoning_message") {
    const reasoning = msg.reasoning ?? "";
    if (!reasoning) return null;
    return `[${date}] REASONING: ${truncate(reasoning, TRUNCATE_LIMITS.reasoning_message)}`;
  }

  if (type === "tool_call_message") {
    // One-line summary: tool name + brief args (shows what was explored)
    const tc = msg.tool_call ?? msg.tool_calls?.[0];
    if (!tc) return null;
    const name = tc.function?.name ?? tc.name ?? "unknown";
    let args = "";
    try {
      const parsed = typeof tc.function?.arguments === "string"
        ? JSON.parse(tc.function.arguments)
        : tc.function?.arguments ?? {};
      const vals = Object.values(parsed).map((v: any) =>
        typeof v === "string" ? truncate(v, 60) : String(v).slice(0, 30)
      );
      args = vals.length > 0 ? ` ${vals.join(", ")}` : "";
    } catch { /* ignore parse errors */ }
    return `[${date}] TOOL: ${name}${truncate(args, 120)}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      "agent-id": { type: "string" },
      "conversation-id": { type: "string" },
      "start-date": { type: "string" },
      "end-date": { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });

  const agentId = values["agent-id"];
  if (!agentId) die("--agent-id is required");

  const outputPath = values["output"];
  if (!outputPath) die("--output is required");

  const conversationId = values["conversation-id"] || undefined;
  const startDate = values["start-date"]
    ? new Date(values["start-date"])
    : null;
  const endDate = values["end-date"] ? new Date(values["end-date"]) : null;

  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) die("LETTA_API_KEY environment variable is required");

  const baseURL = process.env.LETTA_BASE_URL || "https://api.letta.com";

  const client = new Letta({
    apiKey,
    baseURL,
    defaultHeaders: { "X-Letta-Source": "letta-code" },
  });

  // Build header
  const rangeLabel = [
    startDate ? startDate.toISOString().slice(0, 10) : "start",
    endDate ? endDate.toISOString().slice(0, 10) : "now",
  ].join(" to ");

  const lines: string[] = [];
  lines.push(`=== Letta Agent History: ${rangeLabel} ===`);
  lines.push(`=== Agent: ${agentId} ===`);
  if (conversationId) {
    lines.push(`=== Conversation: ${conversationId} ===`);
  }
  lines.push(""); // blank line before messages

  let totalMessages = 0;
  let keptMessages = 0;
  let outputChars = lines.join("\n").length;
  let truncated = false;
  let cursor: string | undefined = undefined;

  // We paginate newest-first ("desc") so that for recent date ranges we
  // find matching messages quickly instead of scanning from message #1.
  // Collected messages are reversed at the end for chronological output.
  const collected: string[] = [];

  while (true) {
    const listParams: Record<string, any> = {
      limit: PAGE_LIMIT,
      order: "desc" as const,
    };
    if (conversationId) listParams.conversation_id = conversationId;
    if (cursor) listParams.before = cursor;

    const page = await client.agents.messages.list(agentId, listParams);
    const messages: any[] = page.data ?? page.items ?? [];

    if (messages.length === 0) break;

    let passedStartDate = false;

    for (const msg of messages) {
      totalMessages++;

      // Client-side date filtering (API doesn't support date ranges)
      if (msg.date) {
        const msgTime = new Date(msg.date).getTime();
        // Skip messages newer than end date
        if (endDate && msgTime > endDate.getTime()) continue;
        // Stop once we pass the start date (messages are newest-first)
        if (startDate && msgTime < startDate.getTime()) {
          passedStartDate = true;
          break;
        }
      }

      const type: string = msg.message_type ?? "";
      if (!KEEP_TYPES.has(type)) continue;

      const formatted = formatMessage(msg);
      if (!formatted) continue;

      // Check output size limit
      if (outputChars + formatted.length + 1 > MAX_OUTPUT_CHARS) {
        truncated = true;
        break;
      }

      collected.push(formatted);
      keptMessages++;
      outputChars += formatted.length + 1; // +1 for newline
    }

    if (truncated || passedStartDate) break;

    // Advance cursor — use the last (oldest) message's ID on this page
    const lastMsg = messages[messages.length - 1];
    const lastId = lastMsg?.id;
    if (!lastId || lastId === cursor) break; // no more pages
    cursor = lastId;
  }

  // Reverse so output is chronological (oldest first)
  collected.reverse();
  lines.push(...collected);

  // Update header with counts
  lines.splice(
    lines.indexOf(""), // find the blank line
    0,
    `=== Messages: ${keptMessages} kept (${totalMessages} scanned)${truncated ? " [TRUNCATED]" : ""} ===`,
  );

  if (truncated) {
    lines.push("");
    lines.push(
      `[Output truncated at ${MAX_OUTPUT_CHARS} chars. ${keptMessages} of ${totalMessages} messages included.]`,
    );
  }

  // Write output
  writeFileSync(outputPath, lines.join("\n"), "utf-8");

  console.log(
    JSON.stringify({
      output: outputPath,
      total_scanned: totalMessages,
      messages_kept: keptMessages,
      truncated,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
