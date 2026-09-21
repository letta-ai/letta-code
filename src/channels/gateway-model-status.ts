import type {
  RuntimeScope,
  RuntimeStartResponseMessage,
} from "@/types/app-server-protocol";

export interface ChannelGatewayModelStatus {
  modelHandle: string | null;
  scope: "agent" | "conversation";
}

export function resolveGatewayModelStatus(
  runtime: RuntimeScope,
  response: RuntimeStartResponseMessage,
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
  return {
    modelHandle:
      runtime.conversation_id === "default"
        ? agentModel
        : (conversationModel ?? agentModel),
    scope: runtime.conversation_id === "default" ? "agent" : "conversation",
  };
}
