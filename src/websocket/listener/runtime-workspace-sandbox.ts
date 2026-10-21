import type { RuntimeWorkspaceSandbox } from "@/runtime-context";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export function assertRuntimeWorkspaceSandboxChangeAllowed(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
  next: RuntimeWorkspaceSandbox | undefined,
): void {
  const current = runtime.workspaceSandbox;
  const changed =
    current?.root !== next?.root ||
    current?.isolationRoot !== next?.isolationRoot;
  if (changed && listener.connectionIdsByRuntimeKey.has(runtime.key)) {
    throw new Error(
      "runtime_start cannot change the workspace sandbox for an active runtime",
    );
  }
}
