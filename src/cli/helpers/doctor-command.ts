import { detectMemoryFormat } from "@/agent/memory-format";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { getTranscriptRoot } from "@/utils/transcript-paths";

/** Start a normal primary-agent investigation in the current conversation. */
export function buildDoctorMessage(options: {
  agentId: string;
  conversationId: string | null;
  memoryDir?: string;
  local: boolean;
  symptom?: string;
}): string {
  const { agentId, conversationId, memoryDir, local, symptom } = options;
  return `${SYSTEM_REMINDER_OPEN}
The user invoked /doctor. You are the primary investigator in this conversation.
Use the Skill tool with skill: "context-doctor" to load the investigation workflow.
Conduct the investigation here using your normal tools, approvals, and conversation history. Return your findings directly in this conversation.

## Investigation environment

Current agent ID: ${agentId}
Investigation conversation ID: ${conversationId ?? "(new conversation)"}
Backend: ${local ? "local" : "api"}
Current agent memory format: ${memoryDir ? detectMemoryFormat(memoryDir, local) : "none"}
${memoryDir ? `Current agent memory directory: ${memoryDir}` : "The current agent has no memory filesystem."}
Host-local client transcript root: ${getTranscriptRoot()}

## Investigation scope

Follow the skill's workflow for an incident investigation, memory audit, or general health check according to the user's request.
The investigation conversation above is not automatically the target conversation; the user may have opened it just to run doctor. Unless the user identifies another agent, investigate the current agent.
${SYSTEM_REMINDER_CLOSE}

User symptom: ${symptom?.trim() || "Perform a bounded memory health check and review recent history across conversations for recurring corrections, failures, and context problems."}`;
}
