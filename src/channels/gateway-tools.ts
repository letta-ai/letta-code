import type {
  ExternalToolDefinitionPayload,
  RuntimeScope,
} from "@/types/app-server-protocol";
import { buildDynamicMessageChannelToolDefinition } from "./message-tool";
import type { ChannelTurnSource } from "./types";

type ChannelRuntimeSourceResolver = {
  resolveTurnSourcesForScope(
    agentId: string,
    conversationId: string,
  ): ChannelTurnSource[];
};

export async function buildChannelGatewayExternalTools(
  registry: ChannelRuntimeSourceResolver,
  runtime: RuntimeScope,
  baseTool: { description: string; schema: Record<string, unknown> },
): Promise<ExternalToolDefinitionPayload[]> {
  const sources = registry.resolveTurnSourcesForScope(
    runtime.agent_id,
    runtime.conversation_id,
  );
  const seen = new Set<string>();
  const channels = sources
    .map((source) => ({
      channelId: source.channel,
      accountId: source.accountId ?? null,
    }))
    .filter(({ channelId, accountId }) => {
      const key = `${channelId}:${accountId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (channels.length === 0) return [];

  const resolved = await buildDynamicMessageChannelToolDefinition(
    baseTool.description,
    baseTool.schema,
    { channels },
  );
  return [
    {
      name: "MessageChannel",
      label: "Message Channel",
      description: resolved.description,
      parameters: resolved.schema,
    },
  ];
}
