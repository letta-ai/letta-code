import {
  type AppServerCliOptions,
  printAppServerListening,
} from "@/cli/subcommands/app-server";
import { createRuntimeBoundGatewayStarter } from "@/cli/subcommands/listener-readiness";
import type { AppServerHandle } from "@/websocket/app-server";
import type { RemoteSessionLog } from "@/websocket/listen-log";

export interface ListenerAppServer {
  /** Start (or keep) the App Server on the active listener runtime. */
  start: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Serve App Server clients from a registered computer's listener runtime.
 * Clients and Cloud-delivered turns then share one runtime, so tools a client
 * registers for a conversation apply when Cloud routes that conversation here.
 */
export function createListenerAppServer(
  options: AppServerCliOptions | undefined,
  connectionName: string,
  log: Pick<RemoteSessionLog, "log">,
): ListenerAppServer | null {
  if (!options) return null;
  let handle: AppServerHandle | null = null;
  const close = async (): Promise<void> => {
    const current = handle;
    handle = null;
    await current?.close();
  };
  let startOnRuntime: (() => Promise<void>) | null = null;
  const start = async (): Promise<void> => {
    if (!startOnRuntime) {
      const { getActiveRuntime } = await import("@/websocket/listener/runtime");
      startOnRuntime = createRuntimeBoundGatewayStarter({
        getRuntime: getActiveRuntime,
        close,
        start: async (runtime) => {
          const { startAppServer } = await import("@/websocket/app-server");
          handle = await startAppServer({
            runtime,
            listen: options.listen,
            websocketAuth: options.websocketAuth,
            openaiApi: options.openaiApi,
            connectionName,
            // The registered listener already owns process services.
            startProcessServices: false,
            onListening: (info) =>
              printAppServerListening(info, options.openaiApi),
            onLog: (message) => log.log(`[AppServer] ${message}`),
          });
        },
      });
    }
    return startOnRuntime();
  };
  return { start, close };
}
