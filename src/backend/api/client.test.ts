import { afterEach, describe, expect, test } from "bun:test";
import { actingUserRequestOptions } from "@/agent/acting-user";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { getClient, getClientDefaultHeaders } from "./client";
import { getLettaCodeHeaders } from "./http-headers";

const RUNTIME_ENVIRONMENT_DEVICE_ID_ENV = "LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID";
const ACTING_USER_ID_ENV = "LETTA_ACTING_USER_ID";
const originalRuntimeEnvironmentDeviceId =
  process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV];
const originalActingUserId = process.env[ACTING_USER_ID_ENV];

afterEach(() => {
  if (originalRuntimeEnvironmentDeviceId === undefined) {
    delete process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV];
  } else {
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV] =
      originalRuntimeEnvironmentDeviceId;
  }
  if (originalActingUserId === undefined) {
    delete process.env[ACTING_USER_ID_ENV];
  } else {
    process.env[ACTING_USER_ID_ENV] = originalActingUserId;
  }
});

describe("getClientDefaultHeaders", () => {
  test("uses the managed runtime device identity for environment attribution", () => {
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV] = "  sandbox-agent-test  ";

    expect(getClientDefaultHeaders()["X-Letta-Environment-Device-Id"]).toBe(
      "sandbox-agent-test",
    );
  });
});

test("SDK requests inherit the current actor without overriding explicit attribution", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      return Response.json({
        actor: request.headers.get("X-Letta-Acting-User-Id"),
      });
    },
  });
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalApiKey = process.env.LETTA_API_KEY;
  process.env.LETTA_BASE_URL = server.url.toString();
  process.env.LETTA_API_KEY = "test-key";
  process.env.LETTA_ACTING_USER_ID = "  user-shell  ";
  try {
    await settingsManager.initialize();
    // Retain one real SDK client across scopes: attribution belongs to each
    // request, not the turn that happened to construct the client.
    const client = await getClient();
    const read = (options?: Parameters<typeof client.get>[1]) =>
      client.get<{ actor: string | null }>("/v1/agents/", options);
    expect((await read()).actor).toBe("user-shell");
    await runWithRuntimeContext({ actingUserId: "user-turn" }, async () => {
      expect((await read()).actor).toBe("user-turn");
      expect(
        (await read(actingUserRequestOptions("user-explicit"))).actor,
      ).toBe("user-explicit");
      expect(
        (await read({ ...actingUserRequestOptions(null), maxRetries: 0 }))
          .actor,
      ).toBeNull();
      expect(
        (await read({ headers: { "x-letta-acting-user-id": null } })).actor,
      ).toBeNull();
    });
    await runWithRuntimeContext(
      { suppressActingUserFallback: true },
      async () => {
        expect((await read()).actor).toBeNull();
        expect(
          (await read(actingUserRequestOptions("user-explicit"))).actor,
        ).toBe("user-explicit");
      },
    );
    expect((await read()).actor).toBe("user-shell");
    delete process.env.LETTA_ACTING_USER_ID;
    expect((await read()).actor).toBeNull();
  } finally {
    server.stop(true);
    if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = originalBaseUrl;
    if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = originalApiKey;
  }
});

describe("getLettaCodeHeaders", () => {
  test("attributes direct API requests to the inherited acting user", () => {
    process.env[ACTING_USER_ID_ENV] = "  user-requester  ";

    expect(getLettaCodeHeaders("test-key")).toMatchObject({
      Authorization: "Bearer test-key",
      "X-Letta-Acting-User-Id": "user-requester",
    });
  });

  test("allows a request to suppress the inherited acting user", () => {
    process.env[ACTING_USER_ID_ENV] = "user-requester";

    expect(getLettaCodeHeaders("test-key", null)).not.toHaveProperty(
      "X-Letta-Acting-User-Id",
    );
  });
});
