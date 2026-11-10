import { readSubagentEvents } from "@/agent/subagent-events";
import { getSubagents } from "@/agent/subagent-state";
import type {
  ReadSubagentEventsCommand,
  ReadSubagentEventsResponse,
} from "@/types/subagent-protocol";

/**
 * Serve a caller-notified subagent's events to the parent that launched it,
 * oldest first, one page at a time.
 */
export function handleReadSubagentEventsCommand(
  command: ReadSubagentEventsCommand,
): ReadSubagentEventsResponse {
  const base = {
    type: "read_subagent_events_response" as const,
    request_id: command.request_id,
    runtime: command.runtime,
    subagent_id: command.subagent_id,
  };
  const subagent = getSubagents().find(
    (entry) => entry.id === command.subagent_id,
  );
  if (
    !subagent ||
    subagent.parentAgentId !== command.runtime.agent_id ||
    (subagent.parentConversationId ?? "default") !==
      command.runtime.conversation_id
  )
    return {
      ...base,
      success: false,
      error: "Subagent does not belong to this conversation",
    };
  const page = readSubagentEvents(
    command.subagent_id,
    command.after_seq,
    command.max_bytes,
  );
  if (!page)
    return {
      ...base,
      success: false,
      error: "This subagent's events are not kept on this computer",
    };
  return { ...base, success: true, ...page };
}
