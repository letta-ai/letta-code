import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandHookConfig, HookCommand } from "@/hooks/types";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";

// Type-safe helper to extract command from a hook (tests only use command hooks)
function asCommand(
  hook: HookCommand | undefined,
): CommandHookConfig | undefined {
  if (hook && hook.type === "command") {
    return hook as CommandHookConfig;
  }
  return undefined;
}

import {
  __setSecretGetOverrideForTests,
  deleteSecureTokens,
  isKeychainAvailable,
  setServiceName,
} from "@/utils/secrets.js";

const keychainAvailablePrecompute = await isKeychainAvailable();

// Store original HOME to restore after tests
const originalHome = process.env.HOME;
const originalLocalBackendFlag = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
let testHomeDir: string;
let testProjectDir: string;

beforeEach(async () => {
  // Use a test-specific keychain service name to avoid deleting real credentials
  setServiceName("letta-code-test");

  // Reset settings manager FIRST before changing HOME
  await settingsManager.reset();

  // Create temporary directories for testing
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-test-home-"));
  testProjectDir = await mkdtemp(join(tmpdir(), "letta-test-project-"));

  // Override HOME for tests (must be done BEFORE initialize is called)
  process.env.HOME = testHomeDir;
  delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
});

afterEach(async () => {
  // Wait for all pending writes to complete BEFORE restoring HOME
  // This prevents test writes from leaking into real settings after HOME is restored
  await settingsManager.reset();

  // Clean up test directories
  await rm(testHomeDir, { recursive: true, force: true });
  await rm(testProjectDir, { recursive: true, force: true });

  // Restore original HOME AFTER reset completes
  process.env.HOME = originalHome;
  if (originalLocalBackendFlag === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  } else {
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = originalLocalBackendFlag;
  }
  if (originalLocalBackendDir === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
  }

  // Restore the real service name
  setServiceName("letta-code");
});

// ============================================================================
// Initialization Tests
// ============================================================================

describe("Settings Manager - Initialization", () => {
  test("Initialize makes settings accessible", async () => {
    await settingsManager.initialize();

    // Settings should be accessible immediately after initialization
    const settings = settingsManager.getSettings();
    expect(settings).toBeDefined();
    expect(typeof settings.tokenStreaming).toBe("boolean");
  });

  test("Initialize loads existing settings from disk", async () => {
    // First initialize and set some settings
    await settingsManager.initialize();
    settingsManager.updateSettings({
      tokenStreaming: true,
      lastAgent: "agent-123",
    });

    // Wait for persist to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reset and re-initialize
    await settingsManager.reset();
    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true);
    expect(settings.lastAgent).toBe("agent-123");
  });

  test("Initialize only runs once", async () => {
    await settingsManager.initialize();
    const settings1 = settingsManager.getSettings();

    // Call initialize again
    await settingsManager.initialize();
    const settings2 = settingsManager.getSettings();

    // Should be same instance
    expect(settings1).toEqual(settings2);
  });

  test("Throws error if accessing settings before initialization", () => {
    expect(() => settingsManager.getSettings()).toThrow(
      "Settings not initialized",
    );
  });

  test("Initialize tolerates legacy reflectionBehavior key and strips it on persist", async () => {
    const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");

    await writeFile(
      settingsPath,
      JSON.stringify({
        reflectionBehavior: "reminder",
        reflectionTrigger: "step-count",
        reflectionStepCount: 12,
      }),
    );

    await settingsManager.initialize();
    const settings = settingsManager.getSettings() as unknown as Record<
      string,
      unknown
    >;
    expect(settings.reflectionTrigger).toBe("step-count");
    expect(settings.reflectionStepCount).toBe(12);
    expect(settings).not.toHaveProperty("reflectionBehavior");

    settingsManager.updateSettings({ tokenStreaming: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const persisted = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("reflectionBehavior");
  });
});

// ============================================================================
// Global Settings Tests
// ============================================================================

describe("Settings Manager - Global Settings", () => {
  let keychainSupported: boolean = false;

  beforeEach(async () => {
    await settingsManager.initialize();
    // Check if secrets are available on this system
    keychainSupported = await isKeychainAvailable();

    if (keychainSupported) {
      // Clean up any existing test tokens
      await deleteSecureTokens();
    }
  });

  afterEach(async () => {
    if (keychainSupported) {
      // Clean up after each test
      await deleteSecureTokens();
    }
  });

  test("Get settings returns a copy", () => {
    const settings1 = settingsManager.getSettings();
    const settings2 = settingsManager.getSettings();

    expect(settings1).toEqual(settings2);
    expect(settings1).not.toBe(settings2); // Different object instances
  });

  test("Get specific setting", () => {
    settingsManager.updateSettings({ tokenStreaming: true });

    const tokenStreaming = settingsManager.getSetting("tokenStreaming");
    expect(tokenStreaming).toBe(true);
  });

  test("Worktree tool defaults on and can be toggled", () => {
    expect(settingsManager.getSetting("includeWorktreeTool")).toBe(true);
    expect(settingsManager.shouldIncludeWorktreeTool()).toBe(true);

    settingsManager.setIncludeWorktreeTool(false);
    expect(settingsManager.getSetting("includeWorktreeTool")).toBe(false);
    expect(settingsManager.shouldIncludeWorktreeTool()).toBe(false);

    settingsManager.setIncludeWorktreeTool(true);
    expect(settingsManager.getSetting("includeWorktreeTool")).toBe(true);
    expect(settingsManager.shouldIncludeWorktreeTool()).toBe(true);
  });

  test("Update single setting", () => {
    // Verify initial state first
    const initialSettings = settingsManager.getSettings();
    const initialLastAgent = initialSettings.lastAgent;

    settingsManager.updateSettings({ tokenStreaming: true });

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true);
    expect(settings.lastAgent).toBe(initialLastAgent); // Other settings unchanged
  });

  test("Update multiple settings", () => {
    settingsManager.updateSettings({
      tokenStreaming: true,
      lastAgent: "agent-456",
      enableSleeptime: true,
    });

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true);
    expect(settings.lastAgent).toBe("agent-456");
    expect(settings.enableSleeptime).toBe(true);
  });

  test("Update env variables", () => {
    settingsManager.updateSettings({
      env: {
        LETTA_API_KEY: "sk-test-123",
        CUSTOM_VAR: "value",
      },
    });

    const settings = settingsManager.getSettings();
    // LETTA_API_KEY should not be in settings file (moved to keychain)
    expect(settings.env).toEqual({
      CUSTOM_VAR: "value",
    });
  });

  test.skipIf(!keychainAvailablePrecompute)(
    "Get settings with secure tokens (async method)",
    async () => {
      // This test verifies the async method that includes keychain tokens
      settingsManager.updateSettings({
        env: {
          LETTA_API_KEY: "sk-test-async-123",
          CUSTOM_VAR: "async-value",
        },
        refreshToken: "rt-test-refresh",
        tokenExpiresAt: Date.now() + 3600000,
      });

      const settingsWithTokens =
        await settingsManager.getSettingsWithSecureTokens();

      // Should include the environment variables and other settings
      expect(settingsWithTokens.env?.CUSTOM_VAR).toBe("async-value");
      expect(typeof settingsWithTokens.tokenExpiresAt).toBe("number");
    },
  );

  test("runtime-scoped lookups reuse cached secure tokens without re-reading secrets", async () => {
    const originalIsKeychainAvailable =
      settingsManager.isKeychainAvailable.bind(settingsManager);

    try {
      settingsManager.isKeychainAvailable = async () => true;
      __setSecretGetOverrideForTests(async ({ name }) => {
        if (name === "letta-api-key") {
          return "sk-runtime-cache";
        }
        if (name === "letta-refresh-token") {
          return "rt-runtime-cache";
        }
        return null;
      });

      const initialSettings =
        await settingsManager.getSettingsWithSecureTokens();
      expect(initialSettings.env?.LETTA_API_KEY).toBe("sk-runtime-cache");
      expect(initialSettings.refreshToken).toBe("rt-runtime-cache");

      __setSecretGetOverrideForTests(async () => {
        throw new Error("runtime-scoped lookup should reuse cached tokens");
      });

      const runtimeSettings = await runWithRuntimeContext(
        { agentId: "agent-runtime-test" },
        () => settingsManager.getSettingsWithSecureTokens(),
      );

      expect(runtimeSettings.env?.LETTA_API_KEY).toBe("sk-runtime-cache");
      expect(runtimeSettings.refreshToken).toBe("rt-runtime-cache");
    } finally {
      settingsManager.isKeychainAvailable = originalIsKeychainAvailable;
      __setSecretGetOverrideForTests(null);
    }
  });

  test("LETTA_BASE_URL should not be cached in settings", () => {
    // This test verifies that LETTA_BASE_URL is NOT persisted to settings
    // It should only come from environment variables
    settingsManager.updateSettings({
      env: {
        LETTA_API_KEY: "sk-test-123",
        // LETTA_BASE_URL should not be included here
      },
    });

    const settings = settingsManager.getSettings();
    expect(settings.env?.LETTA_BASE_URL).toBeUndefined();
  });

  test("Settings persist to disk", async () => {
    settingsManager.updateSettings({
      tokenStreaming: true,
      lastAgent: "agent-789",
    });

    // Wait for async persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reset and reload
    await settingsManager.reset();
    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true);
    expect(settings.lastAgent).toBe("agent-789");
  });
});

// ============================================================================
// Project Settings Tests (.letta/settings.json)
// ============================================================================

describe("Settings Manager - Project Settings", () => {
  beforeEach(async () => {
    await settingsManager.initialize();
  });

  test("Load project settings creates defaults if none exist", async () => {
    const projectSettings =
      await settingsManager.loadProjectSettings(testProjectDir);

    expect(projectSettings.hooks).toBeUndefined();
    expect(projectSettings.windowTitle).toBeUndefined();
  });

  test("Get project settings returns cached value", async () => {
    await settingsManager.loadProjectSettings(testProjectDir);

    const settings1 = settingsManager.getProjectSettings(testProjectDir);
    const settings2 = settingsManager.getProjectSettings(testProjectDir);

    expect(settings1).toEqual(settings2);
    expect(settings1).not.toBe(settings2); // Different instances
  });

  test("Update project settings", async () => {
    await settingsManager.loadProjectSettings(testProjectDir);

    settingsManager.updateProjectSettings(
      {
        windowTitle: { items: ["agent-name"] },
      },
      testProjectDir,
    );

    const settings = settingsManager.getProjectSettings(testProjectDir);
    expect(settings.windowTitle?.items).toEqual(["agent-name"]);
  });

  test("Project settings persist to disk", async () => {
    await settingsManager.loadProjectSettings(testProjectDir);

    settingsManager.updateProjectSettings(
      {
        windowTitle: { items: ["agent-name", "model-name"] },
      },
      testProjectDir,
    );

    // Wait for persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clear cache and reload
    await settingsManager.reset();
    await settingsManager.initialize();
    const reloaded = await settingsManager.loadProjectSettings(testProjectDir);

    expect(reloaded.windowTitle?.items).toEqual(["agent-name", "model-name"]);
  });

  test("Throw error if accessing project settings before loading", async () => {
    expect(() => settingsManager.getProjectSettings(testProjectDir)).toThrow(
      "Project settings for",
    );
  });

  test("When cwd is HOME, project settings resolve to defaults (no global collision)", async () => {
    await settingsManager.initialize();

    // Seed a global windowTitle config in ~/.letta/settings.json
    settingsManager.updateSettings({
      windowTitle: { items: ["agent-name"] },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const projectSettings =
      await settingsManager.loadProjectSettings(testHomeDir);
    expect(projectSettings.hooks).toBeUndefined();
    expect(projectSettings.windowTitle).toBeUndefined();
  });

  test("When cwd is HOME, project hook/windowTitle updates route to global settings", async () => {
    await settingsManager.initialize();

    // Load project settings for HOME (will be defaults due to collision guard)
    await settingsManager.loadProjectSettings(testHomeDir);

    settingsManager.updateProjectSettings(
      {
        windowTitle: { items: ["agent-name", "model-name"] },
        hooks: {
          Notification: [
            {
              hooks: [{ type: "command", command: "echo routed-hook" }],
            },
          ],
        },
      },
      testHomeDir,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    const globalSettings = settingsManager.getSettings();
    expect(globalSettings.windowTitle?.items).toEqual([
      "agent-name",
      "model-name",
    ]);
    expect(
      asCommand(globalSettings.hooks?.Notification?.[0]?.hooks[0])?.command,
    ).toBe("echo routed-hook");

    // Ensure project-only field is not written into global file by this route
    expect(globalSettings).not.toHaveProperty("localSharedBlockIds");
  });
});

// ============================================================================
// Local Project Settings Tests (.letta/settings.local.json)
// ============================================================================

describe("Settings Manager - Local Project Settings", () => {
  beforeEach(async () => {
    await settingsManager.initialize();
  });

  test("Load local project settings creates defaults if none exist", async () => {
    const localSettings =
      await settingsManager.loadLocalProjectSettings(testProjectDir);

    expect(localSettings.lastAgent).toBe(null);
  });

  test("Load local settings tolerates legacy reflectionBehavior key and strips it", async () => {
    const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testProjectDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.local.json");

    await writeFile(
      settingsPath,
      JSON.stringify({
        lastAgent: "agent-local-legacy",
        reflectionBehavior: "reminder",
        reflectionTrigger: "step-count",
        reflectionStepCount: 9,
      }),
    );

    const localSettings =
      await settingsManager.loadLocalProjectSettings(testProjectDir);
    expect(localSettings.lastAgent).toBe("agent-local-legacy");
    expect(localSettings).not.toHaveProperty("reflectionBehavior");

    const persisted = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("reflectionBehavior");
  });

  test("Get local project settings returns cached value", async () => {
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    const settings1 = settingsManager.getLocalProjectSettings(testProjectDir);
    const settings2 = settingsManager.getLocalProjectSettings(testProjectDir);

    expect(settings1).toEqual(settings2);
    expect(settings1).not.toBe(settings2);
  });

  test("Update local project settings - last agent", async () => {
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    settingsManager.updateLocalProjectSettings(
      { lastAgent: "agent-local-1" },
      testProjectDir,
    );

    const settings = settingsManager.getLocalProjectSettings(testProjectDir);
    expect(settings.lastAgent).toBe("agent-local-1");
  });

  test("Update local project settings - permissions", async () => {
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    settingsManager.updateLocalProjectSettings(
      {
        permissions: {
          allow: ["Bash(ls:*)"],
          deny: ["Read(.env)"],
        },
      },
      testProjectDir,
    );

    const settings = settingsManager.getLocalProjectSettings(testProjectDir);
    expect(settings.permissions).toEqual({
      allow: ["Bash(ls:*)"],
      deny: ["Read(.env)"],
    });
  });

  test("Local project settings persist to disk", async () => {
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    settingsManager.updateLocalProjectSettings(
      {
        lastAgent: "agent-persist-1",
        permissions: {
          allow: ["Bash(*)"],
        },
      },
      testProjectDir,
    );

    // Wait for persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clear cache and reload
    await settingsManager.reset();
    await settingsManager.initialize();
    const reloaded =
      await settingsManager.loadLocalProjectSettings(testProjectDir);

    expect(reloaded.lastAgent).toBe("agent-persist-1");
    expect(reloaded.permissions).toEqual({
      allow: ["Bash(*)"],
    });
  });

  test("Throw error if accessing local project settings before loading", async () => {
    expect(() =>
      settingsManager.getLocalProjectSettings(testProjectDir),
    ).toThrow("Local project settings for");
  });
});

// ============================================================================
// Multiple Projects Tests
// ============================================================================

describe("Settings Manager - Multiple Projects", () => {
  let testProjectDir2: string;

  beforeEach(async () => {
    await settingsManager.initialize();
    testProjectDir2 = await mkdtemp(join(tmpdir(), "letta-test-project2-"));
  });

  afterEach(async () => {
    await rm(testProjectDir2, { recursive: true, force: true });
  });

  test("Can manage settings for multiple projects independently", async () => {
    // Load settings for both projects
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    await settingsManager.loadLocalProjectSettings(testProjectDir2);

    // Update different values
    settingsManager.updateLocalProjectSettings(
      { lastAgent: "agent-project-1" },
      testProjectDir,
    );
    settingsManager.updateLocalProjectSettings(
      { lastAgent: "agent-project-2" },
      testProjectDir2,
    );

    // Verify independence
    const settings1 = settingsManager.getLocalProjectSettings(testProjectDir);
    const settings2 = settingsManager.getLocalProjectSettings(testProjectDir2);

    expect(settings1.lastAgent).toBe("agent-project-1");
    expect(settings2.lastAgent).toBe("agent-project-2");
  });

  test("Project settings are cached separately", async () => {
    await settingsManager.loadProjectSettings(testProjectDir);
    await settingsManager.loadProjectSettings(testProjectDir2);

    settingsManager.updateProjectSettings(
      { windowTitle: { items: ["agent-name"] } },
      testProjectDir,
    );
    settingsManager.updateProjectSettings(
      { windowTitle: { items: ["model-name"] } },
      testProjectDir2,
    );

    const settings1 = settingsManager.getProjectSettings(testProjectDir);
    const settings2 = settingsManager.getProjectSettings(testProjectDir2);

    expect(settings1.windowTitle?.items).toEqual(["agent-name"]);
    expect(settings2.windowTitle?.items).toEqual(["model-name"]);
  });
});

describe("Settings Manager - Session Persistence", () => {
  test("persistSession skips unchanged session writes", async () => {
    await settingsManager.initialize();
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    settingsManager.persistSession(
      "agent-session",
      "conv-session",
      testProjectDir,
    );
    await settingsManager.flush();

    const globalSettingsPath = join(testHomeDir, ".letta", "settings.json");
    const localSettingsPath = join(
      testProjectDir,
      ".letta",
      "settings.local.json",
    );
    const firstGlobalMtime = (await stat(globalSettingsPath)).mtimeMs;
    const firstLocalMtime = (await stat(localSettingsPath)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    settingsManager.persistSession(
      "agent-session",
      "conv-session",
      testProjectDir,
    );
    await settingsManager.flush();

    expect((await stat(globalSettingsPath)).mtimeMs).toBe(firstGlobalMtime);
    expect((await stat(localSettingsPath)).mtimeMs).toBe(firstLocalMtime);
  });
});

// ============================================================================
// Reset Tests
// ============================================================================

describe("Settings Manager - Reset", () => {
  test("Reset clears all cached data", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({ lastAgent: "agent-reset-test" });

    await settingsManager.reset();

    // Should throw error after reset
    expect(() => settingsManager.getSettings()).toThrow();
  });

  test("Can reinitialize after reset", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({ tokenStreaming: true });

    // Wait for persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    await settingsManager.reset();
    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true);
  });

  test("Reset clears managedKeys so stale keys don't leak into next session", async () => {
    const { writeFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });

    // First session: write a setting that will be tracked in managedKeys
    await settingsManager.initialize();
    settingsManager.updateSettings({ lastAgent: "agent-first-session" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settingsManager.reset();

    // Second session: write a completely fresh file with a different key
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({ tokenStreaming: true }),
    );
    await settingsManager.initialize();

    // After re-init, managedKeys should only contain keys from the new file.
    // Persisting should write tokenStreaming but NOT ghost-write lastAgent from
    // the previous session's managedKeys.
    settingsManager.updateSettings({ enableSleeptime: false });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await settingsManager.reset();
    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true);
    // lastAgent was only set in the first session — should not reappear
    expect(settings.lastAgent).toBeNull();
  });
});

// ============================================================================
// Hooks Configuration Tests
// ============================================================================

describe("Settings Manager - Hooks", () => {
  beforeEach(async () => {
    await settingsManager.initialize();
  });

  test("Update hooks configuration in global settings", async () => {
    settingsManager.updateSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo test" }],
          },
        ],
      },
    });

    const settings = settingsManager.getSettings();
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks?.PreToolUse).toHaveLength(1);
    expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
  });

  test("Hooks configuration persists to disk", async () => {
    settingsManager.updateSettings({
      hooks: {
        // Tool event with HookMatcher[]
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "echo persisted" }],
          },
        ],
        // Simple event with SimpleHookMatcher[]
        SessionStart: [
          { hooks: [{ type: "command", command: "echo session" }] },
        ],
      },
    });

    // Wait for async persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reset and reload
    await settingsManager.reset();
    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    expect(settings.hooks?.PreToolUse).toHaveLength(1);
    expect(asCommand(settings.hooks?.PreToolUse?.[0]?.hooks[0])?.command).toBe(
      "echo persisted",
    );
    expect(settings.hooks?.SessionStart).toHaveLength(1);
  });

  test("Update hooks in local project settings with patterns", async () => {
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    settingsManager.updateLocalProjectSettings(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [{ type: "command", command: "echo post-tool" }],
            },
          ],
        },
      },
      testProjectDir,
    );

    const localSettings =
      settingsManager.getLocalProjectSettings(testProjectDir);
    expect(localSettings.hooks?.PostToolUse).toHaveLength(1);
    expect(localSettings.hooks?.PostToolUse?.[0]?.matcher).toBe("Write|Edit");
  });

  test("Update hooks in local project settings", async () => {
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    settingsManager.updateLocalProjectSettings(
      {
        hooks: {
          // Simple event uses SimpleHookMatcher[] (hooks wrapper)
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "echo local-hook" }] },
          ],
        },
      },
      testProjectDir,
    );

    const localSettings =
      settingsManager.getLocalProjectSettings(testProjectDir);
    expect(localSettings.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  test("Local project hooks persist to disk", async () => {
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    settingsManager.updateLocalProjectSettings(
      {
        hooks: {
          // Simple event uses SimpleHookMatcher[] (hooks wrapper)
          Stop: [{ hooks: [{ type: "command", command: "echo stop-hook" }] }],
        },
      },
      testProjectDir,
    );

    // Wait for persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clear cache and reload
    await settingsManager.reset();
    await settingsManager.initialize();
    const reloaded =
      await settingsManager.loadLocalProjectSettings(testProjectDir);

    expect(reloaded.hooks?.Stop).toHaveLength(1);
    // Simple event hooks are in SimpleHookMatcher format with hooks array
    expect(asCommand(reloaded.hooks?.Stop?.[0]?.hooks[0])?.command).toBe(
      "echo stop-hook",
    );
  });

  test("All 10 hook event types can be configured", async () => {
    const allHookEvents = [
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "UserPromptSubmit",
      "Notification",
      "Stop",
      "SubagentStop",
      "PreCompact",
      "SessionStart",
      "SessionEnd",
    ] as const;

    const hooksConfig: Record<string, unknown[]> = {};
    for (const event of allHookEvents) {
      hooksConfig[event] = [
        {
          matcher: "*",
          hooks: [{ type: "command", command: `echo ${event}` }],
        },
      ];
    }

    settingsManager.updateSettings({
      hooks: hooksConfig as never,
    });

    const settings = settingsManager.getSettings();
    for (const event of allHookEvents) {
      expect(settings.hooks?.[event]).toHaveLength(1);
    }
  });

  test("Partial hooks update preserves other hooks", async () => {
    settingsManager.updateSettings({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "echo pre" }] },
        ],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "echo post" }] },
        ],
      },
    });

    // Update only PreToolUse
    settingsManager.updateSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo updated" }],
          },
        ],
      },
    });

    const settings = settingsManager.getSettings();
    // PreToolUse should be updated (replaced)
    expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe("Bash");
    // Note: This test documents current behavior - hooks object is replaced entirely
  });
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe("Settings Manager - Edge Cases", () => {
  test("Handles corrupted settings file gracefully", async () => {
    // Create corrupted settings file
    const { writeFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.json"), "{ invalid json");

    // Should fall back to defaults
    await settingsManager.initialize();
    const settings = settingsManager.getSettings();

    // Should have default values (not corrupt)
    expect(settings).toBeDefined();
    expect(settings.tokenStreaming).toBeDefined();
    expect(typeof settings.tokenStreaming).toBe("boolean");
  });

  test("Modifying returned settings doesn't affect internal state", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      lastAgent: "agent-123",
      tokenStreaming: true,
    });

    const settings = settingsManager.getSettings();
    settings.lastAgent = "modified-agent";
    settings.tokenStreaming = false;

    // Internal state should be unchanged
    const actualSettings = settingsManager.getSettings();
    expect(actualSettings.lastAgent).toBe("agent-123");
    expect(actualSettings.tokenStreaming).toBe(true);
  });

  test("Partial updates preserve existing values", async () => {
    await settingsManager.initialize();

    settingsManager.updateSettings({
      tokenStreaming: true,
      lastAgent: "agent-1",
      enableSleeptime: true,
    });

    // Partial update
    settingsManager.updateSettings({
      lastAgent: "agent-2",
    });

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true); // Preserved
    expect(settings.enableSleeptime).toBe(true); // Preserved
    expect(settings.lastAgent).toBe("agent-2"); // Updated
  });
});

// ============================================================================
// Agents Array Migration Tests
// ============================================================================

describe("Settings Manager - Agents Array Migration", () => {
  const originalSubagentRole = process.env.LETTA_CODE_AGENT_ROLE;

  afterEach(() => {
    if (originalSubagentRole === undefined) {
      delete process.env.LETTA_CODE_AGENT_ROLE;
    } else {
      process.env.LETTA_CODE_AGENT_ROLE = originalSubagentRole;
    }
  });

  test.skipIf(!keychainAvailablePrecompute)(
    "Subagent process skips token migration to secrets",
    async () => {
      const { writeFile, mkdir } = await import("@/utils/fs.js");
      const settingsDir = join(testHomeDir, ".letta");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          refreshToken: "rt-subagent-should-stay",
          env: {
            LETTA_API_KEY: "sk-subagent-should-stay",
          },
        }),
      );

      process.env.LETTA_CODE_AGENT_ROLE = "subagent";

      await settingsManager.initialize();
      const settings = settingsManager.getSettings();

      expect(settings.refreshToken).toBe("rt-subagent-should-stay");
      expect(settings.env?.LETTA_API_KEY).toBe("sk-subagent-should-stay");
    },
  );

  test("Migrates from pinnedAgents (oldest legacy format)", async () => {
    // Setup: Write old format to disk
    const { writeFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        pinnedAgents: ["agent-old-1", "agent-old-2"],
        tokenStreaming: true,
      }),
    );

    await settingsManager.initialize();
    const settings = settingsManager.getSettings();

    // Should have migrated to agents array
    expect(settings.agents).toBeDefined();
    expect(settings.agents).toHaveLength(2);
    expect(settings.agents?.[0]).toEqual({
      agentId: "agent-old-1",
      pinned: true,
    });
    expect(settings.agents?.[1]).toEqual({
      agentId: "agent-old-2",
      pinned: true,
    });
    // Legacy field should still exist for downgrade compat
    expect(settings.pinnedAgents).toEqual(["agent-old-1", "agent-old-2"]);
  });

  test("Migrates from pinnedAgentsByServer (newer legacy format)", async () => {
    const { writeFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        pinnedAgentsByServer: {
          "api.letta.com": ["agent-cloud-1"],
          "localhost:8283": ["agent-local-1", "agent-local-2"],
        },
      }),
    );

    await settingsManager.initialize();
    const settings = settingsManager.getSettings();

    expect(settings.agents).toHaveLength(3);
    // Cloud agents have no baseUrl (or undefined)
    expect(settings.agents).toContainEqual({
      agentId: "agent-cloud-1",
      pinned: true,
    });
    // Local agents have baseUrl
    expect(settings.agents).toContainEqual({
      agentId: "agent-local-1",
      baseUrl: "localhost:8283",
      pinned: true,
    });
    expect(settings.agents).toContainEqual({
      agentId: "agent-local-2",
      baseUrl: "localhost:8283",
      pinned: true,
    });
  });

  test("Migrates from both legacy formats (deduplicated)", async () => {
    const { writeFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        pinnedAgents: ["agent-1", "agent-2"], // Old old format
        pinnedAgentsByServer: {
          "api.letta.com": ["agent-1", "agent-3"], // agent-1 is duplicate
        },
      }),
    );

    await settingsManager.initialize();
    const settings = settingsManager.getSettings();

    // Should have 3 agents (agent-1 deduped)
    expect(settings.agents).toHaveLength(3);
    const agentIds = settings.agents?.map((a) => a.agentId);
    expect(agentIds).toContain("agent-1");
    expect(agentIds).toContain("agent-2");
    expect(agentIds).toContain("agent-3");
  });

  test("Already migrated settings are not re-migrated", async () => {
    const { writeFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        agents: [{ agentId: "agent-new", pinned: true, memfs: true }],
        pinnedAgentsByServer: {
          "api.letta.com": ["agent-old"], // Should be ignored since agents exists
        },
      }),
    );

    await settingsManager.initialize();
    const settings = settingsManager.getSettings();

    // Should only have the new format agent
    expect(settings.agents).toHaveLength(1);
    expect(settings.agents?.[0]?.agentId).toBe("agent-new");
    expect(settings.agents?.[0]?.memfs).toBe(true);
  });

  test("isMemfsEnabled returns false for agents without memfs flag", async () => {
    await settingsManager.initialize();

    // Manually set up agents array
    settingsManager.updateSettings({
      agents: [
        { agentId: "agent-with-memfs", pinned: true, memfs: true },
        { agentId: "agent-without-memfs", pinned: true },
      ],
    });

    expect(settingsManager.isMemfsEnabled("agent-with-memfs")).toBe(true);
    expect(settingsManager.isMemfsEnabled("agent-without-memfs")).toBe(false);
    expect(settingsManager.isMemfsEnabled("agent-unknown")).toBe(false);
  });

  test("setMemfsEnabled adds/removes memfs flag", async () => {
    await settingsManager.initialize();

    settingsManager.setMemfsEnabled("agent-test", true);
    expect(settingsManager.isMemfsEnabled("agent-test")).toBe(true);

    settingsManager.setMemfsEnabled("agent-test", false);
    expect(settingsManager.isMemfsEnabled("agent-test")).toBe(false);
  });

  test("isMemfsEnabled uses LETTA_MEMFS_BASE_URL before LETTA_BASE_URL", async () => {
    await settingsManager.initialize();

    settingsManager.updateSettings({
      agents: [
        {
          agentId: "agent-memfs-url",
          baseUrl: "selfhost.example.com",
          memfs: true,
        },
      ],
    });

    const originalBaseUrl = process.env.LETTA_BASE_URL;
    const originalMemfsBaseUrl = process.env.LETTA_MEMFS_BASE_URL;
    process.env.LETTA_BASE_URL = "http://localhost:54085";
    process.env.LETTA_MEMFS_BASE_URL = "https://selfhost.example.com";

    try {
      expect(settingsManager.isMemfsEnabled("agent-memfs-url")).toBe(true);
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.LETTA_BASE_URL;
      } else {
        process.env.LETTA_BASE_URL = originalBaseUrl;
      }
      if (originalMemfsBaseUrl === undefined) {
        delete process.env.LETTA_MEMFS_BASE_URL;
      } else {
        process.env.LETTA_MEMFS_BASE_URL = originalMemfsBaseUrl;
      }
    }
  });

  test("isMemfsEnabled ignores LETTA_BASE_URL when LETTA_MEMFS_BASE_URL is unset", async () => {
    await settingsManager.initialize();

    settingsManager.updateSettings({
      agents: [
        { agentId: "agent-cloud-memfs", memfs: true },
        {
          agentId: "agent-local-memfs",
          baseUrl: "localhost:54085",
          memfs: true,
        },
      ],
    });

    const originalBaseUrl = process.env.LETTA_BASE_URL;
    const originalMemfsBaseUrl = process.env.LETTA_MEMFS_BASE_URL;
    process.env.LETTA_BASE_URL = "http://localhost:54085";
    delete process.env.LETTA_MEMFS_BASE_URL;

    try {
      expect(settingsManager.isMemfsEnabled("agent-cloud-memfs")).toBe(true);
      expect(settingsManager.isMemfsEnabled("agent-local-memfs")).toBe(false);
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.LETTA_BASE_URL;
      } else {
        process.env.LETTA_BASE_URL = originalBaseUrl;
      }
      if (originalMemfsBaseUrl === undefined) {
        delete process.env.LETTA_MEMFS_BASE_URL;
      } else {
        process.env.LETTA_MEMFS_BASE_URL = originalMemfsBaseUrl;
      }
    }
  });

  test("setMemfsEnabled stores agent settings under LETTA_MEMFS_BASE_URL server key", async () => {
    await settingsManager.initialize();

    const originalBaseUrl = process.env.LETTA_BASE_URL;
    const originalMemfsBaseUrl = process.env.LETTA_MEMFS_BASE_URL;
    process.env.LETTA_BASE_URL = "http://localhost:54085";
    process.env.LETTA_MEMFS_BASE_URL = "https://selfhost.example.com";

    try {
      settingsManager.setMemfsEnabled("agent-memfs-write", true);

      const settings = settingsManager.getSettings();
      expect(settings.agents).toContainEqual({
        agentId: "agent-memfs-write",
        baseUrl: "selfhost.example.com",
        memfs: true,
      });
      expect(
        settings.agents?.some(
          (agent) =>
            agent.agentId === "agent-memfs-write" &&
            agent.baseUrl === "localhost:54085",
        ),
      ).toBe(false);
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.LETTA_BASE_URL;
      } else {
        process.env.LETTA_BASE_URL = originalBaseUrl;
      }
      if (originalMemfsBaseUrl === undefined) {
        delete process.env.LETTA_MEMFS_BASE_URL;
      } else {
        process.env.LETTA_MEMFS_BASE_URL = originalMemfsBaseUrl;
      }
    }
  });

  test("setMemfsEnabled defaults to api.letta.com key when LETTA_MEMFS_BASE_URL is unset", async () => {
    await settingsManager.initialize();

    const originalBaseUrl = process.env.LETTA_BASE_URL;
    const originalMemfsBaseUrl = process.env.LETTA_MEMFS_BASE_URL;
    process.env.LETTA_BASE_URL = "http://localhost:54085";
    delete process.env.LETTA_MEMFS_BASE_URL;

    try {
      settingsManager.setMemfsEnabled("agent-memfs-default-cloud", true);

      const settings = settingsManager.getSettings();
      expect(settings.agents).toContainEqual({
        agentId: "agent-memfs-default-cloud",
        memfs: true,
      });
      expect(
        settings.agents?.some(
          (agent) =>
            agent.agentId === "agent-memfs-default-cloud" &&
            agent.baseUrl === "localhost:54085",
        ),
      ).toBe(false);
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.LETTA_BASE_URL;
      } else {
        process.env.LETTA_BASE_URL = originalBaseUrl;
      }
      if (originalMemfsBaseUrl === undefined) {
        delete process.env.LETTA_MEMFS_BASE_URL;
      } else {
        process.env.LETTA_MEMFS_BASE_URL = originalMemfsBaseUrl;
      }
    }
  });

  test("setMemfsEnabled stores local backend settings under the local storage key", async () => {
    await settingsManager.initialize();

    const storageDir = join(testHomeDir, "lc-local-backend");
    const localKey = `local:${resolve(storageDir)}`;
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    settingsManager.setMemfsEnabled("agent-local-memfs-write", true);

    const settings = settingsManager.getSettings();
    expect(settings.agents).toContainEqual({
      agentId: "agent-local-memfs-write",
      baseUrl: localKey,
      memfs: true,
    });
    expect(settingsManager.isMemfsEnabled("agent-local-memfs-write")).toBe(
      true,
    );
  });

  test("setMemfsEnabled persists to disk", async () => {
    await settingsManager.initialize();

    settingsManager.setMemfsEnabled("agent-persist-test", true);

    // Wait for async persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reset and reload
    await settingsManager.reset();
    await settingsManager.initialize();

    expect(settingsManager.isMemfsEnabled("agent-persist-test")).toBe(true);
  });
});

describe("Settings Manager - Toolset Preferences", () => {
  test("getToolsetPreference defaults to auto", async () => {
    await settingsManager.initialize();

    expect(settingsManager.getToolsetPreference("agent-unset")).toBe("auto");
  });

  test("setToolsetPreference stores and clears manual override", async () => {
    await settingsManager.initialize();

    settingsManager.setToolsetPreference("agent-toolset", "codex");
    expect(settingsManager.getToolsetPreference("agent-toolset")).toBe("codex");

    settingsManager.setToolsetPreference("agent-toolset", "auto");
    expect(settingsManager.getToolsetPreference("agent-toolset")).toBe("auto");
  });

  test("setToolsetPreference persists to disk", async () => {
    await settingsManager.initialize();

    settingsManager.setToolsetPreference("agent-toolset-persist", "gemini");

    // Wait for async persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(settingsManager.getToolsetPreference("agent-toolset-persist")).toBe(
      "gemini",
    );
  });
});

// ============================================================================
// Managed Keys / Settings Preservation Tests
// ============================================================================

describe("Settings Manager - Managed Keys Preservation", () => {
  test("Unknown top-level keys in the file are preserved across writes", async () => {
    const { writeFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });

    // Simulate a user manually adding a key that Letta Code doesn't know about
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        tokenStreaming: true,
        myCustomFlag: "keep-me",
      }),
    );

    await settingsManager.initialize();

    // Update an unrelated setting — should not clobber myCustomFlag
    settingsManager.updateSettings({ lastAgent: "agent-abc" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Read the raw file to confirm myCustomFlag survived
    const { readFile } = await import("@/utils/fs.js");
    const raw = JSON.parse(
      await readFile(join(settingsDir, "settings.json")),
    ) as Record<string, unknown>;

    expect(raw.myCustomFlag).toBe("keep-me");
    expect(raw.tokenStreaming).toBe(true);
    expect(raw.lastAgent).toBe("agent-abc");
  });

  test("External updates to managed keys are preserved when this process didn't change them", async () => {
    const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    const settingsPath = join(settingsDir, "settings.json");
    await mkdir(settingsDir, { recursive: true });

    await writeFile(
      settingsPath,
      JSON.stringify({
        tokenStreaming: true,
        pinnedAgents: ["agent-a"],
        pinnedAgentsByServer: {
          "api.letta.com": ["agent-a"],
        },
      }),
    );

    await settingsManager.initialize();

    // Simulate another process appending a new global pin while this process
    // is still running with stale in-memory settings.
    const externallyUpdated = JSON.parse(
      await readFile(settingsPath),
    ) as Record<string, unknown>;

    const pinnedByServer = (externallyUpdated.pinnedAgentsByServer as Record<
      string,
      string[]
    >) || { "api.letta.com": [] };
    pinnedByServer["api.letta.com"] = [
      ...(pinnedByServer["api.letta.com"] || []),
      "agent-b",
    ];
    externallyUpdated.pinnedAgentsByServer = pinnedByServer;

    const pinned = (externallyUpdated.pinnedAgents as string[]) || [];
    externallyUpdated.pinnedAgents = [...pinned, "agent-b"];

    await writeFile(settingsPath, JSON.stringify(externallyUpdated));

    // Trigger an unrelated write from this process.
    settingsManager.updateSettings({ lastAgent: "agent-current" });
    await settingsManager.flush();

    const raw = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(raw.lastAgent).toBe("agent-current");
    expect((raw.pinnedAgents as string[]) || []).toContain("agent-b");
    expect(
      (raw.pinnedAgentsByServer as Record<string, string[]>)?.[
        "api.letta.com"
      ] || [],
    ).toContain("agent-b");
  });

  test("External deletion of managed keys is preserved when this process didn't change them", async () => {
    const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    const settingsPath = join(settingsDir, "settings.json");
    await mkdir(settingsDir, { recursive: true });

    await writeFile(
      settingsPath,
      JSON.stringify({
        tokenStreaming: true,
        pinnedAgents: ["agent-a"],
        pinnedAgentsByServer: {
          "api.letta.com": ["agent-a"],
        },
      }),
    );

    await settingsManager.initialize();

    // Simulate another process removing managed pin keys.
    const externallyUpdated = JSON.parse(
      await readFile(settingsPath),
    ) as Record<string, unknown>;
    delete externallyUpdated.pinnedAgents;
    delete externallyUpdated.pinnedAgentsByServer;
    await writeFile(settingsPath, JSON.stringify(externallyUpdated));

    // Trigger an unrelated write from this process.
    settingsManager.updateSettings({ lastAgent: "agent-current" });
    await settingsManager.flush();

    const raw = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(raw.lastAgent).toBe("agent-current");
    expect("pinnedAgents" in raw).toBe(false);
    expect("pinnedAgentsByServer" in raw).toBe(false);
  });

  test("No-keychain fallback persists refreshToken and LETTA_API_KEY to file", async () => {
    // On machines with a keychain, tokens go to the keychain, not the file.
    // On machines without a keychain, tokens must fall back to the file.
    // Both paths are exercised here depending on the environment.
    const secretsAvail = await isKeychainAvailable();
    if (secretsAvail) {
      // On machines with a keychain, tokens go to the keychain, not the file.
      // Test the fallback indirectly: if secrets are available the tokens
      // should NOT be in the file (they're in the keychain).
      await settingsManager.initialize();
      settingsManager.updateSettings({ refreshToken: "rt-keychain-test" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const { readFile } = await import("@/utils/fs.js");
      const settingsDir = join(testHomeDir, ".letta");
      const raw = JSON.parse(
        await readFile(join(settingsDir, "settings.json")),
      ) as Record<string, unknown>;

      // With keychain available, refreshToken goes to keychain not file
      expect(raw.refreshToken).toBeUndefined();
    } else {
      // No keychain: tokens fall back to the settings file and must be persisted
      await settingsManager.initialize();
      settingsManager.updateSettings({
        refreshToken: "rt-fallback-test",
        env: { LETTA_API_KEY: "sk-fallback-test" },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const { readFile } = await import("@/utils/fs.js");
      const settingsDir = join(testHomeDir, ".letta");
      const raw = JSON.parse(
        await readFile(join(settingsDir, "settings.json")),
      ) as Record<string, unknown>;

      expect(raw.refreshToken).toBe("rt-fallback-test");
      // LETTA_API_KEY also falls back to the file when keychain is unavailable
      expect((raw.env as Record<string, unknown>)?.LETTA_API_KEY).toBe(
        "sk-fallback-test",
      );
    }
  });

  test("Auth-only token updates preserve unrelated env settings", async () => {
    const previousSkipKeychain = process.env.LETTA_SKIP_KEYCHAIN_CHECK;
    process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";

    try {
      const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
      const settingsDir = join(testHomeDir, ".letta");
      const settingsPath = join(settingsDir, "settings.json");
      await mkdir(settingsDir, { recursive: true });

      await writeFile(
        settingsPath,
        JSON.stringify({
          env: { SOME_FLAG: "1" },
          tokenStreaming: true,
        }),
      );

      await settingsManager.initialize();
      settingsManager.updateSettings({
        env: { LETTA_API_KEY: "sk-auth-only" },
        refreshToken: "rt-auth-only",
        tokenExpiresAt: 123,
      });
      await settingsManager.flush();

      const raw = JSON.parse(await readFile(settingsPath)) as Record<
        string,
        unknown
      >;
      expect(raw.env).toEqual({
        SOME_FLAG: "1",
        LETTA_API_KEY: "sk-auth-only",
      });
      expect(raw.refreshToken).toBe("rt-auth-only");
      expect(raw.tokenExpiresAt).toBe(123);
    } finally {
      if (previousSkipKeychain === undefined) {
        delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
      } else {
        process.env.LETTA_SKIP_KEYCHAIN_CHECK = previousSkipKeychain;
      }
    }
  });
});

// ============================================================================
// Conversation Goal Tests
// ============================================================================

describe("Settings Manager - Conversation Goals", () => {
  async function initGoalTest() {
    await settingsManager.initialize();
    await settingsManager.loadLocalProjectSettings(testProjectDir);
  }

  test("setConversationGoal creates an active goal", async () => {
    await initGoalTest();
    const goal = settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
    );
    expect(goal.objective).toBe("fix the bug");
    expect(goal.status).toBe("active");
    expect(goal.tokensUsed).toBe(0);
  });

  test("getConversationGoal retrieves a goal", async () => {
    await initGoalTest();
    settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
    );
    const goal = settingsManager.getConversationGoal("conv-1", testProjectDir);
    expect(goal).not.toBeNull();
    expect(goal?.objective).toBe("fix the bug");
  });

  test("getConversationGoal returns null for missing conversation", async () => {
    await initGoalTest();
    const goal = settingsManager.getConversationGoal(
      "nonexistent",
      testProjectDir,
    );
    expect(goal).toBeNull();
  });

  test("updateConversationGoalStatus transitions active -> paused", async () => {
    await initGoalTest();
    settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
    );
    const updated = settingsManager.updateConversationGoalStatus(
      "conv-1",
      "paused",
      testProjectDir,
    );
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("paused");
    expect(updated?.activeStartedAt).toBeNull();
  });

  test("updateConversationGoalStatus transitions paused -> active", async () => {
    await initGoalTest();
    settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
    );
    settingsManager.updateConversationGoalStatus(
      "conv-1",
      "paused",
      testProjectDir,
    );
    const resumed = settingsManager.updateConversationGoalStatus(
      "conv-1",
      "active",
      testProjectDir,
    );
    expect(resumed?.status).toBe("active");
    expect(resumed?.activeStartedAt).not.toBeNull();
  });

  test("updateConversationGoalStatus transitions active -> blocked", async () => {
    await initGoalTest();
    settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
    );
    const updated = settingsManager.updateConversationGoalStatus(
      "conv-1",
      "blocked",
      testProjectDir,
    );
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("blocked");
    expect(updated?.activeStartedAt).toBeNull();
  });

  test("updateConversationGoalStatus returns null for missing conversation", async () => {
    await initGoalTest();
    const result = settingsManager.updateConversationGoalStatus(
      "nonexistent",
      "paused",
      testProjectDir,
    );
    expect(result).toBeNull();
  });

  test("accountConversationGoalUsage adds tokens", async () => {
    await initGoalTest();
    settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
    );
    const updated = settingsManager.accountConversationGoalUsage(
      "conv-1",
      500,
      testProjectDir,
    );
    expect(updated?.tokensUsed).toBe(500);
  });

  test("accountConversationGoalUsage accumulates across calls", async () => {
    await initGoalTest();
    settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
    );
    settingsManager.accountConversationGoalUsage("conv-1", 500, testProjectDir);
    const updated = settingsManager.accountConversationGoalUsage(
      "conv-1",
      300,
      testProjectDir,
    );
    expect(updated?.tokensUsed).toBe(800);
  });

  test("accountConversationGoalUsage returns null for missing conversation", async () => {
    await initGoalTest();
    const result = settingsManager.accountConversationGoalUsage(
      "nonexistent",
      500,
      testProjectDir,
    );
    expect(result).toBeNull();
  });

  test("clearConversationGoal removes a goal", async () => {
    await initGoalTest();
    settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
    );
    const hadGoal = settingsManager.clearConversationGoal(
      "conv-1",
      testProjectDir,
    );
    expect(hadGoal).toBe(true);
    expect(
      settingsManager.getConversationGoal("conv-1", testProjectDir),
    ).toBeNull();
  });

  test("clearConversationGoal returns false for missing conversation", async () => {
    await initGoalTest();
    const hadGoal = settingsManager.clearConversationGoal(
      "nonexistent",
      testProjectDir,
    );
    expect(hadGoal).toBe(false);
  });

  test("setConversationGoal with tokenBudget stores budget", async () => {
    await initGoalTest();
    const goal = settingsManager.setConversationGoal(
      "conv-1",
      "fix the bug",
      testProjectDir,
      50000,
    );
    expect(goal.tokenBudget).toBe(50000);
  });

  test("setConversationGoal preserves createdAt on replace", async () => {
    await initGoalTest();
    const first = settingsManager.setConversationGoal(
      "conv-1",
      "first objective",
      testProjectDir,
    );
    const originalCreatedAt = first.createdAt;
    const second = settingsManager.setConversationGoal(
      "conv-1",
      "second objective",
      testProjectDir,
    );
    expect(second.createdAt).toBe(originalCreatedAt);
    expect(second.objective).toBe("second objective");
  });

  test("goal tools enabled flag works", async () => {
    await initGoalTest();
    expect(
      settingsManager.areConversationGoalToolsEnabled("conv-1", testProjectDir),
    ).toBe(false);

    settingsManager.setConversationGoalToolsEnabled(
      "conv-1",
      true,
      testProjectDir,
    );
    expect(
      settingsManager.areConversationGoalToolsEnabled("conv-1", testProjectDir),
    ).toBe(true);

    settingsManager.setConversationGoalToolsEnabled(
      "conv-1",
      false,
      testProjectDir,
    );
    expect(
      settingsManager.areConversationGoalToolsEnabled("conv-1", testProjectDir),
    ).toBe(false);
  });
});

describe("Settings Manager - Conversation Pins", () => {
  async function initPinTest() {
    await settingsManager.initialize();
    await settingsManager.loadLocalProjectSettings(testProjectDir);
  }

  test("pins conversations globally and locally per agent", async () => {
    await initPinTest();

    settingsManager.pinConversationGlobal("agent-1", "conv-1");
    settingsManager.pinConversationLocal("agent-1", "conv-2", testProjectDir);

    expect(settingsManager.getGlobalPinnedConversations("agent-1")).toEqual([
      "conv-1",
    ]);
    expect(
      settingsManager.getLocalPinnedConversations("agent-1", testProjectDir),
    ).toEqual(["conv-2"]);
    expect(
      settingsManager.getMergedPinnedConversations("agent-1", testProjectDir),
    ).toEqual([
      { conversationId: "conv-2", isLocal: true },
      { conversationId: "conv-1", isLocal: false },
    ]);
  });

  test("conversation pins are scoped by local backend storage dir", async () => {
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = join(testHomeDir, "local-store-a");
    await initPinTest();

    settingsManager.pinConversationGlobal("local-agent-1", "conv-a");
    expect(
      settingsManager.getGlobalPinnedConversations("local-agent-1"),
    ).toEqual(["conv-a"]);

    process.env.LETTA_LOCAL_BACKEND_DIR = join(testHomeDir, "local-store-b");
    expect(
      settingsManager.getGlobalPinnedConversations("local-agent-1"),
    ).toEqual([]);
  });
});
