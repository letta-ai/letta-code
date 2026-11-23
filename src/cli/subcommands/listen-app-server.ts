import {
  type AppServerCliOptions,
  printAppServerListening,
} from "@/cli/subcommands/app-server";
import { createRuntimeBoundGatewayStarter } from "@/cli/subcommands/listener-readiness";
import type { AppServerHandle } from "@/websocket/app-server";
import type { RemoteSessionLog } from "@/websocket/listen-log";

export interface ListenerAppServer {
  start: () => Promise<void>;
  close: () => Promise<void>;
}

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
