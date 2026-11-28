import {
  getSubagentByToolCallId,
  getSubagents,
  getSubagentToolCount,
  type SubagentState,
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
  subagents: readonly SubagentState[],
): SubagentGroupItem {
  const agents: StaticSubagent[] = [];
  for (const subagent of subagents) {
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

  return {
    kind: "subagent_group",
    id: `subagent-group-${agents.map((agent) => agent.id).join(":")}`,
    agents,
  };
}
