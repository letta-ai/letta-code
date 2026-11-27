import { hostname } from "node:os";
import { createRuntimeBoundGatewayStarter } from "@/cli/subcommands/listener-readiness";
import { settingsManager } from "@/settings-manager";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import {
  type RegisterResult,
  registerWithCloudRetry,
} from "@/websocket/listen-register";
import { resolveListenerRegistrationOptions } from "@/websocket/listener/auth";
import type { ListenerClientReplacement } from "@/websocket/listener/types";

const LOOPBACK_LISTEN_URL = "ws://127.0.0.1:0";

export interface EmbeddedAppServerOptions {
  registerWithCloud?: boolean;
  connectionName?: string;
  onLog?: (message: string) => void;
  onCloudStatus?: (status: "connected" | "reconnecting" | "offline") => void;
}

export interface EmbeddedAppServer {
  url: string;
  registered: boolean;
  close: () => Promise<void>;
}

async function startStandalone(
  options: EmbeddedAppServerOptions,
): Promise<EmbeddedAppServer> {
  const handle = await startAppServer({
    listen: LOOPBACK_LISTEN_URL,
    connectionName: options.connectionName,
    onLog: options.onLog,
  });
  return {
    url: handle.controlUrl,
    registered: false,
    close: handle.close,
  };
}

async function startRegistered(
  options: EmbeddedAppServerOptions,
): Promise<EmbeddedAppServer> {
  await settingsManager.initialize();
  const deviceId = settingsManager.getOrCreateDeviceId();
  const connectionName = options.connectionName ?? hostname();
  const register = async (): Promise<RegisterResult> => {
    const registerOptions = await resolveListenerRegistrationOptions(
      deviceId,
      connectionName,
      { allowInteractiveOAuth: false },
    );
    return registerWithCloudRetry(registerOptions, {
      onRetry: (attempt, _delayMs, error) => {
        options.onLog?.(`Registration retry ${attempt}: ${error.message}`);
        options.onCloudStatus?.("reconnecting");
      },
    });
  };

  const { startListenerClient, stopListenerClient } = await import(
    "@/websocket/listen-client"
  );
  const { getActiveRuntime } = await import("@/websocket/listener/runtime");

  let handle: AppServerHandle | null = null;
  let listenUrl = LOOPBACK_LISTEN_URL;
  let closed = false;
  const closeHandle = async (): Promise<void> => {
    const current = handle;
    handle = null;
    await current?.close();
  };
  const bindLoopback = createRuntimeBoundGatewayStarter({
    getRuntime: getActiveRuntime,
    close: closeHandle,
    start: async (runtime) => {
      handle = await startAppServer({
        runtime,
        listen: listenUrl,
        connectionName,
        startProcessServices: false,
        onLog: options.onLog,
      });
      listenUrl = handle.url;
    },
  });

  let settleReady: ((error?: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = (error) => {
      settleReady = null;
      if (error) reject(error);
      else resolve();
    };
  });

  const connect = async (
    registration: RegisterResult,
    replacement?: ListenerClientReplacement,
  ): Promise<void> => {
    await startListenerClient({
      replacement,
      connectionId: registration.connectionId,
      wsUrl: registration.wsUrl,
      supportsSplitStatusChannels: registration.supportsSplitStatusChannels,
      supportsPairedListenerGenerations:
        registration.supportsPairedListenerGenerations,
      deviceId,
      connectionName,
      onLog: options.onLog,
      onConnected: () => {},
      onConnectionReady: async () => {
        if (closed) return;
        await bindLoopback();
        options.onCloudStatus?.("connected");
        settleReady?.();
      },
      onRetrying: () => options.onCloudStatus?.("reconnecting"),
      onNeedsReregister: (nextReplacement) => {
        if (closed) return;
        options.onCloudStatus?.("reconnecting");
        void register()
          .then((next) => connect(next, nextReplacement))
          .catch((error: unknown) => {
            options.onLog?.(
              `Re-registration failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            options.onCloudStatus?.("offline");
          });
      },
      onDisconnected: () => {
        options.onCloudStatus?.("offline");
        settleReady?.(new Error("Cloud listener disconnected"));
      },
      onError: (error) => {
        options.onLog?.(`Cloud listener error: ${error.message}`);
        options.onCloudStatus?.("offline");
        settleReady?.(error);
      },
    });
  };

  await connect(await register());
  await ready;
  const bound = handle as AppServerHandle | null;
  if (!bound) throw new Error("Embedded app server did not start");

  return {
    url: bound.controlUrl,
    registered: true,
    close: async () => {
      closed = true;
      await closeHandle();
      stopListenerClient();
    },
  };
}

export function startEmbeddedAppServer(
  options: EmbeddedAppServerOptions = {},
): Promise<EmbeddedAppServer> {
  return options.registerWithCloud
    ? startRegistered(options)
    : startStandalone(options);
}
