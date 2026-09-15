import { buildAgentSendReminder } from "@/backend/api/agent-message";

/** Capture launch attribution before headless startup installs the child's scope. */
export function buildHeadlessSenderReminder(
  isAgentLaunch: boolean,
  fromAgentId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return buildAgentSendReminder(
    isAgentLaunch
      ? {
          agentId: env.LETTA_PARENT_AGENT_ID,
          conversationId: env.LETTA_PARENT_CONVERSATION_ID,
        }
      : { agentId: fromAgentId },
    false,
  );
}
