import { createHash } from "node:crypto";
import { appendExternalTranscriptEntries } from "@/cli/helpers/reflection-transcript";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { openHandsAdapter } from "./openhands";
import { transcriptAdapter } from "./transcript";
import type { DreamAdapter } from "./types";

export type { DreamAdapter } from "./types";

/**
 * Registered dream adapters, keyed by the `<type>` in `--from <type>:<path>`.
 * Add a new dream source type by importing its adapter and adding one entry here.
 */
const ADAPTERS: Record<string, DreamAdapter> = {
  claude: claudeCodeAdapter,
  codex: codexAdapter,
  openhands: openHandsAdapter,
  transcript: transcriptAdapter,
};

export interface ParsedSource {
  adapter: DreamAdapter;
  locator: string;
}

/**
 * Parse a `--from` value. Returns the adapter + locator for a typed source
 * (`<type>:<path>`), or null for a bare conversation id (the agent's own
 * transcript). Throws on a typed value whose type is not registered.
 */
export function parseFromSource(spec: string): ParsedSource | null {
  const sep = spec.indexOf(":");
  if (sep < 0) return null; // bare conversation id → the agent's own transcript
  const type = spec.slice(0, sep);
  const locator = spec.slice(sep + 1);
  const adapter = ADAPTERS[type];
  if (!adapter) {
    throw new Error(
      `Unknown dream source type "${type}". Supported: ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  if (!locator) {
    throw new Error(`Invalid --from "${spec}": missing path after "${type}:"`);
  }
  return { adapter, locator };
}

/**
 * A stable synthetic conversation id for a source spec, so repeated runs of
 * the same source accumulate into (and dedupe against) the same transcript.
 */
export function conversationIdForSource(parsed: ParsedSource): string {
  const hash = createHash("sha1")
    .update(`${parsed.adapter.type}:${parsed.locator}`)
    .digest("hex")
    .slice(0, 12);
  return `from-${parsed.adapter.type}-${hash}`;
}

export interface StageFromSourceResult {
  conversationId: string;
  appended: number;
  skipped: number;
}

/**
 * Convert a typed `--from` source and stage it into the reflection transcript.
 * Returns the synthetic conversation id the entries were staged under (which
 * the caller reflects on) plus append/skip counts.
 */
export async function stageFromSource(
  agentId: string,
  parsed: ParsedSource,
): Promise<StageFromSourceResult> {
  const conversationId = conversationIdForSource(parsed);
  const entries = await parsed.adapter.convert(parsed.locator);
  const { appended, skipped } = await appendExternalTranscriptEntries(
    agentId,
    conversationId,
    entries,
  );
  return { conversationId, appended, skipped };
}
