import { afterEach, describe, expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { __testSetBackend, APIBackend } from "@/backend";
import { waitForBlockingRunToSettle } from "@/cli/app/busy-run-recovery";

type RunState = {
  status: "created" | "running" | "completed";
  stopReason?: "end_turn" | "requires_approval";
};

const servers = new Set<ReturnType<typeof Bun.serve>>();

afterEach(() => {
  __testSetBackend(null);
  for (const server of servers) server.stop(true);
  servers.clear();
});

function startRunApi(states: RunState[]) {
  const requestedRunIds: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (request.method !== "GET" || !match?.[1]) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      requestedRunIds.push(match[1]);
      const state = states.shift() ?? {
        status: "completed",
        stopReason: "end_turn",
      };
      return Response.json({
        id: match[1],
        agent_id: "agent-busy-recovery",
        conversation_id: "conv-busy-recovery",
        status: state.status,
        stop_reason: state.stopReason,
        created_at: "2026-09-21T00:00:00.000Z",
        metadata: {},
      });
    },
  });
  servers.add(server);

  const client = new Letta({
    apiKey: "test-api-key",
    baseURL: server.url.href,
    maxRetries: 0,
  });
  __testSetBackend(
    new APIBackend({
      getClient: async () => client,
    }),
  );
  return requestedRunIds;
}

describe("TUI blocking-run wait", () => {
  test("polls a real Core API request boundary until the blocker settles", async () => {
    const requestedRunIds = startRunApi([
      { status: "running" },
      { status: "completed", stopReason: "end_turn" },
    ]);
    await expect(
      waitForBlockingRunToSettle("run-blocker", undefined, 0),
    ).resolves.toBe("settled");

    expect(requestedRunIds).toEqual(["run-blocker", "run-blocker"]);
  });

  test("keeps a completed blocker pending when it requires approval", async () => {
    const requestedRunIds = startRunApi([
      { status: "completed", stopReason: "requires_approval" },
    ]);

    await expect(
      waitForBlockingRunToSettle("run-awaiting-approval", undefined, 0),
    ).resolves.toBe("requires_approval");
    expect(requestedRunIds).toEqual(["run-awaiting-approval"]);
  });

  test("cancels an active blocker wait without another polling request", async () => {
    const requestedRunIds = startRunApi([
      { status: "running" },
      { status: "running" },
    ]);
    const controller = new AbortController();
    const waiting = waitForBlockingRunToSettle(
      "run-long-blocker",
      controller.signal,
    );

    while (requestedRunIds.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort(new Error("Cancelled by user"));

    await expect(waiting).rejects.toThrow("Cancelled by user");
    expect(requestedRunIds).toEqual(["run-long-blocker"]);
  });

  test("reports an unavailable blocker after a diagnosable Core API failure", async () => {
    const requestedRunIds = startRunApi([]);
    const server = [...servers][0];
    server?.stop(true);

    await expect(waitForBlockingRunToSettle("run-unavailable")).resolves.toBe(
      "unavailable",
    );
    expect(requestedRunIds).toEqual([]);
  });
});
