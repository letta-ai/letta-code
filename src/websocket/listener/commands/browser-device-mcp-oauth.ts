import type WebSocket from "ws";
import {
  BROWSER_DEVICE_HANDOFF_SUBMIT_TIMEOUT_MS,
  type BrowserDeviceMcpOAuthRequest,
  BrowserDeviceMcpOAuthRequestError,
  canonicalizeBrowserDeviceMcpOAuthRequest,
  connectBrowserDeviceMcpOAuth,
} from "@/browser-device-mcp-oauth";
import type { WsProtocolCommand } from "@/types/protocol_v2";
import type {
  BrowserDeviceMcpOAuthCommand,
  BrowserDeviceMcpOAuthErrorCode,
  BrowserDeviceMcpOAuthResponseMessage,
} from "@/types/task-control-protocol";

const OPERATION_TIMEOUT_MS = 280_000;
const HANDOFF_SUBMISSION_MARGIN_MS = 5_000;
const AUTHORIZATION_TIMEOUT_MS =
  OPERATION_TIMEOUT_MS -
  BROWSER_DEVICE_HANDOFF_SUBMIT_TIMEOUT_MS -
  HANDOFF_SUBMISSION_MARGIN_MS;

interface ActiveOperation {
  controller: AbortController;
  flightKey: string;
}

interface BrowserDeviceMcpOAuthCommandDependencies {
  connect?: (
    request: BrowserDeviceMcpOAuthRequest,
    dependencies: undefined,
    signal: AbortSignal,
    authorizationTimeoutMs: number,
  ) => Promise<void>;
  runDetachedListenerTask: (
    commandName: string,
    task: () => Promise<void>,
  ) => void;
  safeSocketSend: (
    socket: WebSocket,
    payload: unknown,
    errorType: string,
    context: string,
  ) => boolean;
  socket: WebSocket;
}

const activeOperations = new Map<string, ActiveOperation>();
const activeFlights = new Map<string, string>();

export function handleBrowserDeviceMcpOAuthProtocolCommand(
  command: WsProtocolCommand,
  dependencies: BrowserDeviceMcpOAuthCommandDependencies,
): boolean {
  if (command.type === "browser_device_mcp_oauth_cancel") {
    activeOperations
      .get(command.operation_id)
      ?.controller.abort(
        new DOMException("Browser-device OAuth was cancelled", "AbortError"),
      );
    return true;
  }
  if (command.type !== "browser_device_mcp_oauth") return false;

  // A replay of the same active start is not a second operation and must not
  // create a second terminal result for the same request ID.
  if (activeOperations.has(command.request_id)) return true;

  dependencies.runDetachedListenerTask("browser_device_mcp_oauth", async () => {
    await runBrowserDeviceMcpOAuth(command, dependencies);
  });
  return true;
}

async function runBrowserDeviceMcpOAuth(
  command: BrowserDeviceMcpOAuthCommand,
  dependencies: BrowserDeviceMcpOAuthCommandDependencies,
): Promise<void> {
  let request: BrowserDeviceMcpOAuthRequest;
  try {
    request = canonicalizeBrowserDeviceMcpOAuthRequest({
      handoffKey: command.handoff_key,
      serverUrl: command.server_url,
      service: command.service,
    });
  } catch {
    sendTerminalResponse(command.request_id, "invalid_request", dependencies);
    return;
  }

  const flightKey = `${request.service}\0${request.serverUrl}`;
  if (activeFlights.has(flightKey)) {
    sendTerminalResponse(
      command.request_id,
      "already_connecting",
      dependencies,
    );
    return;
  }

  const controller = new AbortController();
  activeOperations.set(command.request_id, { controller, flightKey });
  activeFlights.set(flightKey, command.request_id);
  const operationSignal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(OPERATION_TIMEOUT_MS),
  ]);
  let errorCode: BrowserDeviceMcpOAuthErrorCode | undefined;
  try {
    await (dependencies.connect ?? connectBrowserDeviceMcpOAuth)(
      request,
      undefined,
      operationSignal,
      AUTHORIZATION_TIMEOUT_MS,
    );
  } catch (error) {
    if (controller.signal.aborted) errorCode = "cancelled";
    else if (error instanceof BrowserDeviceMcpOAuthRequestError) {
      errorCode = "invalid_request";
    } else errorCode = "authorization_failed";
  } finally {
    const active = activeOperations.get(command.request_id);
    if (active?.controller === controller) {
      activeOperations.delete(command.request_id);
      if (activeFlights.get(active.flightKey) === command.request_id) {
        activeFlights.delete(active.flightKey);
      }
    }
  }

  sendTerminalResponse(command.request_id, errorCode, dependencies);
}

function sendTerminalResponse(
  requestId: string,
  errorCode: BrowserDeviceMcpOAuthErrorCode | undefined,
  dependencies: BrowserDeviceMcpOAuthCommandDependencies,
): void {
  const response: BrowserDeviceMcpOAuthResponseMessage = {
    type: "browser_device_mcp_oauth_response",
    request_id: requestId,
    success: errorCode === undefined,
    ...(errorCode ? { error_code: errorCode } : {}),
  };
  dependencies.safeSocketSend(
    dependencies.socket,
    response,
    "browser_device_mcp_oauth_response_failed",
    "browser_device_mcp_oauth",
  );
}

export function resetBrowserDeviceMcpOAuthOperationsForTests(): void {
  for (const operation of activeOperations.values()) {
    operation.controller.abort();
  }
  activeOperations.clear();
  activeFlights.clear();
}
