import type WebSocket from "ws";
import { isSecretApplyCommand, isSecretListCommand } from "../protocol-inbound";
import { invalidateSecretsCacheForAgent } from "../secrets-sync";
import type { ListenerRuntime } from "../types";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

type SecretsCommandContext = {
  socket: WebSocket;
  runtime: ListenerRuntime;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

export function handleSecretsCommand(
  parsed: unknown,
  context: SecretsCommandContext,
): boolean {
  const { socket, runtime, safeSocketSend, runDetachedListenerTask } = context;

  if (isSecretListCommand(parsed)) {
    runDetachedListenerTask("secret_list", async () => {
      try {
        const { refreshAndListSecrets } = await import(
          "../../../utils/secretsStore"
        );
        const secrets = await refreshAndListSecrets(parsed.agent_id);
        safeSocketSend(
          socket,
          {
            type: "secret_list_response",
            request_id: parsed.request_id,
            success: true,
            secrets,
          },
          "listener_secret_list_send_failed",
          "listener_secret_list",
        );
      } catch (error) {
        safeSocketSend(
          socket,
          {
            type: "secret_list_response",
            request_id: parsed.request_id,
            success: false,
            secrets: [],
            error:
              error instanceof Error ? error.message : "Failed to list secrets",
          },
          "listener_secret_list_send_failed",
          "listener_secret_list",
        );
      }
    });
    return true;
  }

  if (isSecretApplyCommand(parsed)) {
    runDetachedListenerTask("secret_apply", async () => {
      for (const key of Object.keys(parsed.set)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key.toUpperCase())) {
          safeSocketSend(
            socket,
            {
              type: "secret_apply_response",
              request_id: parsed.request_id,
              success: false,
              names: [],
              error: `Invalid secret name '${key}'. Use uppercase letters, numbers, and underscores only.`,
            },
            "listener_secret_apply_send_failed",
            "listener_secret_apply",
          );
          return;
        }
      }

      try {
        const { applySecretBatch } = await import(
          "../../../utils/secretsStore"
        );
        const names = await applySecretBatch(
          { set: parsed.set, unset: parsed.unset },
          parsed.agent_id,
        );

        if (parsed.agent_id) {
          invalidateSecretsCacheForAgent(runtime, parsed.agent_id);
        }

        safeSocketSend(
          socket,
          {
            type: "secret_apply_response",
            request_id: parsed.request_id,
            success: true,
            names,
          },
          "listener_secret_apply_send_failed",
          "listener_secret_apply",
        );
      } catch (error) {
        safeSocketSend(
          socket,
          {
            type: "secret_apply_response",
            request_id: parsed.request_id,
            success: false,
            names: [],
            error:
              error instanceof Error
                ? error.message
                : "Failed to apply secrets",
          },
          "listener_secret_apply_send_failed",
          "listener_secret_apply",
        );
      }
    });
    return true;
  }

  return false;
}
