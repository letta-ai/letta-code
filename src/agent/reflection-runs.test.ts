import { afterEach, describe, expect, test } from "bun:test";
import { Letta } from "@letta-ai/letta-client";
import { __testSetBackend, APIBackend } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { shouldSlashCommandBypassQueue } from "@/cli/app/command-routing";
import { executeCommand } from "@/cli/commands/registry";
import { requestReflectionRun } from "./reflection-runs";

const originalUrl = process.env.LETTA_BASE_URL;
afterEach(() => {
  __testSetBackend(null);
  if (originalUrl === undefined) delete process.env.LETTA_BASE_URL;
  else process.env.LETTA_BASE_URL = originalUrl;
});

function fixture() {
  process.env.LETTA_BASE_URL = "https://api.letta.com";
  const requests: Request[] = [];
  const client = new Letta({
    apiKey: "fixture-scoped-key",
    baseURL: "https://api.letta.com",
    fetch: async (input, init) => {
      requests.push(
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init),
      );
      return Response.json(
        { status: "queued", run_id: "run-fixture" },
        { status: 202 },
      );
    },
  });
  const backend = new APIBackend({ getClient: async () => client });
  return { backend, requests, client };
}

describe("/dream admission command", () => {
  test("freezes scope and preserves the transport UUID on redelivery", async () => {
    const { backend, requests } = fixture();
    const scope = {
      agentId: "agent-original",
      conversationId: "conv-original",
      actingUserId: "user-original",
      clientRequestId: "12345678-1234-4234-8234-123456789abc",
    };
    const first = requestReflectionRun(scope, "", backend);
    const second = requestReflectionRun({ ...scope }, "", backend);
    scope.agentId = "agent-other";
    scope.conversationId = "conv-other";
    scope.actingUserId = "user-other";
    await Promise.all([first, second]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toContain("/agents/agent-original/reflection/runs");
      expect(request.headers.get("X-Letta-Acting-User-Id")).toBe(
        "user-original",
      );
      expect(await request.json()).toEqual({
        conversation_id: "conv-original",
        client_request_id: "12345678-1234-4234-8234-123456789abc",
      });
    }
  });

  test("TUI registry executes with explicit scope, default conversation and fresh UUIDs", async () => {
    const { backend, requests } = fixture();
    __testSetBackend(backend);
    for (let invocation = 0; invocation < 2; invocation++) {
      expect(await executeCommand("/dream", { agentId: "agent-tui" })).toEqual({
        success: true,
        output: "Reflection queued. Run ID: run-fixture",
      });
    }
    const bodies = (await Promise.all(
      requests.map((request) => request.json()),
    )) as { conversation_id: string; client_request_id: string }[];
    expect(bodies[0]?.conversation_id).toBe("default");
    expect(bodies[0]?.client_request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(bodies[0]?.client_request_id).not.toBe(bodies[1]?.client_request_id);
    expect(shouldSlashCommandBypassQueue("/dream")).toBe(true);
  });

  test("rejects arguments and missing scope without HTTP or model requests", async () => {
    const { backend, requests } = fixture();
    __testSetBackend(backend);
    expect(
      await executeCommand("/dream --instruction do something", {
        agentId: "agent-tui",
      }),
    ).toMatchObject({
      success: false,
      output: "/dream does not accept arguments.",
    });
    expect(await executeCommand("/dream")).toMatchObject({ success: false });
    await expect(
      requestReflectionRun({ agentId: "agent-fixture" }, "prompt", backend),
    ).rejects.toThrow("does not accept arguments");
    expect(requests).toHaveLength(0);
  });

  test("local state and custom servers return unsupported without acquiring credentials", async () => {
    const local = new LocalBackend({
      storageDir: "/unused-dream-fixture",
      memfsEnabled: false,
    });
    await expect(
      requestReflectionRun({ agentId: "local-agent-fixture" }, "", local),
    ).rejects.toThrow("Local and custom backends are not supported");
    process.env.LETTA_BASE_URL = "https://custom.example.invalid";
    const custom = new APIBackend({
      getClient: async () => {
        throw new Error("Must not read credentials");
      },
    });
    await expect(
      requestReflectionRun({ agentId: "agent-fixture" }, "", custom),
    ).rejects.toThrow("Local and custom backends are not supported");
  });

  test("an invalid transport id is replaced with a UUID, not posted verbatim", async () => {
    const { backend, requests } = fixture();
    await requestReflectionRun(
      { agentId: "agent-fixture", clientRequestId: "legacy-request" },
      "",
      backend,
    );
    const body = (await requests[0]?.json()) as { client_request_id: string };
    expect(body.client_request_id).toMatch(/^[a-f0-9-]{36}$/);
  });
});
