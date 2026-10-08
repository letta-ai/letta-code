import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import type {
  BrowserDeviceMcpOAuthCommand,
  BrowserDeviceMcpOAuthResponseMessage,
} from "@/types/task-control-protocol";
import type { ListenerRuntime } from "@/websocket/listener/types";
import {
  handleBrowserDeviceMcpOAuthProtocolCommand,
  resetBrowserDeviceMcpOAuthOperationsForTests,
} from "./browser-device-mcp-oauth";

const HANDOFF_KEY = "h".repeat(43);

function startCommand(request_id: string): BrowserDeviceMcpOAuthCommand {
  return {
    type: "browser_device_mcp_oauth",
    request_id,
    handoff_key: HANDOFF_KEY,
    service: "datadog",
    server_url: "https://mcp.datadoghq.com/v1/mcp",
    timeout_ms: 285_000,
  };
}

function createHarness(connect: () => Promise<void>) {
  const tasks: Promise<void>[] = [];
  const responses: BrowserDeviceMcpOAuthResponseMessage[] = [];
  const dependencies = {
    connect,
    runDetachedListenerTask: (_name: string, task: () => Promise<void>) => {
      const promise = task();
      tasks.push(promise);
    },
    safeSocketSend: (_socket: WebSocket, payload: unknown) => {
      responses.push(payload as BrowserDeviceMcpOAuthResponseMessage);
      return true;
    },
    socket: {} as WebSocket,
    owner: {} as ListenerRuntime,
    lineageId: "capacity-lineage",
    monotonicNow: () => 1_000,
  };
  return { dependencies, responses, tasks };
}

type Harness = ReturnType<typeof createHarness>;

function cancel(harness: Harness, operation_id: string): void {
  handleBrowserDeviceMcpOAuthProtocolCommand(
    { type: "browser_device_mcp_oauth_cancel", operation_id },
    harness.dependencies,
  );
}

afterEach(() => resetBrowserDeviceMcpOAuthOperationsForTests());

describe("browser-device MCP OAuth cancel tombstone capacity", () => {
  test("evicts oldest per-runtime entries without touching a live flight", async () => {
    let settleLive: (() => void) | undefined;
    const harness = createHarness(
      async () =>
        await new Promise<void>((resolve) => {
          settleLive = resolve;
        }),
    );
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand("live-operation"),
      harness.dependencies,
    );
    for (let index = 0; index < 129; index += 1) {
      cancel(harness, `pending-cancel-${index}`);
    }
    for (const requestId of [
      "pending-cancel-0",
      "pending-cancel-128",
      "same-service-contender",
    ]) {
      handleBrowserDeviceMcpOAuthProtocolCommand(
        startCommand(requestId),
        harness.dependencies,
      );
    }
    await Promise.all(harness.tasks.slice(1));
    const codes = Object.fromEntries(
      harness.responses.map((response) => [
        response.request_id,
        response.success ? "success" : response.error_code,
      ]),
    );
    expect(codes["pending-cancel-0"]).toBe("already_connecting");
    expect(codes["pending-cancel-128"]).toBe("cancelled");
    expect(codes["same-service-contender"]).toBe("already_connecting");
    settleLive?.();
    await harness.tasks[0];
  });

  test("evicts the globally oldest tombstone at the hard bound", async () => {
    const harnesses = Array.from({ length: 5 }, (_value, runtimeIndex) => {
      const harness = createHarness(async () => undefined);
      harness.dependencies.lineageId = `global-lineage-${runtimeIndex}`;
      return harness;
    });
    const harnessAt = (index: number): Harness => {
      const harness = harnesses[index];
      if (!harness) throw new Error("Missing capacity harness");
      return harness;
    };
    for (let runtimeIndex = 0; runtimeIndex < 4; runtimeIndex += 1) {
      for (let index = 0; index < 128; index += 1) {
        cancel(
          harnessAt(runtimeIndex),
          `global-cancel-${runtimeIndex}-${index}`,
        );
      }
    }
    cancel(harnessAt(4), "global-cancel-4-0");
    const firstHarness = harnessAt(0);
    const lastHarness = harnessAt(4);
    for (const requestId of ["global-cancel-0-0", "global-cancel-0-1"]) {
      handleBrowserDeviceMcpOAuthProtocolCommand(
        startCommand(requestId),
        firstHarness.dependencies,
      );
    }
    handleBrowserDeviceMcpOAuthProtocolCommand(
      startCommand("global-cancel-4-0"),
      lastHarness.dependencies,
    );
    await Promise.all(firstHarness.tasks);
    expect(firstHarness.responses.map((response) => response.success)).toEqual([
      false,
      true,
    ]);
    expect(lastHarness.responses[0]?.error_code).toBe("cancelled");
  });
});
