import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiRequestError } from "@/backend/api/request";
import type { TrayItem } from "@/backend/api/tray";
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

describe("managing-tray SKILL.md", () => {
  test("documents shell-neutral one-line commands with payload files", () => {
    const skillPath = join(
      process.cwd(),
      "src/skills/builtin/managing-tray/SKILL.md",
    );
    const content = readFileSync(skillPath, "utf8");

    expect(content).toContain("--tray-payload-file tray-item.json");
    expect(content).not.toMatch(/\\\r?\n/);
    expect(content).not.toContain("$AGENT_ID");
    expect(content).not.toContain("$CONVERSATION_ID");
  });
});

describe("resolveTraySession", () => {
  test("prefers explicit scope without reading partial lower-priority scopes", () => {
    expect(
      resolveTraySession(
        { agent: "agent-explicit", conversation: "conv-x" },
        { LETTA_AGENT_ID: "agent-partial", CONVERSATION_ID: "conv-partial" },
        null,
      ),
    ).toEqual({ agentId: "agent-explicit", conversationId: "conv-x" });
  });

  test("rejects local agent IDs", () => {
    expect(() =>
      resolveTraySession(
        { agent: "agent-local-1", conversation: "conv-1" },
        {},
        null,
      ),
    ).toThrow("Letta Cloud agents");
  });

  test("falls back to LETTA_ env variables when no explicit scope", () => {
    expect(
      resolveTraySession(
        {},
        { LETTA_AGENT_ID: "agent-2", LETTA_CONVERSATION_ID: "conv-2" },
        null,
      ),
    ).toEqual({ agentId: "agent-2", conversationId: "conv-2" });
  });

  test("falls back to plain env variables after LETTA_ env", () => {
    expect(resolveTraySession({}, cloudEnv, null)).toEqual({
      agentId: "agent-1",
      conversationId: "conv-1",
    });
  });

  test("falls back to last session when no env is set", () => {
    expect(
      resolveTraySession(
        {},
        {},
        { agentId: "agent-3", conversationId: "conv-3" },
      ),
    ).toEqual({ agentId: "agent-3", conversationId: "conv-3" });
  });

  test("rejects partial explicit scope: agent without conversation", () => {
    expect(() => resolveTraySession({ agent: "agent-1" }, {}, null)).toThrow(
      "Explicit Tray scope must provide both agent and conversation IDs",
    );
  });

  test("rejects partial explicit scope: conversation without agent", () => {
    expect(() =>
      resolveTraySession({ conversation: "conv-1" }, {}, null),
    ).toThrow(
      "Explicit Tray scope must provide both agent and conversation IDs",
    );
  });

  test("rejects partial LETTA env: only LETTA_AGENT_ID set", () => {
    expect(() =>
      resolveTraySession({}, { LETTA_AGENT_ID: "agent-1" }, null),
    ).toThrow(
      "LETTA environment Tray scope must provide both agent and conversation IDs",
    );
  });

  test("rejects partial LETTA env: only LETTA_CONVERSATION_ID set", () => {
    expect(() =>
      resolveTraySession({}, { LETTA_CONVERSATION_ID: "conv-1" }, null),
    ).toThrow(
      "LETTA environment Tray scope must provide both agent and conversation IDs",
    );
  });

  test("rejects conflicting --agent and --agent-id aliases", () => {
    expect(() =>
      resolveTraySession(
        { agent: "agent-1", "agent-id": "agent-2", conversation: "conv-1" },
        {},
        null,
      ),
    ).toThrow("Conflicting agent values");
  });

  test("rejects conflicting --conversation and --conversation-id aliases", () => {
    expect(() =>
      resolveTraySession(
        {
          agent: "agent-1",
          conversation: "conv-1",
          "conversation-id": "conv-2",
        },
        {},
        null,
      ),
    ).toThrow("Conflicting conversation values");
  });

  test("prefers the complete LETTA_ scope over the plain environment", () => {
    expect(
      resolveTraySession(
        {},
        {
          LETTA_AGENT_ID: "agent-letta",
          LETTA_CONVERSATION_ID: "conv-letta",
          AGENT_ID: "agent-plain",
          CONVERSATION_ID: "conv-plain",
        },
        null,
      ),
    ).toEqual({ agentId: "agent-letta", conversationId: "conv-letta" });
  });

  test("errors when no scope is available", () => {
    expect(() => resolveTraySession({}, {}, null)).toThrow(
      "Pass --agent <id> and --conversation-id <id>",
    );
  });

  test("rejects 'new' conversation ID", () => {
    expect(() =>
      resolveTraySession({}, {}, { agentId: "agent-1", conversationId: "new" }),
    ).toThrow("Pass --conversation-id <id>");
  });
});

describe("Tray payload validation boundaries", () => {
  const basePayload = { version: 1, type: "markdownlet", markdown: "ok" };

  async function runAdd(
    raw: string,
  ): Promise<{ code: number; errors: string[] }> {
    const errors: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (msg?: unknown) => errors.push(String(msg));
    console.log = () => {};
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["add", "--tray-payload", raw], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          listItems: async () => [],
          createItem: async (_, __, p) => ({
            id: "t1",
            agent_id: "agent-1",
            conversation_id: "conv-1",
            payload: p,
            created_at: "",
            updated_at: "",
          }),
        }),
      );
      return { code, errors };
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
  }

  test("accepts title of exactly 120 characters", async () => {
    const title = "a".repeat(120);
    const { code } = await runAdd(JSON.stringify({ ...basePayload, title }));
    expect(code).toBe(0);
  });

  test("rejects title of 121 characters", async () => {
    const title = "a".repeat(121);
    const { code, errors } = await runAdd(
      JSON.stringify({ ...basePayload, title }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("1-120 characters");
  });

  test("accepts title that trims to exactly 120 characters (padded with spaces)", async () => {
    const title = `  ${"a".repeat(120)}  `;
    const { code } = await runAdd(JSON.stringify({ ...basePayload, title }));
    expect(code).toBe(0);
  });

  test("rejects whitespace-only title", async () => {
    const { code, errors } = await runAdd(
      JSON.stringify({ ...basePayload, title: "   " }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("1-120 characters");
  });

  test("rejects title that trims to 121 characters", async () => {
    const title = `  ${"a".repeat(121)}  `;
    const { code, errors } = await runAdd(
      JSON.stringify({ ...basePayload, title }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("1-120 characters");
  });

  test("accepts markdown of exactly 100000 characters", async () => {
    const markdown = "a".repeat(100_000);
    const { code } = await runAdd(
      JSON.stringify({ ...basePayload, title: "T", markdown }),
    );
    expect(code).toBe(0);
  });

  test("rejects markdown of 100001 characters", async () => {
    const markdown = "a".repeat(100_001);
    const { code, errors } = await runAdd(
      JSON.stringify({ ...basePayload, title: "T", markdown }),
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("100000 characters");
  });
});

describe("action validation before settings", () => {
  async function runWithTracking(argv: string[]): Promise<{
    code: number;
    errors: string[];
    settingsInitialized: boolean;
    apiCalled: boolean;
  }> {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg?: unknown) => errors.push(String(msg));
    let settingsInitialized = false;
    let apiCalled = false;
    const code = await runTraySubcommand(argv, {
      initializeSettings: async () => {
        settingsInitialized = true;
      },
      isLocalBackend: () => false,
      getLastSession: () => ({
        agentId: "agent-1",
        conversationId: "conv-1",
      }),
      listItems: async () => {
        apiCalled = true;
        return [];
      },
      createItem: async () => {
        apiCalled = true;
        return {
          id: "t1",
          agent_id: "agent-1",
          conversation_id: "conv-1",
          payload: JSON.parse(payload),
          created_at: "",
          updated_at: "",
        };
      },
    });
    console.error = originalError;
    return { code, errors, settingsInitialized, apiCalled };
  }

  test("unknown action errors immediately without calling settings or API", async () => {
    const { code, errors, settingsInitialized, apiCalled } =
      await runWithTracking(["zap"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Unknown Tray action: zap");
    expect(settingsInitialized).toBe(false);
    expect(apiCalled).toBe(false);
  });

  test("list with --tray-payload errors immediately without calling settings", async () => {
    const { code, errors, settingsInitialized } = await runWithTracking([
      "list",
      "--tray-payload",
      payload,
    ]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("list does not accept a Tray payload");
    expect(settingsInitialized).toBe(false);
  });

  test("update without item ID errors immediately without calling settings", async () => {
    const { code, errors, settingsInitialized } = await runWithTracking([
      "update",
      "--tray-payload",
      payload,
    ]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("update requires a Tray item ID");
    expect(settingsInitialized).toBe(false);
  });

  test("update rejects a whitespace-only item ID before settings", async () => {
    const { code, errors, settingsInitialized } = await runWithTracking([
      "update",
      "   ",
      "--tray-payload",
      payload,
    ]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("update requires a Tray item ID");
    expect(settingsInitialized).toBe(false);
  });

  test("add with item ID positional errors immediately", async () => {
    const { code, errors, settingsInitialized } = await runWithTracking([
      "add",
      "extra-item-id",
      "--tray-payload",
      payload,
    ]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("add does not accept a Tray item ID");
    expect(settingsInitialized).toBe(false);
  });

  test("too many positional arguments errors immediately", async () => {
    const { code, errors, settingsInitialized } = await runWithTracking([
      "list",
      "extra1",
      "extra2",
    ]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("too many positional arguments");
    expect(settingsInitialized).toBe(false);
  });
});

describe("Tray subcommand action contracts", () => {
  const trayItem: TrayItem = {
    id: "tray-1",
    agent_id: "agent-1",
    conversation_id: "conv-1",
    payload: {
      version: 1,
      type: "markdownlet",
      title: "Open PRs",
      markdown: "| PR | Status |",
    },
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
  };

  test("list succeeds and prints JSON items array", async () => {
    const outputs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => outputs.push(String(msg));
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["list"], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          listItems: async () => [trayItem],
        }),
      );
      expect(code).toBe(0);
      const result = JSON.parse(outputs.join("")) as { items: unknown[] };
      expect(result.items).toHaveLength(1);
      expect((result.items[0] as { id: string }).id).toBe("tray-1");
    } finally {
      console.log = originalLog;
    }
  });

  test("list preserves the Cloud conversation-not-found response", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg?: unknown) => errors.push(String(msg));
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["list"], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          listItems: async () => {
            throw new ApiRequestError(
              'API error (404): {"message":"Conversation not found"}',
              404,
              '{"message":"Conversation not found"}',
            );
          },
        }),
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("Conversation not found");
      expect(errors.join("\n")).not.toContain("only available on Letta Cloud");
    } finally {
      console.error = originalError;
    }
  });

  test("update succeeds and prints JSON item", async () => {
    const outputs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => outputs.push(String(msg));
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["update", "tray-1", "--tray-payload", payload], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          listItems: async () => [trayItem],
          updateItem: async () => trayItem,
        }),
      );
      expect(code).toBe(0);
      const result = JSON.parse(outputs.join("")) as { id: string };
      expect(result.id).toBe("tray-1");
    } finally {
      console.log = originalLog;
    }
  });

  test("delete succeeds and prints JSON success envelope", async () => {
    const outputs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => outputs.push(String(msg));
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["delete", "tray-1"], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          listItems: async () => [trayItem],
          deleteItem: async () => {},
        }),
      );
      expect(code).toBe(0);
      const result = JSON.parse(outputs.join("")) as {
        success: boolean;
        id: string;
      };
      expect(result.success).toBe(true);
      expect(result.id).toBe("tray-1");
    } finally {
      console.log = originalLog;
    }
  });

  test("delete propagates non-404 errors", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg?: unknown) => errors.push(String(msg));
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["delete", "tray-1"], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          listItems: async () => [trayItem],
          deleteItem: async () => {
            throw new Error("network failure");
          },
        }),
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("network failure");
    } finally {
      console.error = originalError;
    }
  });
});

describe("Tray subcommand", () => {
  test("help examples include complete agent and conversation scopes", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(await runTraySubcommand(["--help"])).toBe(0);
      const usageLines = output
        .join("\n")
        .split("\n")
        .filter((line) => line.trimStart().startsWith("letta tray"));
      expect(usageLines).toHaveLength(4);
      for (const line of usageLines) {
        expect(line).toContain("--agent <id>");
        expect(line).toContain("--conversation-id <id>");
      }
    } finally {
      console.log = originalLog;
    }
  });

  test("adds a validated markdownlet", async () => {
    const calls: unknown[] = [];
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(
          [
            "add",
            "--agent",
            "agent-1",
            "--conversation-id",
            "conv-1",
            "--tray-payload",
            payload,
          ],
          {
            initializeSettings: async () => {},
            isLocalBackend: () => false,
            getLastSession: () => null,
            listItems: async () => [],
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

  test("reads a versioned payload from a JSON file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "letta-tray-payload-"));
    const payloadPath = join(directory, "tray-item.json");
    writeFileSync(payloadPath, payload);
    let receivedPayload: unknown;
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["add", "--tray-payload-file", payloadPath], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          createItem: async (_, __, trayPayload) => {
            receivedPayload = trayPayload;
            return {
              id: "tray-file",
              agent_id: "agent-1",
              conversation_id: "conv-1",
              payload: trayPayload,
              created_at: "2026-09-18T00:00:00.000Z",
              updated_at: "2026-09-18T00:00:00.000Z",
            };
          },
        }),
      );
      expect(code).toBe(0);
      expect(receivedPayload).toEqual(JSON.parse(payload));
    } finally {
      console.log = originalLog;
      rmSync(directory, { recursive: true, force: true });
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
          isLocalBackend: () => false,
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
        isLocalBackend: () => true,
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

  test("Cloud session via localhost proxy proceeds when isLocalBackend is false", async () => {
    let listCalled = false;
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["list"], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          listItems: async () => {
            listCalled = true;
            return [];
          },
        }),
      );
      expect(code).toBe(0);
      expect(listCalled).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test("add skips list preflight and preserves the Cloud 404 response", async () => {
    const errors: string[] = [];
    let listCalled = false;
    const originalError = console.error;
    console.error = (msg?: unknown) => errors.push(String(msg));
    try {
      const code = await withEnvironment(() =>
        runTraySubcommand(["add", "--tray-payload", payload], {
          initializeSettings: async () => {},
          isLocalBackend: () => false,
          getLastSession: () => null,
          listItems: async () => {
            listCalled = true;
            return [];
          },
          createItem: async () => {
            throw new ApiRequestError(
              'API error (404): {"message":"Conversation not found"}',
              404,
              '{"message":"Conversation not found"}',
            );
          },
        }),
      );
      expect(code).toBe(1);
      expect(listCalled).toBe(false);
      expect(errors.join("\n")).toContain("Conversation not found");
      expect(errors.join("\n")).not.toContain("only available on Letta Cloud");
    } finally {
      console.error = originalError;
    }
  });
});
