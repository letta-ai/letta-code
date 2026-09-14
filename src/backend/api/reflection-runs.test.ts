import { describe, expect, test } from "bun:test";
import { Letta } from "@letta-ai/letta-client";
import { postReflectionRun } from "./reflection-runs";

const body = {
  conversation_id: "conv-fixture",
  client_request_id: "12345678-1234-4234-8234-123456789abc",
};

function fixture(status: number, data: unknown) {
  const requests: Request[] = [];
  const client = new Letta({
    apiKey: "scoped-fixture-key",
    baseURL: "https://api.letta.com",
    fetch: async (input, init) => {
      requests.push(
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init),
      );
      return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requests };
}

describe("reflection admission HTTP", () => {
  test("sends the strict body and scoped credentials without a model request", async () => {
    const { client, requests } = fixture(202, {
      status: "queued",
      run_id: "run-fixture",
    });
    expect(
      await postReflectionRun(client, "agent-fixture", body, {
        headers: { "X-Letta-Acting-User-Id": "user-fixture" },
      }),
    ).toEqual({ status: "queued", run_id: "run-fixture" });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe(
      "https://api.letta.com/v1/agents/agent-fixture/reflection/runs",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(
      "Bearer scoped-fixture-key",
    );
    expect(request?.headers.get("X-Letta-Acting-User-Id")).toBe("user-fixture");
    expect(await request?.json()).toEqual(body);
  });

  test("accepts no_work only as a 200 receipt", async () => {
    const { client } = fixture(200, { status: "no_work" });
    expect(await postReflectionRun(client, "agent-fixture", body)).toEqual({
      status: "no_work",
    });
  });

  test.each([
    [200, { status: "queued", run_id: "run-fixture" }],
    [202, { status: "no_work" }],
    [201, { status: "queued", run_id: "run-fixture" }],
    [202, { status: "queued" }],
    [202, { status: "queued", run_id: " " }],
    [202, { status: "queued", run_id: 7 }],
    [202, { status: "queued", run_id: "run-fixture", extra: true }],
    [200, { status: "no_work", run_id: "run-fixture" }],
    [200, null],
    [200, "ok"],
  ])("rejects unconfirmed receipt %s %j", async (status, data) => {
    const { client } = fixture(status as number, data);
    await expect(
      postReflectionRun(client, "agent-fixture", body),
    ).rejects.toThrow("invalid reflection receipt");
  });

  test.each([
    [409, "source_not_finished"],
    [409, "source_state_unknown"],
    [409, "agent_busy"],
    [409, "blocked_failed_run"],
    [409, "reflection_not_enabled"],
    [409, "idempotency_conflict"],
    [409, "state_changed"],
    [503, "admission_paused"],
    [503, "unavailable"],
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
  ])(
    "preserves HTTP %s reason %s without retry or credential fallback",
    async (status, reason) => {
      const { client, requests } = fixture(status as number, {
        detail: { reason, message: "Wait for the current work to finish." },
      });
      await expect(
        postReflectionRun(client, "agent-fixture", body),
      ).rejects.toThrow(`HTTP ${status}, ${reason}`);
      expect(requests).toHaveLength(1);
      expect(await requests[0]?.json()).toEqual(body);
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer scoped-fixture-key",
      );
    },
  );

  test("strips terminal controls and does not stringify unrelated error data", async () => {
    const { client } = fixture(409, {
      detail: {
        code: "agent_busy",
        message: "\u001b[31mBusy\u001b[0m\u0007",
        internal: "not-for-display",
      },
    });
    await expect(
      postReflectionRun(client, "agent-fixture", body),
    ).rejects.toThrow(
      "Reflection cannot be queued in the current state. (HTTP 409, agent_busy) Busy",
    );
  });

  test("an old server's non-JSON 404 is unavailable, not no-work", async () => {
    const client = new Letta({
      apiKey: "fixture-key",
      fetch: async () => new Response("Not Found", { status: 404 }),
    });
    await expect(
      postReflectionRun(client, "agent-fixture", body),
    ).rejects.toThrow("Reflection is unavailable on this server");
  });
});
