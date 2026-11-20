import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { autoBackgroundExternalTool } from "@/tools/external-tool-background";
import {
  EXTERNAL_TOOL_FOREGROUND_INTERRUPTED,
  type ExternalToolDefinition,
} from "@/tools/external-tool-types";

type Options = Parameters<typeof autoBackgroundExternalTool>[3];
type Result = {
  status: "success" | "error";
  toolReturn: MessageCreate["content"];
  cancellation?: "cancelled" | "timeout";
};

export async function autoBackgroundRemoteExternalTool<T extends Result>(
  name: string,
  tool: ExternalToolDefinition | undefined,
  execute: (signal?: AbortSignal) => Promise<T>,
  options: Options,
) {
  if (!tool?.supportsCancellation) {
    return autoBackgroundExternalTool(
      name,
      tool,
      execute(options?.signal),
      options,
    );
  }
  const controller = new AbortController();
  let backgrounded = false;
  const abort = () =>
    controller.abort(
      backgrounded ? undefined : EXTERNAL_TOOL_FOREGROUND_INTERRUPTED,
    );
  if (options?.signal?.aborted) abort();
  else options?.signal?.addEventListener("abort", abort, { once: true });
  const operation = execute(controller.signal).finally(() =>
    options?.signal?.removeEventListener("abort", abort),
  );
  return autoBackgroundExternalTool(name, tool, operation, {
    ...options,
    remoteAbortController: controller,
    onBackground: (outputFile) => {
      backgrounded = true;
      options?.onBackground?.(outputFile);
    },
  });
}
