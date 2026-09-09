import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getDelegatedGithubWriteCapability } from "@/github-write-authority";
import type { ModAdapter } from "@/mods/mod-adapter";
import type { ModContext } from "@/mods/types";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { INTERACTIVE_USER_INPUT_TOOL_NAMES } from "@/tools/interactive-policy";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";

export async function prepareHeadlessToolExecutionContext(params: {
  agentId: string;
  conversationId: string;
  overrideModel?: string | null;
  cachedAgent?: AgentState | null;
  modContext?: ModContext;
  modEvents?: ModAdapter["events"];
}) {
  const preparedToolContext = await prepareToolExecutionContextForScope({
    ...params,
    githubWriteCapability: getDelegatedGithubWriteCapability(),
    workingDirectory: getCurrentWorkingDirectory(),
    exclude: [...INTERACTIVE_USER_INPUT_TOOL_NAMES],
  });
  return {
    preparedToolContext,
    availableTools: preparedToolContext.preparedToolContext.clientTools.map(
      (tool) => tool.name,
    ),
  };
}
