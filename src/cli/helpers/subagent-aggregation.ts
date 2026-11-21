import {
  getSubagentByToolCallId,
  getSubagents,
  getSubagentToolCount,
} from "@/agent/subagent-state";
import type { StaticSubagent } from "@/cli/components/SubagentGroupStatic.js";
import type { Line } from "./accumulator.js";
import { isTaskTool } from "./tool-name-mapping.js";

export interface TaskToolCallInfo {
  lineId: string;
  toolCallId: string;
}

export interface SubagentGroupItem {
  kind: "subagent_group";
  id: string;
  agents: StaticSubagent[];
}

export function hasInProgressTaskToolCalls(
  order: string[],
  byId: Map<string, Line>,
  _emittedIds: Set<string>,
): boolean {
  // If any foreground subagent is running, treat Task tools as in-progress.
  // Background subagents shouldn't block grouping into the static area.
  const hasForegroundRunning = getSubagents().some(
    (agent) =>
      !agent.isBackground &&
      (agent.status === "pending" || agent.status === "running"),
  );
  if (hasForegroundRunning) {
    return true;
  }

  for (const id of order) {
    const ln = byId.get(id);
    if (!ln) continue;
    if (ln.kind === "tool_call" && isTaskTool(ln.name ?? "")) {
      if (ln.phase !== "finished") {
        return true;
      }
      if (ln.toolCallId) {
        const subagent = getSubagentByToolCallId(ln.toolCallId);
        if (subagent) {
          if (
            !subagent.isBackground &&
            (subagent.status === "pending" || subagent.status === "running")
          ) {
            return true;
          }
        }
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
      const subagent = getSubagentByToolCallId(ln.toolCallId);
      if (
        subagent &&
        (subagent.status === "completed" ||
          subagent.status === "error" ||
          (subagent.isBackground &&
            (subagent.status === "pending" || subagent.status === "running")))
      ) {
        finished.push({
          lineId: id,
          toolCallId: ln.toolCallId,
        });
      }
    }
  }

  return finished;
}

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
        status:
          subagent.isBackground &&
          (subagent.status === "pending" || subagent.status === "running")
            ? "running"
            : (subagent.status as "completed" | "error"),
        toolCount: getSubagentToolCount(subagent),
        totalTokens: subagent.totalTokens,
        agentURL: subagent.agentURL,
        error: subagent.error,
        model: subagent.model,
        isBackground: subagent.isBackground,
      });
    }
  }

  return {
    kind: "subagent_group",
    id: `subagent-group-${Date.now().toString(36)}`,
    agents,
  };
}
