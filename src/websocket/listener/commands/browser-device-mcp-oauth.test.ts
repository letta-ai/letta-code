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

function startCommand(
  overrides: Partial<BrowserDeviceMcpOAuthCommand> = {},
): BrowserDeviceMcpOAuthCommand {
  return {
    type: "browser_device_mcp_oauth",
    request_id: "operation-1",
    handoff_key: VALID_HANDOFF_KEY,
    service: "datadog",
    server_url: "https://mcp.datadoghq.com/v1/mcp",
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
