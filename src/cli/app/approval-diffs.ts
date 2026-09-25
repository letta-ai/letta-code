import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { StaticItem } from "./types";

export function buildApprovalBatchKey(approvals: ApprovalRequest[]): string {
  return approvals
    .map((approval) => approval.toolCallId)
    .sort()
    .join("|");
}

/**
 * Release the heavy before/after file contents of every cached diff owned by
 * a tool call: the plain `toolCallId` key plus ApplyPatch compound keys
 * (`toolCallId:filePath`). Renderers only read `hunks`
 * (AdvancedDiffRenderer, estimateAdvancedDiffLines), so the full-file
 * `oldStr`/`newStr` payloads are dead weight once the hunks exist.
 *
 * Mutates entries in place: eagerly-committed `approval_preview` static items
 * hold the same object reference as the map entry, so swapping in a stripped
 * copy would leave the payload reachable through the item.
 */
export function releasePrecomputedDiffPayloads(
  diffs: Map<string, AdvancedDiffSuccess>,
  toolCallId: string,
): void {
  const direct = diffs.get(toolCallId);
  if (direct) {
    direct.oldStr = "";
    direct.newStr = "";
  }
  const compoundPrefix = `${toolCallId}:`;
  for (const [key, diff] of diffs) {
    if (key.startsWith(compoundPrefix)) {
      diff.oldStr = "";
      diff.newStr = "";
    }
  }
}

/**
 * Release diff payloads for tool calls whose transcript item has been
 * committed to the static area (and therefore rendered). Covers finished
 * `tool_call` items and eagerly-committed `approval_preview` items — the
 * latter represent successful file edits whose `tool_call` line is
 * deliberately never committed (see shouldSkipCommittedToolCall in
 * AppCoordinator), so the preview commit is their only release signal.
 *
 * Entries themselves are kept with hunks intact: Ink <Static> remounts
 * (terminal-resize repaints, ctrl+o expansion, display toggles) re-render
 * every committed item, and renderers need the hunks to reproduce the diff.
 *
 * `processedItemIds` is caller-owned and survives append-only `items`
 * updates (and is robust to `items` being replaced on conversation switch,
 * since item ids are never reused).
 */
export function releaseCommittedDiffPayloads(
  diffs: Map<string, AdvancedDiffSuccess>,
  items: StaticItem[],
  processedItemIds: Set<string>,
): void {
  for (const item of items) {
    if (processedItemIds.has(item.id)) continue;
    processedItemIds.add(item.id);
    if (item.kind === "tool_call" && item.toolCallId) {
      releasePrecomputedDiffPayloads(diffs, item.toolCallId);
    } else if (item.kind === "approval_preview") {
      releasePrecomputedDiffPayloads(diffs, item.toolCallId);
    }
  }
}
