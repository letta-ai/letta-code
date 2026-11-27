import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type {
  EnvironmentConnection,
  listEnvironments,
} from "@/backend/api/environments";
import type { ExecuteCommandResponseMessage } from "@/types/task-control-protocol";
import type { SendUpgradeCommand } from "./computers-upgrade";
import { runEnvironmentsSubcommand } from "./environments";

function computer(
  overrides: { online?: boolean; supportedCommands?: string[] } = {},
): EnvironmentConnection {
  const online = overrides.online ?? true;
  return {
    id: "env-1",
    deviceId: "device-1",
    connectionId: online ? "conn-1" : null,
    connectionName: "build-box",
    organizationId: "org-1",
    podId: null,
    connectedAt: null,
    lastHeartbeat: online ? Date.now() : null,
    lastSeenAt: Date.now(),
    firstSeenAt: Date.now(),
    metadata: {
      lettaCodeVersion: "0.34.13",
      supported_commands: overrides.supportedCommands ?? [
        "doctor",
        "upgrade-letta-code",
      ],
    },
  };
}

function listOf(environment: EnvironmentConnection): typeof listEnvironments {
  return async () => ({ connections: [environment], hasNextPage: false });
}

let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
const savedAgentId = process.env.LETTA_AGENT_ID;
const savedConversationId = process.env.LETTA_CONVERSATION_ID;

beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  process.env.LETTA_AGENT_ID = "agent-env";
  delete process.env.LETTA_CONVERSATION_ID;
});

afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  if (savedAgentId === undefined) delete process.env.LETTA_AGENT_ID;
  else process.env.LETTA_AGENT_ID = savedAgentId;
  if (savedConversationId === undefined)
    delete process.env.LETTA_CONVERSATION_ID;
  else process.env.LETTA_CONVERSATION_ID = savedConversationId;
});

function output(spy: ReturnType<typeof spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

function run(
  args: string[],
  environment: EnvironmentConnection,
  sendCommand: SendUpgradeCommand,
  timeoutMs?: number,
) {
  return runEnvironmentsSubcommand(["upgrade", ...args], {
    initializeSettings: async () => {},
    listEnvironments: listOf(environment),
    upgrade: { sendCommand, timeoutMs },
  });
}

test("upgrade sends upgrade-letta-code to the resolved connection and prints the result", async () => {
  const calls: Parameters<SendUpgradeCommand>[0][] = [];
  const sendCommand: SendUpgradeCommand = async (params) => {
    calls.push(params);
    return {
      type: "execute_command_response",
      request_id: params.payload.request_id,
      success: true,
      output: "Updated to 0.40.0.\nRestarting remote listener...",
    };
  };

  expect(await run(["build-box"], computer(), sendCommand)).toBe(0);

  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call?.connectionId).toBe("conn-1");
  expect(call?.timeoutMs).toBe(5 * 60_000);
  expect(call?.payload).toEqual({
    type: "execute_command",
    command_id: "upgrade-letta-code",
    request_id: expect.any(String),
    runtime: { agent_id: "agent-env", conversation_id: "default" },
  });
  const stdout = output(log);
  expect(stdout).toContain("current version 0.34.13");
  expect(stdout).toContain("Updated to 0.40.0.");
  expect(stdout).toContain("Restarting remote listener...");
});

test("upgrade --json reports the listener result with the previous version", async () => {
  const sendCommand: SendUpgradeCommand = async ({ payload }) => ({
    type: "execute_command_response",
    request_id: payload.request_id,
    success: true,
    output: "Already on latest version (0.40.0)",
  });

  expect(
    await run(
      ["device-1", "--json", "--agent", "agent-flag", "--conversation", "c-1"],
      computer(),
      async (params) => {
        expect(params.payload.runtime).toEqual({
          agent_id: "agent-flag",
          conversation_id: "c-1",
        });
        return sendCommand(params);
      },
    ),
  ).toBe(0);

  expect(JSON.parse(output(log))).toEqual({
    success: true,
    id: "env-1",
    deviceId: "device-1",
    connectionName: "build-box",
    connectionId: "conn-1",
    previousVersion: "0.34.13",
    output: "Already on latest version (0.40.0)",
  });
});

test("upgrade fails without sending when the computer is offline", async () => {
  let sent = false;
  const code = await run(
    ["build-box"],
    computer({ online: false }),
    async () => {
      sent = true;
      throw new Error("unreachable");
    },
  );

  expect(code).toBe(1);
  expect(sent).toBe(false);
  expect(output(error)).toContain("offline");
});

test("upgrade fails without sending when the listener does not support the command", async () => {
  let sent = false;
  const code = await run(
    ["build-box"],
    computer({ supportedCommands: ["doctor"] }),
    async () => {
      sent = true;
      throw new Error("unreachable");
    },
  );

  expect(code).toBe(1);
  expect(sent).toBe(false);
  expect(output(error)).toContain("does not support remote upgrades");
});

test("upgrade exits non-zero when the listener does not answer in time", async () => {
  const sendCommand: SendUpgradeCommand = async ({ payload, timeoutMs }) => {
    expect(timeoutMs).toBe(10);
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    throw new Error(`Timed out waiting for ${payload.request_id}`);
  };

  expect(await run(["build-box"], computer(), sendCommand, 10)).toBe(1);
  expect(output(error)).toContain("Timed out waiting for");
});

test("upgrade exits non-zero when the listener reports a failed update", async () => {
  const sendCommand: SendUpgradeCommand = async ({ payload }) =>
    ({
      type: "execute_command_response",
      request_id: payload.request_id,
      success: false,
      output: "npm install failed",
    }) satisfies ExecuteCommandResponseMessage;

  expect(await run(["build-box"], computer(), sendCommand)).toBe(1);
  expect(output(error)).toContain("npm install failed");
});

test("upgrade requires a computer selector", async () => {
  expect(
    await run([], computer(), async () => {
      throw new Error("unreachable");
    }),
  ).toBe(1);
  expect(output(error)).toContain("requires a <computer>");
});
