import { expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { createCloudFixture } from "./cloud-fixture-retry";

function rejection(overrides = {}) {
  return {
    status: 503,
    error: {
      errorCode: "cloud_api_shutting_down",
      admitted: false,
      retryable: true,
      ...overrides,
    },
    headers: new Headers({ "Retry-After": "3" }),
  };
}

test("SDK fixture creation survives the captured deployment rejection", async () => {
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.text());
      return bodies.length === 1
        ? Response.json(rejection().error, {
            status: 503,
            headers: { "Retry-After": "0" },
          })
        : Response.json({ id: "agent-created-once" });
    },
  });
  try {
    const sdk = new Letta({
      apiKey: "fixture-key",
      baseURL: server.url.toString(),
      maxRetries: 0,
    });
    const agent = await createCloudFixture(() =>
      sdk.agents.create({ name: "fixture" }),
    );
    expect(agent.id).toBe("agent-created-once");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  } finally {
    server.stop(true);
  }
});

test("retries rejected fixture creation and honors Retry-After", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const fixture = { id: "agent-fixture" };
  expect(
    await createCloudFixture(
      async () => {
        if (++attempts < 3) throw rejection();
        return fixture;
      },
      async (ms) => {
        waits.push(ms);
      },
    ),
  ).toBe(fixture);
  expect(attempts).toBe(3);
  expect(waits).toEqual([3000, 3000]);
});

test("stops after three retries and preserves the error", async () => {
  const error = rejection();
  let attempts = 0;
  await expect(
    createCloudFixture(
      async () => {
        attempts++;
        throw error;
      },
      async () => {},
    ),
  ).rejects.toBe(error);
  expect(attempts).toBe(4);
});

test("fails instead of retrying earlier than a long server delay", async () => {
  const error = rejection();
  error.headers.set("Retry-After", "60");
  let waited = false;
  await expect(
    createCloudFixture(
      async () => {
        throw error;
      },
      async () => {
        waited = true;
      },
    ),
  ).rejects.toBe(error);
  expect(waited).toBe(false);
});

test("never repeats accepted work, generic failures, or transport errors", async () => {
  for (const error of [
    rejection({ admitted: true }),
    rejection({ retryable: false }),
    rejection({ errorCode: "other" }),
    new Error("connection reset"),
  ]) {
    let attempts = 0;
    await expect(
      createCloudFixture(
        async () => {
          attempts++;
          throw error;
        },
        async () => {},
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  }
});
