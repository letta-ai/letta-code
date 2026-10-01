import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runMemorySubcommand } from "@/cli/subcommands/memory";

describe("letta memory pull", () => {
  const agentId = "agent-00000000-0000-4000-8000-000000000001";
  let priorLocalBackend: string | undefined;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    priorLocalBackend = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (priorLocalBackend !== undefined) {
      process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = priorLocalBackend;
    } else {
      delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    }
  });

  test("initializes settings before pulling memory", async () => {
    // Regression guard for `letta memory pull` exiting with
    // "Settings not initialized. Call settingsManager.initialize() first."
    // Subcommands run before the main CLI bootstrap initializes settings, and
    // pullMemory resolves the backend auth token through getSettings().
    const calls: string[] = [];
    let settingsInitialized = false;

    const code = await runMemorySubcommand(["pull", "--agent", agentId], {
      isGitRepo: () => true,
      initializeSettings: async () => {
        await Promise.resolve();
        settingsInitialized = true;
        calls.push("initializeSettings");
      },
      pullMemory: async (id) => {
        calls.push("pullMemory");
        if (!settingsInitialized) {
          throw new Error(
            "Settings not initialized. Call settingsManager.initialize() first.",
          );
        }
        expect(id).toBe(agentId);
        return { updated: true, summary: "Fast-forwarded 1 commit." };
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual(["initializeSettings", "pullMemory"]);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        { updated: true, summary: "Fast-forwarded 1 commit." },
        null,
        2,
      ),
    );
  });

  test("does not initialize settings when memory is not a git repo", async () => {
    let initialized = false;

    const code = await runMemorySubcommand(["pull", "--agent", agentId], {
      isGitRepo: () => false,
      initializeSettings: async () => {
        initialized = true;
      },
      pullMemory: async () => {
        throw new Error("pullMemory must not run for a non-git memory dir");
      },
    });

    expect(code).toBe(1);
    expect(initialized).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "Not a git repo. Enable git-backed memory first.",
    );
  });

  test("does not initialize settings for the local backend short-circuit", async () => {
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    let initialized = false;

    const code = await runMemorySubcommand(["pull", "--agent", agentId], {
      isGitRepo: () => true,
      initializeSettings: async () => {
        initialized = true;
      },
      pullMemory: async () => {
        throw new Error("pullMemory must not run for the local backend");
      },
    });

    expect(code).toBe(0);
    expect(initialized).toBe(false);
  });
});
