import { getSubagentByToolCallId } from "@/agent/subagent-state";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import {
  collectFinishedTaskToolCalls,
  createSubagentGroupItem,
  hasInProgressTaskToolCalls,
} from "@/cli/helpers/subagent-aggregation";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping";
import { TOOL_CALL_COMMIT_DEFER_MS } from "./constants";
import type { StaticItem } from "./types";

export interface TranscriptCommitState {
  emittedIds: Set<string>;
  deferredCommits: Map<string, number>;
  eagerCommittedPreviews: Set<string>;
}

/** Collect immutable snapshots in display order, leaving blocked lines live. */
export function collectStaticTranscriptItems(
  b: Buffers,
  state: TranscriptCommitState,
  opts?: { deferToolCalls?: boolean; now?: number },
): {
  items: StaticItem[];
  nextCommitAt: number | null;
  clearedSubagentIds: string[];
} {
  const deferToolCalls = opts?.deferToolCalls !== false;
  const { emittedIds, deferredCommits, eagerCommittedPreviews } = state;
  let nextCommitAt: number | null = null;
  const clearedSubagentIds: string[] = [];
  const newlyCommitted: StaticItem[] = [];
  let firstTaskIndex = -1;
  const now = opts?.now ?? Date.now();
  let blockedByDeferred = false;
  // If we eagerly committed a tall preview for file tools, don't also
  // commit the successful tool_call line (preview already represents it).
  const shouldSkipCommittedToolCall = (ln: Line): boolean => {
    if (ln.kind !== "tool_call") return false;
    if (!ln.toolCallId || !ln.name) return false;
    if (ln.phase !== "finished" || ln.resultOk === false) return false;
    if (!eagerCommittedPreviews.has(ln.toolCallId)) return false;
    return (
      isFileEditTool(ln.name) ||
      isFileWriteTool(ln.name) ||
      isPatchTool(ln.name)
    );
  };

  const shouldSkipDeferral = (ln: Line): boolean => {
    if (ln.kind !== "tool_call") return false;
    if (ln.phase !== "finished") return false;
    // Skip deferral when the result is already available: the component height
    // has already changed (header + result), so deferring only extends the
    // live-area repaint window that causes ghost lines in the terminal scrollback.
    return ln.resultText != null;
  };
  if (!deferToolCalls && deferredCommits.size > 0) {
    deferredCommits.clear();
    nextCommitAt = null;
  }

  // Check if there are any in-progress Task tool_calls
  const hasInProgress = hasInProgressTaskToolCalls(b.order, b.byId, emittedIds);

  // Static cannot be inserted above earlier live text. A completed paragraph
  // may still sit behind another message that can receive more deltas.
  const pendingTextIndex = b.order.findIndex((id) => {
    const line = b.byId.get(id);
    return (
      !emittedIds.has(id) &&
      (line?.kind === "assistant" || line?.kind === "reasoning") &&
      line.phase === "streaming"
    );
  });
  const eligibleOrder =
    pendingTextIndex < 0 ? b.order : b.order.slice(0, pendingTextIndex);

  // Collect only Task calls before the same ordering barrier.
  const finishedTaskToolCalls = collectFinishedTaskToolCalls(
    eligibleOrder,
    b.byId,
    emittedIds,
    hasInProgress,
  );

  // Commit regular lines (non-Task tools)
  for (const id of eligibleOrder) {
    if (emittedIds.has(id)) continue;
    const ln = b.byId.get(id);
    if (!ln) continue;
    if (
      ln.kind === "user" ||
      ln.kind === "error" ||
      ln.kind === "status" ||
      ln.kind === "trajectory_summary"
    ) {
      emittedIds.add(id);
      newlyCommitted.push({ ...ln });
      continue;
    }
    // Events only commit when finished (they have running/finished phases)
    if (ln.kind === "event" && ln.phase === "finished") {
      emittedIds.add(id);
      newlyCommitted.push({ ...ln });
      continue;
    }
    // Commands with phase should only commit when finished
    if (ln.kind === "command" || ln.kind === "bash_command") {
      if (!ln.phase || ln.phase === "finished") {
        emittedIds.add(id);
        newlyCommitted.push({ ...ln });
      }
      continue;
    }
    // Handle Task tool_calls specially - track position but don't add individually
    // (unless there's no subagent data, in which case commit as regular tool call)
    if (ln.kind === "tool_call" && ln.name && isTaskTool(ln.name)) {
      if (hasInProgress && ln.toolCallId) {
        const subagent = getSubagentByToolCallId(ln.toolCallId);
        if (subagent) {
          if (firstTaskIndex === -1) {
            firstTaskIndex = newlyCommitted.length;
          }
          continue;
        }
      }
      // Check if this specific Task tool has subagent data (will be grouped)
      const hasSubagentData = finishedTaskToolCalls.some(
        (tc) => tc.lineId === id,
      );
      if (hasSubagentData) {
        // Has subagent data - will be grouped later
        if (firstTaskIndex === -1) {
          firstTaskIndex = newlyCommitted.length;
        }
        continue;
      }
      // No subagent data (e.g., backfilled from history) - commit as regular tool call
      if (ln.phase === "finished") {
        emittedIds.add(id);
        newlyCommitted.push({ ...ln });
      }
      continue;
    }
    if ("phase" in ln && ln.phase === "finished") {
      if (shouldSkipCommittedToolCall(ln)) {
        deferredCommits.delete(id);
        emittedIds.add(id);
        continue;
      }
      if (
        deferToolCalls &&
        ln.kind === "tool_call" &&
        (!ln.name || !isTaskTool(ln.name)) &&
        !shouldSkipDeferral(ln)
      ) {
        const commitAt = deferredCommits.get(id);
        if (commitAt === undefined) {
          const commitAt = now + TOOL_CALL_COMMIT_DEFER_MS;
          deferredCommits.set(id, commitAt);
          nextCommitAt = commitAt;
          blockedByDeferred = true;
          break;
        }
        if (commitAt > now) {
          nextCommitAt = commitAt;
          blockedByDeferred = true;
          break;
        }
        deferredCommits.delete(id);
      }
      emittedIds.add(id);
      newlyCommitted.push({ ...ln });
      // Note: We intentionally don't cleanup precomputedDiffs here because
      // the Static area renders AFTER this function returns (on next React tick),
      // and the diff needs to be available for ToolCallMessage to render.
      // The diffs will be cleaned up when the session ends or on next session start.
    }
  }

  // If we collected Task tool_calls (all are finished), create a subagent_group
  if (!blockedByDeferred && finishedTaskToolCalls.length > 0) {
    // Mark all as emitted
    for (const tc of finishedTaskToolCalls) {
      emittedIds.add(tc.lineId);
    }

    const groupItem = createSubagentGroupItem(finishedTaskToolCalls);

    // Insert at the position of the first Task tool_call
    newlyCommitted.splice(
      firstTaskIndex >= 0 ? firstTaskIndex : newlyCommitted.length,
      0,
      groupItem,
    );

    // Clear these agents from the subagent store
    clearedSubagentIds.push(...groupItem.agents.map((a) => a.id));
  }

  if (deferredCommits.size === 0) {
    nextCommitAt = null;
  }

  return { items: newlyCommitted, nextCommitAt, clearedSubagentIds };
}

/** Finished content remains live while an earlier message blocks promotion. */
export function selectLiveTranscriptItems(
  lines: Line[],
  emittedIds: Set<string>,
  options: {
    tokenStreamingEnabled: boolean;
    showCompactionsEnabled: boolean;
  },
): Line[] {
  return lines.filter((line) => {
    if (emittedIds.has(line.id)) return false;
    if (line.kind === "assistant" || line.kind === "reasoning") {
      return options.tokenStreamingEnabled || line.phase === "finished";
    }
    if (line.kind === "tool_call") {
      // Running/finished Task tools are displayed by SubagentGroupDisplay.
      if (line.name && isTaskTool(line.name)) {
        return line.phase === "ready" || line.phase === "streaming";
      }
      return true;
    }
    if (line.kind === "event") {
      return options.showCompactionsEnabled || line.eventType !== "compaction";
    }
    if (line.kind === "command") return line.phase !== "waiting";
    return (
      line.kind === "bash_command" ||
      line.kind === "user" ||
      line.kind === "status" ||
      line.kind === "error"
    );
  });
}
