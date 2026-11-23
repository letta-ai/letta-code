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

export async function publishChannelRuntimeToolsForTurn(
  listener: ChannelRuntimeToolRegistrar,
  runtime: RuntimeScope,
): Promise<boolean> {
  const handler = listener.serviceCommandHandler;
  if (!handler) return false;

  try {
    const response = await handler({ kind: "publish_runtime_tools", runtime });
    if (response.kind === "runtime_tools_published") {
      return response.transient;
    }
    debugWarn(
      "listen",
      `ChannelGateway returned an unexpected tool publication response: ${response.kind}`,
    );
  } catch (error) {
    debugWarn(
      "listen",
      `Failed to publish channel tools for ${runtime.agent_id}/${runtime.conversation_id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return false;
}

export async function releaseChannelRuntimeToolsForTurn(
  listener: ChannelRuntimeToolRegistrar,
  runtime: RuntimeScope,
): Promise<void> {
  const handler = listener.serviceCommandHandler;
  if (!handler) return;

  try {
    const response = await handler({ kind: "release_runtime_tools", runtime });
    if (response.kind === "runtime_tools_released") return;
    debugWarn(
      "listen",
      `ChannelGateway returned an unexpected tool release response: ${response.kind}`,
    );
  } catch (error) {
    debugWarn(
      "listen",
      `Failed to release channel tools for ${runtime.agent_id}/${runtime.conversation_id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
