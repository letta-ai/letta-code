import { describe, expect, test } from "bun:test";
import { resolveTraySession, runTraySubcommand } from "./tray";

const payload = JSON.stringify({
  version: 1,
  type: "markdownlet",
  title: "Open PRs",
  markdown: "| PR | Status |",
});

const cloudEnv = {
  AGENT_ID: "agent-1",
  CONVERSATION_ID: "conv-1",
};

async function withEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    AGENT_ID: process.env.AGENT_ID,
    CONVERSATION_ID: process.env.CONVERSATION_ID,
    LETTA_AGENT_ID: process.env.LETTA_AGENT_ID,
    LETTA_CONVERSATION_ID: process.env.LETTA_CONVERSATION_ID,
  };
  Object.assign(process.env, cloudEnv);
  delete process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_CONVERSATION_ID;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("Tray subcommand", () => {
  test("prefers explicit scope and rejects local agents", () => {
    expect(
      resolveTraySession(
        { agent: "agent-explicit", conversation: "default" },
        cloudEnv,
        null,
      ),
    ).toEqual({ agentId: "agent-explicit", conversationId: "default" });
    expect(() =>
      resolveTraySession(
        { agent: "agent-local-1", conversation: "conv-1" },
        {},
        null,
      ),
    ).toThrow("Letta Cloud agents");
  });

  test("adds a validated markdownlet", async () => {
    const calls: unknown[] = [];
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(
          ["add", "--conversation-id", "conv-1", "--tray-payload", payload],
          {
            initializeSettings: async () => {},
            isCloud: async () => true,
            getLastSession: () => null,
            createItem: async (...args) => {
              calls.push(args);
              return {
                id: "tray-1",
                agent_id: "agent-1",
                conversation_id: "conv-1",
                payload: JSON.parse(payload),
                created_at: "2026-09-18T00:00:00.000Z",
                updated_at: "2026-09-18T00:00:00.000Z",
              };
            },
          },
        ),
      );
      expect(code).toBe(0);
      expect(calls).toEqual([["agent-1", "conv-1", JSON.parse(payload)]]);
    } finally {
      console.log = originalLog;
    }
  });

  test.each([
    ["not-json", "Invalid --tray-payload JSON"],
    ["[]", "must be a JSON object"],
    [
      JSON.stringify({ ...JSON.parse(payload), version: 2 }),
      "expected version 1",
    ],
    [
      JSON.stringify({ ...JSON.parse(payload), secret: true }),
      "Unsupported tray payload field",
    ],
  ])("rejects invalid payload %s", async (raw, expected) => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => errors.push(String(message));
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["add", "--tray-payload", raw], {
          initializeSettings: async () => {},
          isCloud: async () => true,
          getLastSession: () => null,
          createItem: async () => {
            throw new Error("must not call API");
          },
        }),
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain(expected);
    } finally {
      console.error = originalError;
    }
  });

  test("rejects non-Cloud backends before API calls", async () => {
    let called = false;
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await runTraySubcommand(["list"], {
        initializeSettings: async () => {},
        isCloud: async () => false,
        getLastSession: () => ({
          agentId: "agent-1",
          conversationId: "conv-1",
        }),
        listItems: async () => {
          called = true;
          return [];
        },
      });
      expect(code).toBe(1);
      expect(called).toBe(false);
    } finally {
      console.error = originalError;
    }
  });
});
