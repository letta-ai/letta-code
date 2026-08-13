import type { RuntimeScope } from "@/types/app-server-protocol";
import type {
  ServiceCommandRequest,
  ServiceCommandResponse,
} from "@/types/service-protocol";
import { debugWarn } from "@/utils/debug";

type ChannelRuntimeToolRegistrar = {
  serviceCommandHandler:
    | ((request: ServiceCommandRequest) => Promise<ServiceCommandResponse>)
    | null;
};

/**
 * Give the process-owned channel gateway a chance to publish tools for a
 * runtime before the listener snapshots its toolset. This is best-effort so a
 * channel subsystem failure never blocks an otherwise valid device turn.
 */
export async function registerChannelRuntimeToolsForTurn(
  listener: ChannelRuntimeToolRegistrar,
  runtime: RuntimeScope,
): Promise<boolean> {
  const handler = listener.serviceCommandHandler;
  if (!handler) return false;

  try {
    const response = await handler({ kind: "register_runtime", runtime });
    if (response.kind === "runtime_registered") return true;
    debugWarn(
      "listen",
      `ChannelGateway returned an unexpected runtime registration response: ${response.kind}`,
    );
  } catch (error) {
    debugWarn(
      "listen",
      `Failed to register channel tools for ${runtime.agent_id}/${runtime.conversation_id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return false;
}
