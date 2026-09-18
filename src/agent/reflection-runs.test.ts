import { afterEach, describe, expect, test } from "bun:test";
import { Letta } from "@letta-ai/letta-client";
import { __testSetBackend, APIBackend } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { shouldSlashCommandBypassQueue } from "@/cli/app/command-routing";
import { executeCommand } from "@/cli/commands/registry";
import {
  requestCloudReflectionRun,
  requestReflectionRun,
} from "./reflection-runs";

const originalUrl = process.env.LETTA_BASE_URL;
afterEach(() => {
  __testSetBackend(null);
  if (originalUrl === undefined) delete process.env.LETTA_BASE_URL;
  else process.env.LETTA_BASE_URL = originalUrl;
});

function fixture(
  status = 202,
  response: unknown = { status: "queued", run_id: "run-fixture" },
  config: unknown = { cutover: true },
  configStatus = 200,
) {
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
      if (requests.at(-1)?.method === "GET")
        return Response.json(config, { status: configStatus });
      return Response.json(response, { status });
    },
  });
  const backend = new APIBackend({ getClient: async () => client });
  return { backend, requests, client };
}

describe("manual reflection ownership", () => {
  test.each(["dream", "reflect", "reflection"])(
    "/%s resolves Cloud ownership",
    async (alias) => {
      const { backend, requests } = fixture();
      __testSetBackend(backend);
      expect(
        await executeCommand(`/${alias}`, { agentId: "agent-alias" }),
      ).toMatchObject({ success: true, output: "Dreaming..." });
      expect(requests.map((request) => request.method)).toEqual([
        "GET",
        "POST",
      ]);
      expect(shouldSlashCommandBypassQueue(`/${alias}`)).toBe(true);
    },
  );

  test("captures scope before ownership lookup and preserves acting user on both requests", async () => {
    const { backend, requests } = fixture();
    const scope = {
      agentId: "agent-original",
      conversationId: "conv-original",
      actingUserId: "user-original",
    };
    const pending = requestCloudReflectionRun(scope, "", backend);
    scope.agentId = "agent-other";
    scope.conversationId = "conv-other";
    scope.actingUserId = "user-other";
    expect(await pending).toBe("Dreaming...");
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    for (const request of requests) {
      expect(request.url).toContain("/agents/agent-original/reflection");
      expect(request.headers.get("X-Letta-Acting-User-Id")).toBe(
        "user-original",
      );
    }
    expect(await requests[1]?.json()).toEqual({
      conversation_id: "conv-original",
    });
  });

  test("only known Code ownership authorizes legacy arguments", async () => {
    const { backend, requests } = fixture(202, {}, { cutover: false });
    expect(
      await requestCloudReflectionRun(
        { agentId: "agent-legacy" },
        "--auto",
        backend,
      ),
    ).toBeNull();
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
    const local = new LocalBackend({
      storageDir: "/unused-reflect-fixture",
      memfsEnabled: false,
    });
    expect(
      await requestCloudReflectionRun(
        { agentId: "local-agent" },
        "--recent 2",
        local,
      ),
    ).toBeNull();
  });

  test.each([null, {}, { cutover: "false" }])(
    "malformed ownership fails closed",
    async (config) => {
      const { backend, requests } = fixture(202, {}, config);
      await expect(
        requestCloudReflectionRun({ agentId: "agent-fail" }, "", backend),
      ).rejects.toThrow("Unable to determine reflection ownership");
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    },
  );

  test.each([403, 404, 500])(
    "ownership lookup %s fails closed",
    async (configStatus) => {
      const { backend, requests } = fixture(202, {}, {}, configStatus);
      await expect(
        requestCloudReflectionRun({ agentId: "agent-fail" }, "--auto", backend),
      ).rejects.toThrow();
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    },
  );
});

describe("/dream admission command", () => {
  test("freezes scope and sends only the conversation on repeated requests", async () => {
    const { backend, requests } = fixture();
    const scope = {
      agentId: "agent-original",
      conversationId: "conv-original",
      actingUserId: "user-original",
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
      });
    }
  });

  test("TUI registry executes with explicit scope and default conversation", async () => {
    const { backend, requests } = fixture();
    __testSetBackend(backend);
    for (let invocation = 0; invocation < 2; invocation++) {
      expect(await executeCommand("/dream", { agentId: "agent-tui" })).toEqual({
        success: true,
        output: "Dreaming...",
      });
    }
    const bodies = await Promise.all(
      requests
        .filter((request) => request.method === "POST")
        .map((request) => request.json()),
    );
    expect(bodies).toEqual([
      { conversation_id: "default" },
      { conversation_id: "default" },
    ]);
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
      output: expect.stringContaining(
        "Cloud reflection does not accept arguments",
      ),
    });
    expect(await executeCommand("/dream")).toMatchObject({ success: false });
    await expect(
      requestReflectionRun({ agentId: "agent-fixture" }, "prompt", backend),
    ).rejects.toThrow("does not accept arguments");
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
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

  test.each([
    {
      status: 200,
      response: { status: "no_work" },
      success: true,
      output: "No new work to reflect on in this conversation.",
    },
    {
      status: 409,
      response: {
        code: "busy",
        message: "The conversation already has active reflection work",
      },
      success: false,
      output: "HTTP 409, busy",
    },
  ])(
    "TUI displays admission outcome $status without polling",
    async ({ status, response, success, output }) => {
      const { backend, requests } = fixture(status, response);
      __testSetBackend(backend);
      expect(
        await executeCommand("/dream", { agentId: "agent-tui" }),
      ).toMatchObject({
        success,
        output: expect.stringContaining(output),
      });
      expect(requests.map((request) => request.method)).toEqual([
        "GET",
        "POST",
      ]);
      expect(await requests[1]?.json()).toEqual({ conversation_id: "default" });
    },
  );
});
