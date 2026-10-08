import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type WebSocket from "ws";
import type { BrowserDeviceMcpOAuthRequest } from "@/browser-device-mcp-oauth";
import type {
  BrowserDeviceMcpOAuthCancelCommand,
  BrowserDeviceMcpOAuthCommand,
  BrowserDeviceMcpOAuthResponseMessage,
} from "@/types/task-control-protocol";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  suspendListenerConnection,
} from "@/websocket/listener/connection";
import { createRuntime, stopRuntime } from "@/websocket/listener/lifecycle";
import { SUPPORTED_REMOTE_COMMANDS } from "@/websocket/listener/listener-constants";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";
import type {
  ListenerRuntime,
  StartListenerOptions,
} from "@/websocket/listener/types";
import {
  handleBrowserDeviceMcpOAuthProtocolCommand,
  rebindBrowserDeviceMcpOAuthOperationsToSocket,
  resetBrowserDeviceMcpOAuthOperationsForTests,
} from "./browser-device-mcp-oauth";

const VALID_HANDOFF_KEY = "h".repeat(43);
const MONOTONIC_NOW_MS = 1_000;

function startCommand(
  overrides: Partial<BrowserDeviceMcpOAuthCommand> = {},
): BrowserDeviceMcpOAuthCommand {
  return {
    type: "browser_device_mcp_oauth",
    request_id: "operation-1",
    handoff_key: VALID_HANDOFF_KEY,
    service: "datadog",
    server_url: "https://mcp.datadoghq.com/v1/mcp",
    timeout_ms: 285_000,
    ...overrides,
  };
}

function createTestSocket(): WebSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send() {},
    removeAllListeners() {},
    close() {},
  } as unknown as WebSocket;
}

function createHarness(
  connect: (
    request: BrowserDeviceMcpOAuthRequest,
    dependencies: undefined,
    signal: AbortSignal,
    authorizationTimeoutMs: number,
  ) => Promise<void>,
  owner: ListenerRuntime = {} as ListenerRuntime,
) {
  const responses: BrowserDeviceMcpOAuthResponseMessage[] = [];
  const tasks: Promise<void>[] = [];
  const socket = {} as WebSocket;
  return {
    dependencies: {
      connect,
      socket,
      owner,
      lineageId: "listener-lineage-1",
      monotonicNow: () => MONOTONIC_NOW_MS,
      runDetachedListenerTask: (
        _commandName: string,
        task: () => Promise<void>,
      ) => {
        tasks.push(task());
      },
      safeSocketSend: (
        _socket: WebSocket,
        payload: unknown,
        _errorType: string,
        _context: string,
      ) => {
        responses.push(payload as BrowserDeviceMcpOAuthResponseMessage);
        return true;
      },
    },
    responses,
    tasks,
  };
}

afterEach(() => {
  resetBrowserDeviceMcpOAuthOperationsForTests();
});

describe("browser-device MCP OAuth protocol parsing", () => {
  test("strictly accepts the bounded start and cancel shapes", () => {
    expect(
      parseServerMessage(Buffer.from(JSON.stringify(startCommand()))),
    ).toEqual(startCommand());
    const cancel: BrowserDeviceMcpOAuthCancelCommand = {
      type: "browser_device_mcp_oauth_cancel",
      operation_id: "operation-1",
    };
    expect(parseServerMessage(Buffer.from(JSON.stringify(cancel)))).toEqual(
      cancel,
    );
  });

  test.each([
    { ...startCommand(), extra: true },
    startCommand({ request_id: "x".repeat(129) }),
    startCommand({ handoff_key: "short" }),
    startCommand({ service: "UPPERCASE" }),
    startCommand({ server_url: `https://example.com/${"x".repeat(2048)}` }),
    startCommand({ server_url: "https://example.com/\nsecret" }),
    startCommand({ timeout_ms: 1.5 }),
    startCommand({ timeout_ms: -1 }),
    startCommand({ timeout_ms: 285_001 }),
    {
      type: "browser_device_mcp_oauth_cancel",
      operation_id: "operation-1",
      extra: true,
    },
  ])("rejects malformed or oversized fields %#", (command) => {
    expect(parseServerMessage(Buffer.from(JSON.stringify(command)))).toBeNull();
  });
});

describe("browser-device MCP OAuth command handling", () => {
  test("runs outside an agent turn and emits one credential-free success", async () => {
    const requests: BrowserDeviceMcpOAuthRequest[] = [];
    const harness = createHarness(async (request) => {
      requests.push(request);
    });

    expect(
      handleBrowserDeviceMcpOAuthProtocolCommand(
        startCommand(),
        harness.dependencies,
      ),
    ).toBe(true);
    await Promise.all(harness.tasks);

    expect(requests).toEqual([
      {
        handoffKey: VALID_HANDOFF_KEY,
        service: "datadog",
        serverUrl: "https://mcp.datadoghq.com/v1/mcp",
      },
    ]);
    expect(harness.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: true,
      },
    ]);
  });

  test("re-registered lineage survives physical reconnect without replaying start", async () => {
    const owner = createRuntime();
    const options: StartListenerOptions = {
      connectionId: "new-connection-id",
      connectionIdCanResume: true,
      wsUrl: "wss://example.test/listener",
      deviceId: "device-test",
      connectionName: "computer-test",
      replacement: {
        deviceId: "device-test",
        connectionName: "computer-test",
        lineageId: "old-connection-id",
        generation: 1,
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    const oldSocket = createTestSocket();
    const replacementSocket = createTestSocket();
    const firstConnection = openListenerConnection({
      runtime: owner,
      connectionId: options.connectionId,
      writer: oldSocket,
      options,
    });
    markListenerConnectionInitialized(
      owner,
      options.connectionId,
      firstConnection,
    );

    let finishImport: (() => void) | undefined;
    const oldResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const replacementResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const tasks: Promise<void>[] = [];
    const dependencies = {
      connect: async (): Promise<void> =>
        await new Promise<void>((resolve) => {
          finishImport = resolve;
        }),
      owner,
      lineageId: firstConnection.startupOwner.lineageId,
      monotonicNow: () => MONOTONIC_NOW_MS,
      socket: oldSocket,
      runDetachedListenerTask: (
        _commandName: string,
        task: () => Promise<void>,
      ) => tasks.push(task()),
      safeSocketSend: (_socket: WebSocket, payload: unknown) => {
        const response = payload as BrowserDeviceMcpOAuthResponseMessage;
        if (_socket === replacementSocket) replacementResponses.push(response);
        else oldResponses.push(response);
        return true;
      },
    };
    handleBrowserDeviceMcpOAuthProtocolCommand(startCommand(), dependencies);

    suspendListenerConnection(owner, options.connectionId);
    const replacementConnection = openListenerConnection({
      runtime: owner,
      connectionId: options.connectionId,
      writer: replacementSocket,
      options,
    });
    markListenerConnectionInitialized(
      owner,
      options.connectionId,
      replacementConnection,
    );
    finishImport?.();
    await Promise.all(tasks);

    expect(oldResponses).toEqual([]);
    expect(replacementResponses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: true,
      },
    ]);
    expect(JSON.stringify(replacementResponses)).not.toContain(
      VALID_HANDOFF_KEY,
    );
    stopRuntime(owner, true);
  });

  test("physical reconnect retries a terminal after a successful send-close race", async () => {
    const owner = createRuntime();
    const options: StartListenerOptions = {
      connectionId: "send-close-race",
      connectionIdCanResume: true,
      wsUrl: "wss://example.test/listener",
      deviceId: "device-test",
      connectionName: "computer-test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    const oldSocket = createTestSocket();
    const replacementSocket = createTestSocket();
    const firstConnection = openListenerConnection({
      runtime: owner,
      connectionId: options.connectionId,
      writer: oldSocket,
      options,
    });
    markListenerConnectionInitialized(
      owner,
      options.connectionId,
      firstConnection,
    );
    const oldResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const replacementResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const harness = createHarness(async () => undefined, owner);
    harness.dependencies.socket = oldSocket;
    harness.dependencies.lineageId = firstConnection.startupOwner.lineageId;
    harness.dependencies.safeSocketSend = (socket, payload) => {
      const response = payload as BrowserDeviceMcpOAuthResponseMessage;
      if (socket === replacementSocket) replacementResponses.push(response);
      else oldResponses.push(response);
      return true;
    };
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      harness.dependencies,
    );
    await Promise.all(harness.tasks);
    expect(oldResponses).toHaveLength(1);

    suspendListenerConnection(owner, options.connectionId);
    const replacementConnection = openListenerConnection({
      runtime: owner,
      connectionId: options.connectionId,
      writer: replacementSocket,
      options,
    });
    markListenerConnectionInitialized(
      owner,
      options.connectionId,
      replacementConnection,
    );

    expect(replacementResponses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: true,
      },
    ]);
    stopRuntime(owner, true);
  });

  test("expired completed terminals are pruned before socket rebinding", async () => {
    let monotonicNow = MONOTONIC_NOW_MS;
    const owner = createRuntime();
    const replacementSocket = createTestSocket();
    const replacementResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const harness = createHarness(async () => undefined, owner);
    harness.dependencies.monotonicNow = () => monotonicNow;
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      harness.dependencies,
    );
    await Promise.all(harness.tasks);
    expect(harness.responses).toHaveLength(1);

    monotonicNow += 345_001;
    harness.dependencies.safeSocketSend = (_socket, payload) => {
      replacementResponses.push(
        payload as BrowserDeviceMcpOAuthResponseMessage,
      );
      return true;
    };
    rebindBrowserDeviceMcpOAuthOperationsToSocket(
      owner,
      harness.dependencies.lineageId,
      replacementSocket,
    );
    expect(replacementResponses).toEqual([]);
    stopRuntime(owner, true);
  });

  test("budget expiry disposes a non-cooperative live flight and admits the next request", async () => {
    let monotonicNow = MONOTONIC_NOW_MS;
    let settleExpired: (() => void) | undefined;
    const owner = createRuntime();
    const expired = createHarness(
      async () =>
        await new Promise<void>((resolve) => {
          settleExpired = resolve;
        }),
      owner,
    );
    expired.dependencies.monotonicNow = () => monotonicNow;
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      expired.dependencies,
    );

    monotonicNow += 285_001;
    const successor = createHarness(async () => undefined, owner);
    successor.dependencies.monotonicNow = () => monotonicNow;
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({ request_id: "post-expiry-operation" }),
      successor.dependencies,
    );
    await Promise.all(successor.tasks);
    expect(successor.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "post-expiry-operation",
        success: true,
      },
    ]);

    settleExpired?.();
    await Promise.all(expired.tasks);
    expect(expired.responses).toEqual([]);
    stopRuntime(owner, true);
  });

  test("runtime shutdown aborts stale work, releases its flight, and suppresses its terminal", async () => {
    const staleOwner = createRuntime();
    const stale = createHarness(
      async (_request, _dependencies, signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      staleOwner,
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      stale.dependencies,
    );

    stopRuntime(staleOwner, true);

    const successorOwner = createRuntime();
    const successor = createHarness(async () => undefined, successorOwner);
    successor.dependencies.lineageId = "unrelated-successor-lineage";
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({ request_id: "successor-operation" }),
      successor.dependencies,
    );
    await Promise.all([...stale.tasks, ...successor.tasks]);

    expect(stale.responses).toEqual([]);
    expect(successor.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "successor-operation",
        success: true,
      },
    ]);
    stopRuntime(successorOwner, true);
  });

  test("retired ABA completion cannot release a successor flight with the same identity", async () => {
    let settleRetired: (() => void) | undefined;
    const retiredOwner = createRuntime();
    const retired = createHarness(
      async () =>
        await new Promise<void>((resolve) => {
          settleRetired = resolve;
        }),
      retiredOwner,
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      retired.dependencies,
    );
    stopRuntime(retiredOwner, true);

    const successorOwner = createRuntime();
    const successor = createHarness(
      async (_request, _dependencies, signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      successorOwner,
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      successor.dependencies,
    );

    settleRetired?.();
    await Promise.all(retired.tasks);

    const third = createHarness(async () => undefined, successorOwner);
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({ request_id: "third-operation" }),
      third.dependencies,
    );
    await Promise.all(third.tasks);
    expect(third.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "third-operation",
        success: false,
        error_code: "already_connecting",
      },
    ]);

    handleBrowserDeviceMcpOAuthProtocolCommand(
      {
        type: "browser_device_mcp_oauth_cancel",
        operation_id: "operation-1",
      },
      successor.dependencies,
    );
    await Promise.all(successor.tasks);
    stopRuntime(successorOwner, true);
  });

  test("derives phases from one relative timeout and rejects unsafe budgets", async () => {
    const authorizationBudgets: number[] = [];
    const harness = createHarness(
      async (_request, _dependencies, _signal, authorizationTimeoutMs) => {
        authorizationBudgets.push(authorizationTimeoutMs);
      },
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({ timeout_ms: 200_000 }),
      harness.dependencies,
    );
    await Promise.all(harness.tasks);
    expect(authorizationBudgets).toEqual([105_000]);
    expect(harness.responses[0]?.success).toBe(true);

    const maximum = createHarness(
      async (_request, _dependencies, _signal, authorizationTimeoutMs) => {
        authorizationBudgets.push(authorizationTimeoutMs);
      },
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({ request_id: "maximum-budget" }),
      maximum.dependencies,
    );
    await Promise.all(maximum.tasks);
    expect(authorizationBudgets).toEqual([105_000, 190_000]);

    let monotonicNow = MONOTONIC_NOW_MS;
    const delayedTasks: Array<() => Promise<void>> = [];
    const delayed = createHarness(
      async (_request, _dependencies, _signal, authorizationTimeoutMs) => {
        authorizationBudgets.push(authorizationTimeoutMs);
      },
    );
    delayed.dependencies.monotonicNow = () => monotonicNow;
    delayed.dependencies.runDetachedListenerTask = (_commandName, task) => {
      delayedTasks.push(task);
    };
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({ request_id: "delayed-dispatch", timeout_ms: 200_000 }),
      delayed.dependencies,
    );
    monotonicNow += 10_000;
    await delayedTasks[0]?.();
    expect(authorizationBudgets).toEqual([105_000, 190_000, 95_000]);

    for (const timeout_ms of [0, 95_000, 285_001]) {
      const rejected = createHarness(async () => {
        throw new Error("must not run");
      });
      handleBrowserDeviceMcpOAuthProtocolCommand(
        startCommand({
          request_id: `rejected-${timeout_ms}`,
          timeout_ms,
        }),
        rejected.dependencies,
      );
      await Promise.all(rejected.tasks);
      expect(rejected.responses).toEqual([
        {
          type: "browser_device_mcp_oauth_response",
          request_id: `rejected-${timeout_ms}`,
          success: false,
          error_code: "invalid_request",
        },
      ]);
    }
  });

  test("cancels only the matching operation and retains its terminal for reconnect", async () => {
    let observedSignal: AbortSignal | undefined;
    const owner = createRuntime();
    const oldSocket = createTestSocket();
    const replacementSocket = createTestSocket();
    const oldResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const replacementResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const harness = createHarness(
      async (_request, _dependencies, signal) =>
        await new Promise<void>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      owner,
    );
    harness.dependencies.socket = oldSocket;
    harness.dependencies.safeSocketSend = (socket, payload) => {
      const response = payload as BrowserDeviceMcpOAuthResponseMessage;
      if (socket === replacementSocket) replacementResponses.push(response);
      else oldResponses.push(response);
      return true;
    };
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      harness.dependencies,
    );

    handleBrowserDeviceMcpOAuthProtocolCommand(
      {
        type: "browser_device_mcp_oauth_cancel",
        operation_id: "other-operation",
      },
      harness.dependencies,
    );
    expect(observedSignal?.aborted).toBe(false);

    handleBrowserDeviceMcpOAuthProtocolCommand(
      {
        type: "browser_device_mcp_oauth_cancel",
        operation_id: "operation-1",
      },
      harness.dependencies,
    );
    await Promise.all(harness.tasks);

    expect(observedSignal?.aborted).toBe(true);
    const cancelledResponse: BrowserDeviceMcpOAuthResponseMessage = {
      type: "browser_device_mcp_oauth_response",
      request_id: "operation-1",
      success: false,
      error_code: "cancelled",
    };
    expect(oldResponses).toEqual([cancelledResponse]);

    rebindBrowserDeviceMcpOAuthOperationsToSocket(
      owner,
      harness.dependencies.lineageId,
      replacementSocket,
    );
    expect(replacementResponses).toEqual([cancelledResponse]);
    expect(JSON.stringify(replacementResponses)).not.toContain(
      VALID_HANDOFF_KEY,
    );
    stopRuntime(owner, true);
  });

  test("cancel preserves a success terminal that already won the race", async () => {
    const owner = createRuntime();
    const replacementSocket = createTestSocket();
    const replacementResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const harness = createHarness(async () => undefined, owner);
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      harness.dependencies,
    );
    await Promise.all(harness.tasks);

    handleBrowserDeviceMcpOAuthProtocolCommand(
      {
        type: "browser_device_mcp_oauth_cancel",
        operation_id: "operation-1",
      },
      harness.dependencies,
    );
    harness.dependencies.safeSocketSend = (_socket, payload) => {
      replacementResponses.push(
        payload as BrowserDeviceMcpOAuthResponseMessage,
      );
      return true;
    };
    rebindBrowserDeviceMcpOAuthOperationsToSocket(
      owner,
      harness.dependencies.lineageId,
      replacementSocket,
    );

    expect(replacementResponses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: true,
      },
    ]);
    stopRuntime(owner, true);
  });

  test("prevents simultaneous flights for the same canonical service URL", async () => {
    const harness = createHarness(
      async (_request, _dependencies, signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      harness.dependencies,
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({
        request_id: "operation-2",
        server_url: "https://mcp.datadoghq.com/v1/mcp/",
      }),
      harness.dependencies,
    );
    await harness.tasks[1];

    expect(harness.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-2",
        success: false,
        error_code: "already_connecting",
      },
    ]);

    handleBrowserDeviceMcpOAuthProtocolCommand(
      {
        type: "browser_device_mcp_oauth_cancel",
        operation_id: "operation-1",
      },
      harness.dependencies,
    );
    await harness.tasks[0];

    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({
        request_id: "operation-2",
        server_url: "https://mcp.datadoghq.com/v1/mcp/",
      }),
      harness.dependencies,
    );
    expect(harness.tasks).toHaveLength(2);
    expect(harness.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-2",
        success: false,
        error_code: "already_connecting",
      },
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: false,
        error_code: "cancelled",
      },
    ]);
  });

  test("maps raw failures to a generic terminal code without secret leakage", async () => {
    const harness = createHarness(async () => {
      throw new Error(
        "token=provider-secret authorization_code=raw-code state=oauth-state",
      );
    });
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      harness.dependencies,
    );
    await Promise.all(harness.tasks);

    expect(harness.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: false,
        error_code: "authorization_failed",
      },
    ]);
    const serialized = JSON.stringify(harness.responses);
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("raw-code");
    expect(serialized).not.toContain("oauth-state");
  });

  test("returns invalid_request for a provider outside the reviewed allowlist", async () => {
    const harness = createHarness(async () => {
      throw new Error("must not run");
    });
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({ service: "unknown" }),
      harness.dependencies,
    );
    await Promise.all(harness.tasks);

    const invalidResponse: BrowserDeviceMcpOAuthResponseMessage = {
      type: "browser_device_mcp_oauth_response",
      request_id: "operation-1",
      success: false,
      error_code: "invalid_request",
    };
    expect(harness.responses).toEqual([invalidResponse]);

    const replacementResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    harness.dependencies.safeSocketSend = (_socket, payload) => {
      replacementResponses.push(
        payload as BrowserDeviceMcpOAuthResponseMessage,
      );
      return true;
    };
    rebindBrowserDeviceMcpOAuthOperationsToSocket(
      harness.dependencies.owner,
      harness.dependencies.lineageId,
      createTestSocket(),
    );
    expect(replacementResponses).toEqual([invalidResponse]);
  });
});

test("advertises the selected-device command and starts no fixed HTTP bridge", () => {
  expect(
    SUPPORTED_REMOTE_COMMANDS.filter(
      (command) => command === "browser_device_mcp_oauth",
    ),
  ).toHaveLength(1);
  expect(
    existsSync(
      new URL("../../../browser-discovery-server.ts", import.meta.url),
    ),
  ).toBe(false);
  expect(
    readFileSync(new URL("../../../index.ts", import.meta.url), "utf8"),
  ).not.toContain("startBrowserDiscoveryServer");
  expect(
    readFileSync(
      new URL("../../../cli/subcommands/server.ts", import.meta.url),
      "utf8",
    ),
  ).not.toContain("startBrowserDiscoveryServer");
});
