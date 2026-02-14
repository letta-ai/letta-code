/**
 * Split the current agent's conversation history into chunk files,
 * one per (conversation × month).
 *
 * The main agent runs this ONCE before launching history-analyzer subagents.
 * Each subagent reads its assigned chunk file(s) — no API access required.
 *
 * Usage:
 *   LETTA_AGENT_ID=agent-xxx LETTA_API_KEY=sk-xxx bun <this-file> \
 *     [--output-dir /tmp/letta-history-splits]
 *
 * Outputs a JSON manifest to stdout listing every chunk file produced.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Letta from "@letta-ai/letta-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 200_000;
const PAGE_LIMIT = 100;
/** Max API pages per chunk — caps extraction time per conversation */
const MAX_PAGES_PER_CHUNK = 3;
const CONCURRENCY = 10;
const DEFAULT_MAX_CONVERSATIONS = 50;

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

const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

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

function formatMessage(msg: Record<string, any>): string | null {
  const date = msg.date
    ? new Date(msg.date).toISOString().replace("T", " ").replace(/\.\d+Z$/, "")
    : "????-??-?? ??:??:??";

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
      // Show just the key arg values, truncated
      const vals = Object.values(parsed).map((v: any) =>
        typeof v === "string" ? truncate(v, 60) : String(v).slice(0, 30)
      );
      args = vals.length > 0 ? ` ${vals.join(", ")}` : "";
    } catch { /* ignore parse errors */ }
    return `[${date}] TOOL: ${name}${truncate(args, 120)}`;
  }

  return null;
}

/** Generate monthly [start, end) buckets covering the given range. */
function monthlyBuckets(oldest: Date, newest: Date): Array<{ start: Date; end: Date; label: string }> {
  const buckets: Array<{ start: Date; end: Date; label: string }> = [];
  const cur = new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), 1));
  const limit = new Date(Date.UTC(newest.getUTCFullYear(), newest.getUTCMonth() + 1, 1));

  while (cur < limit) {
    const year = cur.getUTCFullYear();
    const month = cur.getUTCMonth();
    const start = new Date(cur);
    const end = new Date(Date.UTC(year, month + 1, 1));
    const label = `${year}-${MONTH_NAMES[month]}`;
    buckets.push({ start, end, label });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }

  return buckets;
}

/** Safe filename from a conversation ID or "default". */
function convLabel(convId: string, summary: string | null): string {
  if (summary) {
    // Use first 30 chars of summary, sanitized
    return summary.slice(0, 30).replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase() || convId.slice(0, 12);
  }
  return convId.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Extraction (single chunk)
// ---------------------------------------------------------------------------

interface ChunkResult {
  file: string;
  conversation_id: string;
  conversation_label: string;
  time_label: string;
  messages_kept: number;
  total_scanned: number;
  truncated: boolean;
}

async function extractChunk(
  client: InstanceType<typeof Letta>,
  agentId: string,
  conversationId: string,
  convDisplayLabel: string,
  startDate: Date,
  endDate: Date,
  timeLabel: string,
  outputDir: string,
): Promise<ChunkResult | null> {
  const filename = `${convDisplayLabel}-${timeLabel}.txt`;
  const outputPath = join(outputDir, filename);

  const rangeLabel = `${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`;

  const lines: string[] = [];
  lines.push(`=== Letta Agent History: ${rangeLabel} ===`);
  lines.push(`=== Agent: ${agentId} ===`);
  lines.push(`=== Conversation: ${conversationId} (${convDisplayLabel}) ===`);
  lines.push(""); // blank line before messages

  let totalMessages = 0;
  let keptMessages = 0;
  let outputChars = lines.join("\n").length;
  let truncated = false;
  let cursor: string | undefined = undefined;

  const collected: string[] = [];
  let pagesRead = 0;

  // Paginate newest-first for fast access to recent ranges
  while (pagesRead < MAX_PAGES_PER_CHUNK) {
    const listParams: Record<string, any> = {
      limit: PAGE_LIMIT,
      order: "desc" as const,
      conversation_id: conversationId,
    };
    if (cursor) listParams.before = cursor;

    const page = await client.agents.messages.list(agentId, listParams);
    const messages: any[] = page.data ?? page.items ?? [];
    pagesRead++;

    if (messages.length === 0) break;

    let passedStartDate = false;

    for (const msg of messages) {
      totalMessages++;

      if (msg.date) {
        const msgTime = new Date(msg.date).getTime();
        if (msgTime >= endDate.getTime()) continue;
        if (msgTime < startDate.getTime()) {
          passedStartDate = true;
          break;
        }
      }

      const type: string = msg.message_type ?? "";
      if (!KEEP_TYPES.has(type)) continue;

      const formatted = formatMessage(msg);
      if (!formatted) continue;

      if (outputChars + formatted.length + 1 > MAX_OUTPUT_CHARS) {
        truncated = true;
        break;
      }

      collected.push(formatted);
      keptMessages++;
      outputChars += formatted.length + 1;
    }

    if (truncated || passedStartDate) break;

    const lastMsg = messages[messages.length - 1];
    const lastId = lastMsg?.id;
    if (!lastId || lastId === cursor) break;
    cursor = lastId;
  }

  // Skip empty chunks
  if (keptMessages === 0) return null;

  // Reverse for chronological order
  collected.reverse();
  lines.push(...collected);

  // Insert count header
  lines.splice(
    lines.indexOf(""),
    0,
    `=== Messages: ${keptMessages} kept (${totalMessages} scanned)${truncated ? " [TRUNCATED]" : ""} ===`,
  );

  if (truncated) {
    lines.push("");
    lines.push(`[Output truncated at ${MAX_OUTPUT_CHARS} chars.]`);
  }

  writeFileSync(outputPath, lines.join("\n"), "utf-8");

  return {
    file: outputPath,
    conversation_id: conversationId,
    conversation_label: convDisplayLabel,
    time_label: timeLabel,
    messages_kept: keptMessages,
    total_scanned: totalMessages,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      "output-dir": { type: "string" },
      "months": { type: "string" },
      "max-conversations": { type: "string" },
    },
    strict: true,
  });

  const agentId = process.env.LETTA_AGENT_ID;
  if (!agentId) die("LETTA_AGENT_ID environment variable is required");

  const apiKey = process.env.LETTA_API_KEY;
  if (!apiKey) die("LETTA_API_KEY environment variable is required");

  const baseURL = process.env.LETTA_BASE_URL || "https://api.letta.com";
  const outputDir = values["output-dir"] || "/tmp/letta-history-splits";
  const maxMonths = values["months"] ? parseInt(values["months"], 10) : 1;
  const maxConversations = values["max-conversations"] ? parseInt(values["max-conversations"], 10) : DEFAULT_MAX_CONVERSATIONS;

  mkdirSync(outputDir, { recursive: true });

  const client = new Letta({
    apiKey,
    baseURL,
    defaultHeaders: { "X-Letta-Source": "letta-code" },
  });

  // 1. List conversations (most recent first, capped)
  const allConversations = await client.conversations.list({ agent_id: agentId });
  // Sort newest-first by updated_at, then cap
  const sorted = [...allConversations].sort((a, b) => {
    const aTime = (a as any).updated_at ? new Date((a as any).updated_at).getTime() : 0;
    const bTime = (b as any).updated_at ? new Date((b as any).updated_at).getTime() : 0;
    return bTime - aTime;
  });
  const conversations = sorted.slice(0, maxConversations);

  if (conversations.length === 0) {
    console.log(JSON.stringify({ chunks: [], message: "No conversations found" }));
    return;
  }

  // 2. Get overall date range
  let oldestDate: Date | null = null;
  let newestDate: Date | null = null;

  try {
    const oldestPage = await client.agents.messages.list(agentId, { limit: 1, order: "asc" });
    const msg = oldestPage.data?.[0] ?? oldestPage.items?.[0];
    if (msg && "date" in msg && (msg as any).date) oldestDate = new Date((msg as any).date);
  } catch { /* empty */ }

  try {
    const newestPage = await client.agents.messages.list(agentId, { limit: 1, order: "desc" });
    const msg = newestPage.data?.[0] ?? newestPage.items?.[0];
    if (msg && "date" in msg && (msg as any).date) newestDate = new Date((msg as any).date);
  } catch { /* empty */ }

  if (!oldestDate || !newestDate) {
    console.log(JSON.stringify({ chunks: [], message: "No messages found" }));
    return;
  }

  // Clamp oldest date to --months window (default: 1 month back from newest)
  const cutoff = new Date(newestDate);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - maxMonths);
  if (oldestDate < cutoff) {
    console.error(`Clamping oldest date from ${oldestDate.toISOString()} to ${cutoff.toISOString()} (--months ${maxMonths})`);
    oldestDate = cutoff;
  }

  // 3. Compute monthly buckets
  const buckets = monthlyBuckets(oldestDate, newestDate);

  // 4. Build work items, skipping conversation/month pairs that can't overlap
  interface WorkItem {
    conv: (typeof conversations)[0];
    label: string;
    bucket: (typeof buckets)[0];
  }
  const work: WorkItem[] = [];

  for (const conv of conversations) {
    const label = convLabel(conv.id, (conv as any).summary ?? null);
    const convCreated = (conv as any).created_at ? new Date((conv as any).created_at).getTime() : 0;
    const convUpdated = (conv as any).updated_at ? new Date((conv as any).updated_at).getTime() : Date.now();

    for (const bucket of buckets) {
      // Skip if conversation dates don't overlap with this month
      if (convCreated >= bucket.end.getTime()) continue;
      if (convUpdated < bucket.start.getTime()) continue;
      work.push({ conv, label, bucket });
    }
  }

  console.error(`Found ${conversations.length} conversations, ${buckets.length} monthly buckets`);
  console.error(`${work.length} candidate chunks (${conversations.length * buckets.length - work.length} skipped by date overlap)`);
  console.error(`Date range: ${oldestDate.toISOString()} to ${newestDate.toISOString()}\n`);

  // 5. Extract chunks with concurrency
  const chunks: ChunkResult[] = [];

  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ conv, label, bucket }) => {
        console.error(`  ${label} / ${bucket.label}...`);
        const result = await extractChunk(
          client,
          agentId,
          conv.id,
          label,
          bucket.start,
          bucket.end,
          bucket.label,
          outputDir,
        );
        if (result) {
          console.error(`    → ${result.messages_kept} messages`);
        } else {
          console.error(`    → (empty, skipped)`);
        }
        return result;
      }),
    );
    for (const r of results) {
      if (r) chunks.push(r);
    }
  }

  // 6. Output manifest
  const manifest = {
    agent_id: agentId,
    output_dir: outputDir,
    date_range: { oldest: oldestDate.toISOString(), newest: newestDate.toISOString() },
    conversations: conversations.length,
    monthly_buckets: buckets.length,
    chunks_produced: chunks.length,
    chunks,
  };

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
