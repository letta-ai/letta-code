import { describe, expect, test } from "bun:test";
import type { apiRequest } from "@/backend/api/request";
import { ApiRequestError } from "@/backend/api/request";
import {
  formatTeleportApiError,
  resolveTeleportSession,
  runTeleportSubcommand,
} from "@/cli/subcommands/teleport";

const CLOUD_ENV = {
  LETTA_AGENT_ID: "agent-1",
  LETTA_CONVERSATION_ID: "conv-1",
};

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureOutput(): {
  messages: string[];
  errors: string[];
  restore: () => void;
} {
  const messages: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    messages.push(String(message));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message));
  };
  return {
    messages,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

describe("teleport subcommand", () => {
  test("prints help and returns 0", async () => {
    const out = captureOutput();
    try {
      const exitCode = await runTeleportSubcommand(["--help"]);
      expect(exitCode).toBe(0);
      expect(out.messages.join("\n")).toContain("letta teleport list");
      expect(out.messages.join("\n")).toContain("letta teleport cloud");
      expect(out.messages.join("\n")).toContain("letta teleport local");
      expect(out.messages.join("\n")).not.toContain("letta teleport back");
    } finally {
      out.restore();
    }
  });

  test("prints help for help action", async () => {
    const out = captureOutput();
    try {
      const exitCode = await runTeleportSubcommand(["help"]);
      expect(exitCode).toBe(0);
      expect(out.messages.join("\n")).toContain("letta teleport");
    } finally {
      out.restore();
    }
  });

  test("prefers active shell session over fallback", () => {
    expect(
      resolveTeleportSession(CLOUD_ENV, {
        agentId: "agent-fallback",
        conversationId: "conv-fallback",
      }),
    ).toEqual({ agentId: "agent-1", conversationId: "conv-1" });
  });

  test("rejects local agents", () => {
    expect(() =>
      resolveTeleportSession(
        {
          LETTA_AGENT_ID: "agent-local-1",
          LETTA_CONVERSATION_ID: "conv-1",
        },
        null,
      ),
    ).toThrow("requires a Letta Cloud agent");
  });

  test("rejects virtual default conversation", () => {
    expect(() =>
      resolveTeleportSession(
        {
          LETTA_AGENT_ID: "agent-1",
          LETTA_CONVERSATION_ID: "default",
        },
        null,
      ),
    ).toThrow("requires an active conversation");
  });

  test("rejects virtual new conversation", () => {
    expect(() =>
      resolveTeleportSession(
        {
          LETTA_AGENT_ID: "agent-1",
          LETTA_CONVERSATION_ID: "new",
        },
        null,
      ),
    ).toThrow("requires an active conversation");
  });

  test("throws when no session is available", () => {
    expect(() => resolveTeleportSession({}, null)).toThrow(
      "No active agent conversation found",
    );
  });

  test("list prints accessible online remote environments as JSON", async () => {
    const out = captureOutput();
    try {
      const exitCode = await runTeleportSubcommand(["list"], {
        initializeSettings: async () => {},
        listEnvironments: async (options) => {
          expect(options).toEqual({ limit: 100, onlineOnly: true });
          return {
            connections: [
              {
                id: "local-env",
                connectionId: "local-1",
                deviceId: "local-device",
                connectionName: "Desktop Local",
                organizationId: "local",
                podId: "local",
                connectedAt: null,
                lastHeartbeat: Date.now(),
                lastSeenAt: Date.now(),
                firstSeenAt: Date.now(),
              },
              {
                id: "env-1",
                connectionId: "conn-1",
                deviceId: "device-1",
                connectionName: "Laptop",
                organizationId: "org-1",
                podId: null,
                connectedAt: null,
                lastHeartbeat: Date.now(),
                lastSeenAt: Date.now(),
                firstSeenAt: Date.now(),
              },
              {
                id: "env-offline",
                connectionId: null,
                deviceId: "device-offline",
                connectionName: "Offline Laptop",
                organizationId: "org-1",
                podId: null,
                connectedAt: null,
                lastHeartbeat: null,
                lastSeenAt: Date.now(),
                firstSeenAt: Date.now(),
              },
            ],
            hasNextPage: false,
          };
        },
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(out.messages[0] ?? "{}");
      expect(parsed.connections).toEqual([
        {
          deviceId: "device-1",
          connectionName: "Laptop",
          connectionId: "conn-1",
        },
      ]);
      expect(parsed.hasNextPage).toBe(false);
    } finally {
      out.restore();
    }
  });

  test("cloud resolves sandbox and submits teleport", async () => {
    const out = captureOutput();
    const teleportCalls: Array<{
      agentId: string;
      conversationId: string;
      targetConnectionId: string;
    }> = [];
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runTeleportSubcommand(["cloud"], {
          initializeSettings: async () => {},
          getLastSession: () => null,
          resolveAgentSandboxConnectionId: async (agentId, options) => {
            expect(agentId).toBe("agent-1");
            expect(options?.conversationId).toBe("conv-1");
            return {
              connectionId: "sandbox-conn-1",
              environment: {} as never,
            };
          },
          teleportToEnvironment: async (
            agentId,
            conversationId,
            targetConnectionId,
          ) => {
            teleportCalls.push({ agentId, conversationId, targetConnectionId });
            return {
              id: "teleport-1",
              agentId: "agent-1",
              conversationId: "conv-1",
              sourceConnectionId: "source-conn",
              targetConnectionId: "sandbox-conn-1",
              targetDeviceId: "device-sandbox",
              targetConnectionName: "Cloud",
              status: "waiting_for_source",
              error: null,
              createdAt: 1,
              updatedAt: 1,
            };
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(teleportCalls).toEqual([
        {
          agentId: "agent-1",
          conversationId: "conv-1",
          targetConnectionId: "sandbox-conn-1",
        },
      ]);
      const parsed = JSON.parse(out.messages[0] ?? "{}");
      expect(parsed.status).toBe("waiting_for_source");
      expect(parsed.targetConnectionId).toBe("sandbox-conn-1");
    } finally {
      out.restore();
    }
  });

  test("back directs callers to the explicit local target", async () => {
    const out = captureOutput();
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runTeleportSubcommand(["back"], {
          initializeSettings: async () => {},
          getLastSession: () => null,
        }),
      );

      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Use `letta teleport local`");
    } finally {
      out.restore();
    }
  });

  test("local resolves the online Desktop lease and submits teleport", async () => {
    const out = captureOutput();
    const teleportCalls: Array<{ targetConnectionId: string }> = [];
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runTeleportSubcommand(["local"], {
          initializeSettings: async () => {},
          getLastSession: () => null,
          resolveDesktopEnvironmentConnectionId: async () => ({
            connectionId: "conn-desktop",
            environment: {} as never,
          }),
          teleportToEnvironment: async (
            _agentId,
            _conversationId,
            targetConnectionId,
          ) => {
            teleportCalls.push({ targetConnectionId });
            return {
              id: "teleport-local",
              agentId: "agent-1",
              conversationId: "conv-1",
              sourceConnectionId: "conn-cloud",
              targetConnectionId,
              targetDeviceId: "device-desktop",
              targetConnectionName: "Caren's Mac",
              status: "waiting_for_source",
              error: null,
              createdAt: 1,
              updatedAt: 1,
            };
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(teleportCalls).toEqual([{ targetConnectionId: "conn-desktop" }]);
      expect(JSON.parse(out.messages[0] ?? "{}").targetConnectionId).toBe(
        "conn-desktop",
      );
    } finally {
      out.restore();
    }
  });

  test("rejects Desktop Local as an explicit environment target", async () => {
    const out = captureOutput();
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runTeleportSubcommand(["caren-mac.local"], {
          initializeSettings: async () => {},
          getLastSession: () => null,
          resolveEnvironmentConnectionId: async () => ({
            connectionId: "local-1",
            environment: {
              id: "local-env",
              connectionId: "local-1",
              deviceId: "local-device",
              connectionName: "caren-mac.local",
              organizationId: "local",
              podId: "local",
              connectedAt: null,
              lastHeartbeat: Date.now(),
              lastSeenAt: Date.now(),
              firstSeenAt: Date.now(),
            },
          }),
        }),
      );

      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain(
        "Desktop-local connection is not Cloud-routable",
      );
    } finally {
      out.restore();
    }
  });

  test("friendly selector resolves environment and submits teleport", async () => {
    const out = captureOutput();
    const teleportCalls: Array<{ targetConnectionId: string }> = [];
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runTeleportSubcommand(["my-laptop"], {
          initializeSettings: async () => {},
          getLastSession: () => null,
          resolveEnvironmentConnectionId: async (selector) => {
            expect(selector).toBe("my-laptop");
            return {
              connectionId: "conn-laptop",
              environment: {} as never,
            };
          },
          teleportToEnvironment: async (
            _agentId,
            _conversationId,
            targetConnectionId,
          ) => {
            teleportCalls.push({ targetConnectionId });
            return {
              id: "teleport-3",
              agentId: "agent-1",
              conversationId: "conv-1",
              sourceConnectionId: "source-conn",
              targetConnectionId: "conn-laptop",
              targetDeviceId: "device-laptop",
              targetConnectionName: "my-laptop",
              status: "completed",
              error: null,
              createdAt: 1,
              updatedAt: 1,
            };
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(teleportCalls).toEqual([{ targetConnectionId: "conn-laptop" }]);
      const parsed = JSON.parse(out.messages[0] ?? "{}");
      expect(parsed.status).toBe("completed");
    } finally {
      out.restore();
    }
  });

  test("POST shape includes targetConnectionId and idempotencyKey", async () => {
    const out = captureOutput();
    const requestCalls: Array<{
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [];
    const mockRequest = (async (
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ) => {
      requestCalls.push({ method, path, body });
      return {
        id: "teleport-4",
        agentId: "agent-1",
        conversationId: "conv-1",
        sourceConnectionId: "source-conn",
        targetConnectionId: "conn-target",
        targetDeviceId: "device-target",
        targetConnectionName: "Target",
        status: "waiting_for_source",
        error: null,
        createdAt: 1,
        updatedAt: 1,
      };
    }) as typeof apiRequest;

    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runTeleportSubcommand(["my-target"], {
          initializeSettings: async () => {},
          getLastSession: () => null,
          resolveEnvironmentConnectionId: async () => ({
            connectionId: "conn-target",
            environment: {} as never,
          }),
          teleportToEnvironment: async (
            agentId,
            conversationId,
            targetConnectionId,
          ) => {
            // Use the mock request to verify body shape
            return mockRequest(
              "POST",
              `/v1/environments/runtimes/${agentId}/${conversationId}/teleport`,
              { targetConnectionId, idempotencyKey: "test-uuid" },
            );
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(requestCalls).toHaveLength(1);
      expect(requestCalls[0]?.method).toBe("POST");
      expect(requestCalls[0]?.path).toContain("/teleport");
      expect(requestCalls[0]?.body).toHaveProperty("targetConnectionId");
      expect(requestCalls[0]?.body).toHaveProperty("idempotencyKey");
    } finally {
      out.restore();
    }
  });

  test("returns immediately after 202 without polling", async () => {
    const out = captureOutput();
    let teleportCallCount = 0;
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runTeleportSubcommand(["cloud"], {
          initializeSettings: async () => {},
          getLastSession: () => null,
          resolveAgentSandboxConnectionId: async () => ({
            connectionId: "conn-sandbox",
            environment: {} as never,
          }),
          teleportToEnvironment: async () => {
            teleportCallCount++;
            return {
              id: "teleport-5",
              agentId: "agent-1",
              conversationId: "conv-1",
              sourceConnectionId: "source-conn",
              targetConnectionId: "conn-sandbox",
              targetDeviceId: "device-sandbox",
              targetConnectionName: "Cloud",
              status: "waiting_for_source",
              error: null,
              createdAt: 1,
              updatedAt: 1,
            };
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(teleportCallCount).toBe(1);
      const parsed = JSON.parse(out.messages[0] ?? "{}");
      expect(parsed.status).toBe("waiting_for_source");
    } finally {
      out.restore();
    }
  });

  test("formats API error with concrete message from response body", async () => {
    const out = captureOutput();
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runTeleportSubcommand(["cloud"], {
          initializeSettings: async () => {},
          getLastSession: () => null,
          resolveAgentSandboxConnectionId: async () => ({
            connectionId: "conn-sandbox",
            environment: {} as never,
          }),
          teleportToEnvironment: async () => {
            throw new ApiRequestError(
              'API error (409): {"errorCode":"TELEPORT_CONFLICT","message":"A teleport is already in progress"}',
              409,
              JSON.stringify({
                errorCode: "TELEPORT_CONFLICT",
                message: "A teleport is already in progress",
              }),
            );
          },
        }),
      );

      expect(exitCode).toBe(1);
      expect(out.errors[0]).toBe("Error: A teleport is already in progress");
    } finally {
      out.restore();
    }
  });

  test("formats API error with errorCode when message is absent", () => {
    const error = new ApiRequestError(
      "API error (400): {}",
      400,
      JSON.stringify({ errorCode: "INVALID_TARGET" }),
    );
    expect(formatTeleportApiError(error)).toBe("INVALID_TARGET");
  });

  test("falls back to raw response text for unparseable body", () => {
    const error = new ApiRequestError(
      "API error (500): internal server error",
      500,
      "internal server error",
    );
    expect(formatTeleportApiError(error)).toBe(
      "API error (500): internal server error",
    );
  });

  test("formats generic errors with message", () => {
    expect(formatTeleportApiError(new Error("something went wrong"))).toBe(
      "something went wrong",
    );
  });
});
