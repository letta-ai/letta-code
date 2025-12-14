/**
 * Subagent aggregation utilities for grouping Task tool calls.
 * Extracts subagent grouping logic from App.tsx commitEligibleLines.
 */

import type { Line } from "./accumulator.js";
import type { StaticSubagent } from "../components/SubagentGroupStatic.js";
import { isTaskTool } from "./toolNameMapping.js";

/**
 * A finished Task tool call with its line data and subagent info
 */
export interface TaskToolCallInfo {
  id: string;
  line: Line & {
    kind: "tool_call";
    subagent: NonNullable<Extract<Line, { kind: "tool_call" }>["subagent"]>;
  };
}

/**
 * Static item for a group of completed subagents
 */
export interface SubagentGroupItem {
  kind: "subagent_group";
  id: string;
  agents: StaticSubagent[];
}

/**
 * Checks if there are any in-progress Task tool calls in the buffer
 */
export function hasInProgressTaskToolCalls(
  order: string[],
  byId: Map<string, Line>,
  emittedIds: Set<string>,
): boolean {
  for (const id of order) {
    const ln = byId.get(id);
    if (!ln) continue;
    if (ln.kind === "tool_call" && isTaskTool(ln.name ?? "")) {
      if (emittedIds.has(id)) continue;
      if (ln.phase !== "finished") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Collects finished Task tool calls that are ready for grouping.
 * Only returns results when all Task tool calls are finished.
 */
export function collectFinishedTaskToolCalls(
  order: string[],
  byId: Map<string, Line>,
  emittedIds: Set<string>,
  hasInProgress: boolean,
): TaskToolCallInfo[] {
  if (hasInProgress) {
    return [];
  }

  const finished: TaskToolCallInfo[] = [];

  for (const id of order) {
    if (emittedIds.has(id)) continue;
    const ln = byId.get(id);
    if (!ln) continue;

    if (
      ln.kind === "tool_call" &&
      isTaskTool(ln.name ?? "") &&
      ln.phase === "finished" &&
      ln.subagent
    ) {
      finished.push({
        id,
        line: ln as TaskToolCallInfo["line"],
      });
    }
  }

  return finished;
}

/**
 * Creates a subagent_group static item from collected Task tool calls
 */
export function createSubagentGroupItem(
  taskToolCalls: TaskToolCallInfo[],
): SubagentGroupItem {
  return {
    kind: "subagent_group",
    id: `subagent-group-${Date.now().toString(36)}`,
    agents: taskToolCalls.map((tc) => ({
      id: tc.line.subagent.id,
      type: tc.line.subagent.type,
      description: tc.line.subagent.description,
      status: tc.line.subagent.status as "completed" | "error",
      toolCount: tc.line.subagent.toolCount,
      totalTokens: tc.line.subagent.totalTokens,
      agentURL: tc.line.subagent.agentURL,
      error: tc.line.subagent.error,
    })),
  };
}
