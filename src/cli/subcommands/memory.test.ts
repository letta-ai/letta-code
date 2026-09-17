import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runMemorySubcommand } from "@/cli/subcommands/memory";

describe("letta memory pull", () => {
  const originalLog = console.log;
  const originalError = console.error;
  let logs: string[] = [];
  let errors: string[] = [];

  beforeEach(() => {
    logs = [];
    errors = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test("initializes settings before pullMemory (issue #4499)", async () => {
    const order: string[] = [];
    const pulledAgents: string[] = [];
    const initializeSettings = mock(async () => {
      order.push("initialize");
    });
    const pullMemory = mock(async (agentId: string) => {
      order.push("pull");
      pulledAgents.push(agentId);
      return { updated: false, summary: "Already up to date" };
    });

    const code = await runMemorySubcommand(["pull", "--agent", "agent-repro"], {
      initializeSettings,
      isGitRepo: () => true,
      isLocalBackendEnvEnabled: () => false,
      pullMemory,
    });

    expect(code).toBe(0);
    expect(order).toEqual(["initialize", "pull"]);
    expect(initializeSettings).toHaveBeenCalledTimes(1);
    expect(pullMemory).toHaveBeenCalledTimes(1);
    expect(pulledAgents).toEqual(["agent-repro"]);
    expect(JSON.parse(logs.join("\n"))).toEqual({
      updated: false,
      summary: "Already up to date",
    });
  });

  test("surfaces initialize failures instead of crashing later in pullMemory", async () => {
    const pullMemory = mock(async () => ({
      updated: false,
      summary: "should not run",
    }));

    const code = await runMemorySubcommand(["pull", "--agent", "agent-repro"], {
      initializeSettings: async () => {
        throw new Error(
          "Settings not initialized. Call settingsManager.initialize() first.",
        );
      },
      isGitRepo: () => true,
      isLocalBackendEnvEnabled: () => false,
      pullMemory,
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Settings not initialized");
    expect(pullMemory).not.toHaveBeenCalled();
  });

  test("does not initialize settings for local-backend pull", async () => {
    const initializeSettings = mock(async () => {});
    const pullMemory = mock(async () => ({
      updated: true,
      summary: "should not run",
    }));

    const code = await runMemorySubcommand(["pull", "--agent", "agent-repro"], {
      initializeSettings,
      isGitRepo: () => true,
      isLocalBackendEnvEnabled: () => true,
      pullMemory,
    });

    expect(code).toBe(0);
    expect(initializeSettings).not.toHaveBeenCalled();
    expect(pullMemory).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join("\n")).updated).toBe(false);
  });
});
