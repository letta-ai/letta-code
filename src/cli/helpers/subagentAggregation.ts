/**
 * Subagent aggregation utilities for grouping Task tool calls.
 * Extracts subagent grouping logic from App.tsx commitEligibleLines.
 */

import type { StaticSubagent } from "../components/SubagentGroupStatic.js";
import type { Line } from "./accumulator.js";
import { getSubagentByToolCallId } from "./subagentState.js";
import { isTaskTool } from "./toolNameMapping.js";

/**
 * A finished Task tool call info
 */
export interface TaskToolCallInfo {
  lineId: string;
  toolCallId: string;
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
      ln.toolCallId
    ) {
      // Check if we have subagent data in the state store
      const subagent = getSubagentByToolCallId(ln.toolCallId);
      if (subagent) {
        finished.push({
          lineId: id,
          toolCallId: ln.toolCallId,
        });
      }
    }
  }

  return finished;
}

/**
 * Creates a subagent_group static item from collected Task tool calls.
 * Looks up subagent data from the state store.
 */
export function createSubagentGroupItem(
  taskToolCalls: TaskToolCallInfo[],
): SubagentGroupItem {
  const agents: StaticSubagent[] = [];

  for (const tc of taskToolCalls) {
    const subagent = getSubagentByToolCallId(tc.toolCallId);
    if (subagent) {
      agents.push({
        id: subagent.id,
        type: subagent.type,
        description: subagent.description,
        status: subagent.status as "completed" | "error",
        toolCount: subagent.toolCalls.length,
        totalTokens: subagent.totalTokens,
        agentURL: subagent.agentURL,
        error: subagent.error,
        model: subagent.model,
      });
    }
  }

  return {
    kind: "subagent_group",
    id: `subagent-group-${Date.now().toString(36)}`,
    agents,
  };
}
