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
import type { ListenerRuntime } from "@/websocket/listener/types";

const MAX_OPERATION_TIMEOUT_MS = 285_000;
const HANDOFF_SUBMISSION_MARGIN_MS = 5_000;
const MINIMUM_OPERATION_BUDGET_MS =
  BROWSER_DEVICE_HANDOFF_SUBMIT_TIMEOUT_MS + HANDOFF_SUBMISSION_MARGIN_MS + 1;
const COMPLETED_OPERATION_RETENTION_MS = 60_000;

interface OperationRecord {
  controller: AbortController;
  flightKey: string;
  requestDigest: string;
  expiresAtMonotonicMs: number;
  dependencies: BrowserDeviceMcpOAuthCommandDependencies;
  owner: ListenerRuntime;
  lineageId: string;
  response?: BrowserDeviceMcpOAuthResponseMessage;
  lastAttemptedSocket: WebSocket | null;
  disposed: boolean;
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
  owner: ListenerRuntime;
  /** Stable across physical WebSocket replacements, unlike connection IDs. */
  lineageId: string;
  monotonicNow?: () => number;
}

const operations = new Map<string, OperationRecord>();
const activeFlights = new Map<string, string>();

export function handleBrowserDeviceMcpOAuthProtocolCommand(
  command: WsProtocolCommand,
  dependencies: BrowserDeviceMcpOAuthCommandDependencies,
): boolean {
  const receivedAtMonotonicMs =
    dependencies.monotonicNow?.() ?? performance.now();
  pruneCompletedOperations(receivedAtMonotonicMs);

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
    if (
      existing.owner !== dependencies.owner ||
      existing.requestDigest !== requestDigest(command)
    ) {
      sendTerminalResponse(command.request_id, "invalid_request", dependencies);
      return true;
    }
    existing.dependencies = dependencies;
    deliverTerminal(existing);
    return true;
  }

  dependencies.runDetachedListenerTask("browser_device_mcp_oauth", async () => {
    await runBrowserDeviceMcpOAuth(
      command,
      dependencies,
      key,
      receivedAtMonotonicMs,
    );
  });
  return true;
}

async function runBrowserDeviceMcpOAuth(
  command: BrowserDeviceMcpOAuthCommand,
  dependencies: BrowserDeviceMcpOAuthCommandDependencies,
  operationMapKey: string,
  receivedAtMonotonicMs: number,
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

  const elapsedMs = Math.max(
    0,
    Math.ceil(
      (dependencies.monotonicNow?.() ?? performance.now()) -
        receivedAtMonotonicMs,
    ),
  );
  const remainingMs = command.timeout_ms - elapsedMs;
  if (
    command.timeout_ms > MAX_OPERATION_TIMEOUT_MS ||
    remainingMs < MINIMUM_OPERATION_BUDGET_MS
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
    expiresAtMonotonicMs: receivedAtMonotonicMs + command.timeout_ms,
    dependencies,
    owner: dependencies.owner,
    lineageId: dependencies.lineageId,
    lastAttemptedSocket: null,
    disposed: false,
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

  if (operation.disposed) return;
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
    .update(String(command.timeout_ms))
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
  if (!operation.response || operation.disposed) return;
  const socket = operation.dependencies.socket;
  if (operation.lastAttemptedSocket === socket) return;
  operation.lastAttemptedSocket = socket;
  const sent = operation.dependencies.safeSocketSend(
    socket,
    operation.response,
    "browser_device_mcp_oauth_response_failed",
    "browser_device_mcp_oauth",
  );
  if (!sent && operation.lastAttemptedSocket === socket) {
    operation.lastAttemptedSocket = null;
  }
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

function pruneCompletedOperations(monotonicNowMs: number): void {
  for (const [key, operation] of operations) {
    if (
      operation.response &&
      monotonicNowMs >
        operation.expiresAtMonotonicMs + COMPLETED_OPERATION_RETENTION_MS
    ) {
      operations.delete(key);
    }
  }
}

export function rebindBrowserDeviceMcpOAuthOperationsToSocket(
  runtime: ListenerRuntime,
  lineageId: string,
  socket: WebSocket,
): void {
  for (const operation of operations.values()) {
    if (
      operation.owner !== runtime ||
      operation.lineageId !== lineageId ||
      operation.disposed
    ) {
      continue;
    }
    operation.dependencies = { ...operation.dependencies, socket };
    deliverTerminal(operation);
  }
}

export function disposeBrowserDeviceMcpOAuthOperationsForRuntime(
  runtime: ListenerRuntime,
): void {
  for (const [key, operation] of operations) {
    if (operation.owner !== runtime) continue;
    operation.disposed = true;
    operations.delete(key);
    if (activeFlights.get(operation.flightKey) === key) {
      activeFlights.delete(operation.flightKey);
    }
    operation.controller.abort(
      new DOMException("Listener runtime stopped", "AbortError"),
    );
  }
}

export function resetBrowserDeviceMcpOAuthOperationsForTests(): void {
  for (const operation of operations.values()) {
    operation.disposed = true;
    operation.controller.abort();
  }
  operations.clear();
  activeFlights.clear();
}
