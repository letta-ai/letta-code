import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { ModAdapter } from "@/mods/mod-adapter";
import type { ModContext } from "@/mods/types";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import type { ToolsetPreference } from "@/tools/toolset-types";

export async function prepareHeadlessToolExecutionContext(params: {
  agentId: string;
  conversationId: string;
  overrideModel?: string | null;
  toolsetPreference?: ToolsetPreference;
  cachedAgent?: AgentState | null;
  modContext?: ModContext;
  modEvents?: ModAdapter["events"];
}): Promise<{
  preparedToolContext: Awaited<
    ReturnType<typeof prepareToolExecutionContextForScope>
  >;
  availableTools: string[];
}> {
  const preparedToolContext = await prepareToolExecutionContextForScope({
    agentId: params.agentId,
    conversationId: params.conversationId,
    overrideModel: params.overrideModel,
    clientToolset: params.toolsetPreference
      ? { base: params.toolsetPreference }
      : undefined,
    workingDirectory: getCurrentWorkingDirectory(),
    cachedAgent: params.cachedAgent,
    modContext: params.modContext,
    modEvents: params.modEvents,
  });

  return {
    preparedToolContext,
    availableTools: preparedToolContext.preparedToolContext.clientTools.map(
      (tool) => tool.name,
    ),
  };
}
