import type {
  RuntimeScope,
  RuntimeStartResponseMessage,
} from "@/types/app-server-protocol";
import type {
  ChannelGatewayHooks,
  ChannelGatewayModelStatus,
} from "./gateway-types";
import type { ChannelTurnSource } from "./types";

export async function prepareGatewayRegistrationPolicy(options: {
  hooks: ChannelGatewayHooks;
  runtime: RuntimeScope;
  sources: ChannelTurnSource[];
  override?: boolean;
}): Promise<{
  automaticRelay: boolean;
  tool: Awaited<ReturnType<ChannelGatewayHooks["buildExternalTool"]>>;
}> {
  const automaticRelay =
    options.override ??
    (options.hooks.resolveAssistantRelayPolicy
      ? await options.hooks.resolveAssistantRelayPolicy(
          options.runtime,
          options.sources,
        )
      : Boolean(options.hooks.relayAssistantText));
  const tool = await options.hooks.buildExternalTool(
    options.runtime,
    options.sources,
    { automaticRelay },
  );
  return { automaticRelay, tool };
}

export function modelStatusFromRuntimeStart(
  response: RuntimeStartResponseMessage,
  runtime: RuntimeScope,
): ChannelGatewayModelStatus {
  const agent = response.agent as unknown as Record<string, unknown> | null;
  const conversation = response.conversation as unknown as Record<
    string,
    unknown
  > | null;
  const agentModel =
    typeof agent?.model === "string"
      ? agent.model
      : (response.agent?.llm_config?.model ?? null);
  const conversationModel =
    typeof conversation?.model === "string" ? conversation.model : null;
  const isAgentScope = runtime.conversation_id === "default";
  return {
    modelHandle: isAgentScope ? agentModel : (conversationModel ?? agentModel),
    scope: isAgentScope ? "agent" : "conversation",
  };
}
