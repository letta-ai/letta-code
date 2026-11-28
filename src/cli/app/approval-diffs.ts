import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { StaticItem } from "./types";

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
