import { createHash } from "node:crypto";
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
const MINIMUM_OPERATION_BUDGET_MS =
  BROWSER_DEVICE_HANDOFF_SUBMIT_TIMEOUT_MS + HANDOFF_SUBMISSION_MARGIN_MS + 1;
const COMPLETED_OPERATION_RETENTION_MS = 60_000;

interface OperationRecord {
  controller: AbortController;
  flightKey: string;
  requestDigest: string;
  deadlineMs: number;
  dependencies: BrowserDeviceMcpOAuthCommandDependencies;
  response?: BrowserDeviceMcpOAuthResponseMessage;
  delivered: boolean;
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
  /** Stable across physical WebSocket replacements, unlike connection IDs. */
  lineageId: string;
  now?: () => number;
}

const operations = new Map<string, OperationRecord>();
const activeFlights = new Map<string, string>();

export function handleBrowserDeviceMcpOAuthProtocolCommand(
  command: WsProtocolCommand,
  dependencies: BrowserDeviceMcpOAuthCommandDependencies,
): boolean {
  const now = dependencies.now?.() ?? Date.now();
  pruneCompletedOperations(now);

  if (command.type === "browser_device_mcp_oauth_cancel") {
    operations
      .get(operationKey(dependencies.lineageId, command.operation_id))
      ?.controller.abort(
        new DOMException("Browser-device OAuth was cancelled", "AbortError"),
      );
    return true;
  }
  if (command.type !== "browser_device_mcp_oauth") return false;

  const key = operationKey(dependencies.lineageId, command.request_id);
  const existing = operations.get(key);
  if (existing) {
    // Only an exact replay from the same explicit replacement lineage may adopt
    // the successor socket. Retain a digest rather than the bearer handoff.
    if (existing.requestDigest !== requestDigest(command)) {
      sendTerminalResponse(command.request_id, "invalid_request", dependencies);
      return true;
    }
    existing.dependencies = dependencies;
    if (existing.response && !existing.delivered) deliverTerminal(existing);
    return true;
  }

  dependencies.runDetachedListenerTask("browser_device_mcp_oauth", async () => {
    await runBrowserDeviceMcpOAuth(command, dependencies, key);
  });
  return true;
}

async function runBrowserDeviceMcpOAuth(
  command: BrowserDeviceMcpOAuthCommand,
  dependencies: BrowserDeviceMcpOAuthCommandDependencies,
  operationMapKey: string,
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

  const remainingMs =
    command.deadline_ms - (dependencies.now?.() ?? Date.now());
  if (
    remainingMs < MINIMUM_OPERATION_BUDGET_MS ||
    remainingMs > OPERATION_TIMEOUT_MS
  ) {
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
  const operation: OperationRecord = {
    controller,
    flightKey,
    requestDigest: requestDigest(command),
    deadlineMs: command.deadline_ms,
    dependencies,
    delivered: false,
  };
  operations.set(operationMapKey, operation);
  activeFlights.set(flightKey, operationMapKey);
  const operationSignal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(remainingMs),
  ]);
  const authorizationTimeoutMs =
    remainingMs -
    BROWSER_DEVICE_HANDOFF_SUBMIT_TIMEOUT_MS -
    HANDOFF_SUBMISSION_MARGIN_MS;
  let errorCode: BrowserDeviceMcpOAuthErrorCode | undefined;
  try {
    await (dependencies.connect ?? connectBrowserDeviceMcpOAuth)(
      request,
      undefined,
      operationSignal,
      authorizationTimeoutMs,
    );
  } catch (error) {
    if (controller.signal.aborted) errorCode = "cancelled";
    else if (error instanceof BrowserDeviceMcpOAuthRequestError) {
      errorCode = "invalid_request";
    } else errorCode = "authorization_failed";
  } finally {
    if (activeFlights.get(flightKey) === operationMapKey) {
      activeFlights.delete(flightKey);
    }
  }

  operation.response = createTerminalResponse(command.request_id, errorCode);
  deliverTerminal(operation);
}

function requestDigest(command: BrowserDeviceMcpOAuthCommand): string {
  return createHash("sha256")
    .update(command.request_id)
    .update("\0")
    .update(command.handoff_key)
    .update("\0")
    .update(command.service)
    .update("\0")
    .update(command.server_url)
    .update("\0")
    .update(String(command.deadline_ms))
    .digest("hex");
}

function operationKey(lineageId: string, requestId: string): string {
  return `${lineageId}\0${requestId}`;
}

function createTerminalResponse(
  requestId: string,
  errorCode: BrowserDeviceMcpOAuthErrorCode | undefined,
): BrowserDeviceMcpOAuthResponseMessage {
  return {
    type: "browser_device_mcp_oauth_response",
    request_id: requestId,
    success: errorCode === undefined,
    ...(errorCode ? { error_code: errorCode } : {}),
  };
}

function deliverTerminal(operation: OperationRecord): void {
  if (!operation.response || operation.delivered) return;
  operation.delivered = operation.dependencies.safeSocketSend(
    operation.dependencies.socket,
    operation.response,
    "browser_device_mcp_oauth_response_failed",
    "browser_device_mcp_oauth",
  );
}

function sendTerminalResponse(
  requestId: string,
  errorCode: BrowserDeviceMcpOAuthErrorCode | undefined,
  dependencies: BrowserDeviceMcpOAuthCommandDependencies,
): void {
  dependencies.safeSocketSend(
    dependencies.socket,
    createTerminalResponse(requestId, errorCode),
    "browser_device_mcp_oauth_response_failed",
    "browser_device_mcp_oauth",
  );
}

function pruneCompletedOperations(now: number): void {
  for (const [key, operation] of operations) {
    if (
      operation.response &&
      now > operation.deadlineMs + COMPLETED_OPERATION_RETENTION_MS
    ) {
      operations.delete(key);
    }
  }
}

export function resetBrowserDeviceMcpOAuthOperationsForTests(): void {
  for (const operation of operations.values()) {
    operation.controller.abort();
  }
  operations.clear();
  activeFlights.clear();
}
