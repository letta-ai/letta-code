import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type WebSocket from "ws";
import type { BrowserDeviceMcpOAuthRequest } from "@/browser-device-mcp-oauth";
import type {
  BrowserDeviceMcpOAuthCancelCommand,
  BrowserDeviceMcpOAuthCommand,
  BrowserDeviceMcpOAuthResponseMessage,
} from "@/types/task-control-protocol";
import { SUPPORTED_REMOTE_COMMANDS } from "@/websocket/listener/listener-constants";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";
import {
  handleBrowserDeviceMcpOAuthProtocolCommand,
  resetBrowserDeviceMcpOAuthOperationsForTests,
} from "./browser-device-mcp-oauth";

const VALID_HANDOFF_KEY = "h".repeat(43);
const NOW_MS = 1_800_000_000_000;

function startCommand(
  overrides: Partial<BrowserDeviceMcpOAuthCommand> = {},
): BrowserDeviceMcpOAuthCommand {
  return {
    type: "browser_device_mcp_oauth",
    request_id: "operation-1",
    handoff_key: VALID_HANDOFF_KEY,
    service: "datadog",
    server_url: "https://mcp.datadoghq.com/v1/mcp",
    deadline_ms: NOW_MS + 280_000,
    ...overrides,
  };
}

function createHarness(
  connect: (
    request: BrowserDeviceMcpOAuthRequest,
    dependencies: undefined,
    signal: AbortSignal,
    authorizationTimeoutMs: number,
  ) => Promise<void>,
) {
  const responses: BrowserDeviceMcpOAuthResponseMessage[] = [];
  const tasks: Promise<void>[] = [];
  const socket = {} as WebSocket;
  return {
    dependencies: {
      connect,
      socket,
      lineageId: "listener-lineage-1",
      now: () => NOW_MS,
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
    startCommand({ deadline_ms: 1.5 }),
    startCommand({ deadline_ms: -1 }),
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

  test("transfers an active operation to its replacement connection", async () => {
    let finishImport: (() => void) | undefined;
    const oldResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const replacementResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    const tasks: Promise<void>[] = [];
    const oldSocket = { name: "old" } as unknown as WebSocket;
    const replacementSocket = { name: "replacement" } as unknown as WebSocket;
    const connect = async (): Promise<void> =>
      await new Promise<void>((resolve) => {
        finishImport = resolve;
      });
    const common = {
      connect,
      lineageId: "stable-lineage",
      now: () => NOW_MS,
      runDetachedListenerTask: (
        _commandName: string,
        task: () => Promise<void>,
      ) => tasks.push(task()),
    };
    const oldDependencies = {
      ...common,
      socket: oldSocket,
      safeSocketSend: (
        _socket: WebSocket,
        payload: unknown,
        _errorType: string,
        _context: string,
      ) => {
        oldResponses.push(payload as BrowserDeviceMcpOAuthResponseMessage);
        return true;
      },
    };
    const replacementDependencies = {
      ...common,
      socket: replacementSocket,
      safeSocketSend: (
        socket: WebSocket,
        payload: unknown,
        _errorType: string,
        _context: string,
      ) => {
        expect(socket).toBe(replacementSocket);
        replacementResponses.push(
          payload as BrowserDeviceMcpOAuthResponseMessage,
        );
        return true;
      },
    };

    handleBrowserDeviceMcpOAuthProtocolCommand(startCommand(), oldDependencies);
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      replacementDependencies,
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
  });

  test("replays a terminal that completed while the original socket was closed", async () => {
    const harness = createHarness(async () => undefined);
    harness.dependencies.safeSocketSend = () => false;
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand(),
      harness.dependencies,
    );
    await Promise.all(harness.tasks);

    const replacementResponses: BrowserDeviceMcpOAuthResponseMessage[] = [];
    handleBrowserDeviceMcpOAuthProtocolCommand(startCommand(), {
      ...harness.dependencies,
      socket: { replacement: true } as unknown as WebSocket,
      safeSocketSend: (_socket, payload) => {
        replacementResponses.push(
          payload as BrowserDeviceMcpOAuthResponseMessage,
        );
        return true;
      },
    });
    handleBrowserDeviceMcpOAuthProtocolCommand(startCommand(), {
      ...harness.dependencies,
      socket: { replacement: true } as unknown as WebSocket,
      safeSocketSend: (_socket, payload) => {
        replacementResponses.push(
          payload as BrowserDeviceMcpOAuthResponseMessage,
        );
        return true;
      },
    });

    expect(replacementResponses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: true,
      },
    ]);
  });

  test("uses the remaining absolute deadline and rejects unsafe budgets", async () => {
    const authorizationBudgets: number[] = [];
    const harness = createHarness(
      async (_request, _dependencies, _signal, authorizationTimeoutMs) => {
        authorizationBudgets.push(authorizationTimeoutMs);
      },
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand({ deadline_ms: NOW_MS + 200_000 }),
      harness.dependencies,
    );
    await Promise.all(harness.tasks);
    expect(authorizationBudgets).toEqual([105_000]);
    expect(harness.responses[0]?.success).toBe(true);

    for (const deadline_ms of [NOW_MS, NOW_MS + 95_000, NOW_MS + 280_001]) {
      const rejected = createHarness(async () => {
        throw new Error("must not run");
      });
      handleBrowserDeviceMcpOAuthProtocolCommand(
        startCommand({
          request_id: `rejected-${deadline_ms}`,
          deadline_ms,
        }),
        rejected.dependencies,
      );
      await Promise.all(rejected.tasks);
      expect(rejected.responses).toEqual([
        {
          type: "browser_device_mcp_oauth_response",
          request_id: `rejected-${deadline_ms}`,
          success: false,
          error_code: "invalid_request",
        },
      ]);
    }
  });

  test("cancels only the matching operation and emits cancelled", async () => {
    let observedSignal: AbortSignal | undefined;
    const harness = createHarness(
      async (_request, _dependencies, signal) =>
        await new Promise<void>((_resolve, reject) => {
          observedSignal = signal;
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
    expect(harness.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: false,
        error_code: "cancelled",
      },
    ]);
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

    expect(harness.responses).toEqual([
      {
        type: "browser_device_mcp_oauth_response",
        request_id: "operation-1",
        success: false,
        error_code: "invalid_request",
      },
    ]);
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
