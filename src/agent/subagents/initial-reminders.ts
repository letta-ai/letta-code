import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";

export function buildDeploySystemReminder(
  senderAgentName: string,
  senderAgentId: string,
): string {
  return `${SYSTEM_REMINDER_OPEN}
This task is from "${senderAgentName}" (agent ID: ${senderAgentId}), which deployed you as a subagent inside the Letta Code CLI (docs.letta.com/letta-code).
You have access to local tools (Bash, Read, Write, Edit, etc.) in their codebase.
Your final message will be returned to the caller.
${SYSTEM_REMINDER_CLOSE}

`;
}

export function buildForkSystemReminder(
  subagentType: string | undefined,
  recallPrompt: string,
): string {
  if (subagentType === "recall") {
    return `${SYSTEM_REMINDER_OPEN}
You have been forked from the primary conversational thread to run as an independent subagent. The fork only exists so you can see the parent agent's conversation trajectory in-context as reference — you are NOT the primary agent and do not share its tools.

**Your sole task is now to search previous conversation history and provide a report. Ignore any existing ongoing tasks.** Do not attempt to continue, finish, or act on anything the primary agent was in the middle of doing.

Your toolset is limited to Bash, Read, and TaskOutput. You cannot edit files, run skills, dispatch further tasks, or take any action beyond searching messages and returning a report.

You CANNOT ask questions mid-execution — all instructions are provided upfront.
Your final message will be returned to the caller.

${recallPrompt}
${SYSTEM_REMINDER_CLOSE}

`;
  }
  return `${SYSTEM_REMINDER_OPEN}
You have been forked from the primary conversational thread to run as an independent subagent. The fork only exists so you can see the parent agent's conversation trajectory in-context as reference — you are NOT the primary agent.

**Your sole task is the one described in the user message below. Ignore any existing ongoing tasks from the inherited trajectory.** Do not attempt to continue, finish, or act on anything the primary agent was in the middle of doing.

You inherit the primary agent's toolset.

You CANNOT ask questions mid-execution — all instructions are provided upfront.
Your final message will be returned to the caller.
${SYSTEM_REMINDER_CLOSE}

`;
}
