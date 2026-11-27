import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import WebSocket from "ws";
import { permissionMode } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import { startAppServer } from "@/websocket/app-server";
import {
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import {
  deriveListenerInstanceId,
  registerWithCloud,
} from "@/websocket/listen-register";
import { resolveListenerRegistrationOptions } from "@/websocket/listener/auth";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import type { ListenerClientReplacement } from "@/websocket/listener/types";
import { TerminalSession } from "./terminal-session";

export async function openEmbeddedTerminal(
  agentId: string,
  conversationId: string,
  cloud: boolean,
  signal: AbortSignal,
  reportCloud: (error?: string) => void,
) {
  const connectionName = `${hostname()} (terminal ${process.pid})`;
  let runtime = getActiveRuntime();
  let ownsListener = false;
  const stopListener = () => {
    if (ownsListener && runtime && getActiveRuntime() === runtime)
      stopListenerClient();
  };
  if (cloud && !runtime) {
    try {
      const deviceId = settingsManager.getOrCreateDeviceId();
      const connectCloud = async (
        replacement?: ListenerClientReplacement,
      ): Promise<void> => {
        const options = await resolveListenerRegistrationOptions(
          deviceId,
          connectionName,
          { allowInteractiveOAuth: false, surface: "listen" },
        );
        signal.throwIfAborted();
        const registration = await registerWithCloud({
          ...options,
          listenerInstanceId: deriveListenerInstanceId(
            "listen",
            connectionName,
          ),
        });
        signal.throwIfAborted();
        const starting = startListenerClient({
          ...registration,
          replacement,
          keepRuntimeOnDisconnect: true,
          deviceId,
          connectionName,
          onConnected: () => reportCloud(),
          onDisconnected: () => reportCloud("Disconnected"),
          onError: (error) => reportCloud(error.message),
          onNeedsReregister: (next) => {
            if (signal.aborted || !next) return;
            void connectCloud(next).catch((error) => {
              if (!signal.aborted) reportCloud(String(error));
            });
          },
        });
        runtime = getActiveRuntime();
        ownsListener = true;
        await starting;
      };
      signal.addEventListener("abort", stopListener, { once: true });
      try {
        await connectCloud();
      } finally {
        signal.removeEventListener("abort", stopListener);
      }
    } catch (error) {
      stopListener();
      runtime = null;
      ownsListener = false;
      if (!signal.aborted)
        reportCloud(error instanceof Error ? error.message : String(error));
    }
  }
  signal.throwIfAborted();
  const token = randomBytes(32).toString("hex");
  const handle = await startAppServer({
    listen: "ws://127.0.0.1:0",
    runtime: runtime ?? undefined,
    startProcessServices: !runtime,
    websocketAuth: {
      config: {
        mode: "capability-token",
        source: {
          type: "token-sha256",
          tokenSha256: createHash("sha256").update(token).digest(),
        },
      },
    },
  }).catch((error) => {
    stopListener();
    throw error;
  });
  const client = new LettaAgentClient({
    backend: "remote",
    url: handle.controlUrl,
    authToken: token,
    WebSocket,
  });
  const store = new TerminalSession((canUseTool) =>
    client.resumeSession(
      conversationId === "default" ? agentId : conversationId,
      {
        canUseTool,
        permissionMode: permissionMode.getMode(),
        cwd: process.cwd(),
      },
    ),
  );
  return {
    store,

    async close() {
      store.close();
      try {
        await client.close();
      } finally {
        try {
          await handle.close();
        } finally {
          stopListener();
        }
      }
    },
  };
}
