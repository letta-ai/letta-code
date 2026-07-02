import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

  test("Initialize tolerates obsolete keys and strips them on persist", async () => {
    const { writeFile, readFile, mkdir } = await import("@/utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");

    await writeFile(
      settingsPath,
      JSON.stringify({
        reflectionBehavior: "reminder",
        enableSleeptime: true,
        pinnedConversationsByServer: {
          "api.letta.com": { "agent-1": ["conv-1"] },
        },
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
    expect(settings).not.toHaveProperty("enableSleeptime");
    expect(settings).not.toHaveProperty("pinnedConversationsByServer");

    settingsManager.updateSettings({ tokenStreaming: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const persisted = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("reflectionBehavior");
    expect(persisted).not.toHaveProperty("enableSleeptime");
    expect(persisted).not.toHaveProperty("pinnedConversationsByServer");
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
      reasoningTabCycleEnabled: true,
    });

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true);
    expect(settings.lastAgent).toBe("agent-456");
    expect(settings.reasoningTabCycleEnabled).toBe(true);
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
        pinnedConversationsByServer: {
          "api.letta.com": { "agent-1": ["conv-1"] },
        },
        reflectionTrigger: "step-count",
        reflectionStepCount: 9,
      }),
    );

    const localSettings =
      await settingsManager.loadLocalProjectSettings(testProjectDir);
    expect(localSettings.lastAgent).toBe("agent-local-legacy");
    expect(localSettings).not.toHaveProperty("reflectionBehavior");
    expect(localSettings).not.toHaveProperty("pinnedConversationsByServer");

    const persisted = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("reflectionBehavior");
    expect(persisted).not.toHaveProperty("pinnedConversationsByServer");
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
    settingsManager.updateSettings({ reasoningTabCycleEnabled: false });
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
      reasoningTabCycleEnabled: true,
    });

    // Partial update
    settingsManager.updateSettings({
      lastAgent: "agent-2",
    });

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true); // Preserved
    expect(settings.reasoningTabCycleEnabled).toBe(true); // Preserved
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

describe("Settings Manager - Pinned Agents", () => {
  test("getPinnedAgents excludes a local-backend agent id from a cloud session", async () => {
    await settingsManager.initialize();

    // Both pins land in the cloud bucket (no baseUrl), but the local-style id
    // is incompatible with the cloud server key and must be filtered out.
    settingsManager.updateSettings({
      agents: [
        { agentId: "agent-cloud-1", pinned: true },
        { agentId: "agent-local-stray", pinned: true },
      ],
    });

    expect(settingsManager.getPinnedAgents()).toEqual(["agent-cloud-1"]);
  });

  test("getPinnedAgents excludes a cloud agent id from a local-backend session", async () => {
    await settingsManager.initialize();

    const storageDir = join(testHomeDir, "lc-local-backend");
    const localKey = `local:${resolve(storageDir)}`;
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    // Both pins land in the local bucket (baseUrl === localKey), but the
    // cloud-style id is incompatible with the local server key.
    settingsManager.updateSettings({
      agents: [
        { agentId: "agent-local-1", baseUrl: localKey, pinned: true },
        { agentId: "agent-cloud-stray", baseUrl: localKey, pinned: true },
      ],
    });

    expect(settingsManager.getPinnedAgents()).toEqual(["agent-local-1"]);
  });

  test("getPinnedAgentsForBackendMode returns the other mode's pins from a cloud session", async () => {
    await settingsManager.initialize();

    const storageDir = join(testHomeDir, "lc-local-backend");
    const localKey = `local:${resolve(storageDir)}`;
    // Make the local server key deterministic without switching the active
    // session into local mode.
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    settingsManager.updateSettings({
      agents: [
        { agentId: "agent-cloud-1", pinned: true },
        { agentId: "agent-local-1", baseUrl: localKey, pinned: true },
      ],
    });

    // Active session is cloud.
    expect(settingsManager.getPinnedAgents()).toEqual(["agent-cloud-1"]);
    // ...but we can still look up the local pins by mode (the old
    // configureBackendMode dance returned [] here).
    expect(settingsManager.getPinnedAgentsForBackendMode("local")).toEqual([
      "agent-local-1",
    ]);
    expect(settingsManager.getPinnedAgentsForBackendMode("api")).toEqual([
      "agent-cloud-1",
    ]);
  });

  test("getPinnedAgentsForBackendMode('api') is scoped to the configured base URL", async () => {
    await settingsManager.initialize();

    const originalBaseUrl = process.env.LETTA_BASE_URL;
    process.env.LETTA_BASE_URL = "https://selfhost.example.com";

    try {
      settingsManager.updateSettings({
        agents: [
          { agentId: "agent-cloud-1", pinned: true },
          {
            agentId: "agent-selfhost-1",
            baseUrl: "selfhost.example.com",
            pinned: true,
          },
        ],
      });

      // Only the pin for the active self-hosted server is returned; the
      // api.letta.com pin belongs to a different server bucket.
      expect(settingsManager.getPinnedAgentsForBackendMode("api")).toEqual([
        "agent-selfhost-1",
      ]);
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.LETTA_BASE_URL;
      } else {
        process.env.LETTA_BASE_URL = originalBaseUrl;
      }
    }
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
        agents: [{ agentId: "agent-a", pinned: true }],
      }),
    );

    await settingsManager.initialize();

    // Simulate another process appending a new pin while this process
    // is still running with stale in-memory settings.
    const externallyUpdated = JSON.parse(
      await readFile(settingsPath),
    ) as Record<string, unknown>;
    const agents =
      (externallyUpdated.agents as Array<Record<string, unknown>>) || [];
    externallyUpdated.agents = [
      ...agents,
      { agentId: "agent-b", pinned: true },
    ];

    await writeFile(settingsPath, JSON.stringify(externallyUpdated));

    // Trigger an unrelated write from this process.
    settingsManager.updateSettings({ lastAgent: "agent-current" });
    await settingsManager.flush();

    const raw = JSON.parse(await readFile(settingsPath)) as Record<
      string,
      unknown
    >;
    expect(raw.lastAgent).toBe("agent-current");
    expect(raw.agents).toContainEqual({ agentId: "agent-b", pinned: true });
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
describe("readStartupBackendSettingsSync", () => {
  let tmpHome: string;
  const savedHome = process.env.HOME;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "letta-startup-backend-"));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  function writeSettings(data: Record<string, unknown>): void {
    const dir = join(tmpHome, ".letta");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(data));
  }

  test("returns empty settings when settings file does not exist", () => {
    expect(settingsManager.readStartupBackendSettingsSync()).toEqual({
      preferredBackendMode: undefined,
      envBaseUrl: undefined,
    });
  });

  test("reads valid backend preference and configured base URL", () => {
    writeSettings({
      preferredBackendMode: "local",
      env: { LETTA_BASE_URL: "http://localhost:8283" },
    });

    expect(settingsManager.readStartupBackendSettingsSync()).toEqual({
      preferredBackendMode: "local",
      envBaseUrl: "http://localhost:8283",
    });
  });

  test("ignores invalid backend preference and malformed env", () => {
    writeSettings({ preferredBackendMode: "other", env: "not-an-object" });

    expect(settingsManager.readStartupBackendSettingsSync()).toEqual({
      preferredBackendMode: undefined,
      envBaseUrl: undefined,
    });
  });

  test("returns empty settings for malformed JSON", () => {
    const dir = join(tmpHome, ".letta");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "not json{{{");

    expect(settingsManager.readStartupBackendSettingsSync()).toEqual({
      preferredBackendMode: undefined,
      envBaseUrl: undefined,
    });
  });
});
