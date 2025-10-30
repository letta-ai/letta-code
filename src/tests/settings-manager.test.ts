import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "../settings-manager";

// Store original HOME to restore after tests
const originalHome = process.env.HOME;
let testHomeDir: string;
let testProjectDir: string;

beforeEach(async () => {
  // Reset settings manager FIRST before changing HOME
  settingsManager.reset();

  // Create temporary directories for testing
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-test-home-"));
  testProjectDir = await mkdtemp(join(tmpdir(), "letta-test-project-"));

  // Override HOME for tests (must be done BEFORE initialize is called)
  process.env.HOME = testHomeDir;
});

afterEach(async () => {
  // Clean up test directories
  await rm(testHomeDir, { recursive: true, force: true });
  await rm(testProjectDir, { recursive: true, force: true });

  // Restore original HOME
  process.env.HOME = originalHome;

  // Reset settings manager after each test
  settingsManager.reset();
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
    expect(settings.uiMode).toBeDefined();
    expect(typeof settings.tokenStreaming).toBe("boolean");
    expect(settings.globalSharedBlockIds).toBeDefined();
    expect(typeof settings.globalSharedBlockIds).toBe("object");
  });

  test("Initialize loads existing settings from disk", async () => {
    // First initialize and set some settings
    await settingsManager.initialize();
    settingsManager.updateSettings({
      uiMode: "rich",
      tokenStreaming: true,
      lastAgent: "agent-123",
    });

    // Wait for persist to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reset and re-initialize
    settingsManager.reset();
    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    expect(settings.uiMode).toBe("rich");
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
});

// ============================================================================
// Global Settings Tests
// ============================================================================

describe("Settings Manager - Global Settings", () => {
  beforeEach(async () => {
    await settingsManager.initialize();
  });

  test("Get settings returns a copy", () => {
    const settings1 = settingsManager.getSettings();
    const settings2 = settingsManager.getSettings();

    expect(settings1).toEqual(settings2);
    expect(settings1).not.toBe(settings2); // Different object instances
  });

  test("Get specific setting", () => {
    settingsManager.updateSettings({ uiMode: "rich" });

    const uiMode = settingsManager.getSetting("uiMode");
    expect(uiMode).toBe("rich");
  });

  test("Update single setting", () => {
    // Verify initial state first
    const initialSettings = settingsManager.getSettings();
    const initialUiMode = initialSettings.uiMode;

    settingsManager.updateSettings({ tokenStreaming: true });

    const settings = settingsManager.getSettings();
    expect(settings.tokenStreaming).toBe(true);
    expect(settings.uiMode).toBe(initialUiMode); // Other settings unchanged
  });

  test("Update multiple settings", () => {
    settingsManager.updateSettings({
      uiMode: "rich",
      tokenStreaming: true,
      lastAgent: "agent-456",
    });

    const settings = settingsManager.getSettings();
    expect(settings.uiMode).toBe("rich");
    expect(settings.tokenStreaming).toBe(true);
    expect(settings.lastAgent).toBe("agent-456");
  });

  test("Update global shared block IDs", () => {
    settingsManager.updateSettings({
      globalSharedBlockIds: {
        persona: "block-1",
        human: "block-2",
      },
    });

    const settings = settingsManager.getSettings();
    expect(settings.globalSharedBlockIds).toEqual({
      persona: "block-1",
      human: "block-2",
    });
  });

  test("Update env variables", () => {
    settingsManager.updateSettings({
      env: {
        LETTA_API_KEY: "sk-test-123",
        CUSTOM_VAR: "value",
      },
    });

    const settings = settingsManager.getSettings();
    expect(settings.env).toEqual({
      LETTA_API_KEY: "sk-test-123",
      CUSTOM_VAR: "value",
    });
  });

  test("Settings persist to disk", async () => {
    settingsManager.updateSettings({
      uiMode: "rich",
      lastAgent: "agent-789",
    });

    // Wait for async persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Reset and reload
    settingsManager.reset();
    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    expect(settings.uiMode).toBe("rich");
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

    expect(projectSettings.localSharedBlockIds).toEqual({});
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
        localSharedBlockIds: {
          style: "block-style-1",
          project: "block-project-1",
        },
      },
      testProjectDir,
    );

    const settings = settingsManager.getProjectSettings(testProjectDir);
    expect(settings.localSharedBlockIds).toEqual({
      style: "block-style-1",
      project: "block-project-1",
    });
  });

  test("Project settings persist to disk", async () => {
    await settingsManager.loadProjectSettings(testProjectDir);

    settingsManager.updateProjectSettings(
      {
        localSharedBlockIds: {
          test: "block-test-1",
        },
      },
      testProjectDir,
    );

    // Wait for persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clear cache and reload
    settingsManager.reset();
    await settingsManager.initialize();
    const reloaded = await settingsManager.loadProjectSettings(testProjectDir);

    expect(reloaded.localSharedBlockIds).toEqual({
      test: "block-test-1",
    });
  });

  test("Throw error if accessing project settings before loading", async () => {
    expect(() => settingsManager.getProjectSettings(testProjectDir)).toThrow(
      "Project settings for",
    );
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
    settingsManager.reset();
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
      { localSharedBlockIds: { test: "block-1" } },
      testProjectDir,
    );
    settingsManager.updateProjectSettings(
      { localSharedBlockIds: { test: "block-2" } },
      testProjectDir2,
    );

    const settings1 = settingsManager.getProjectSettings(testProjectDir);
    const settings2 = settingsManager.getProjectSettings(testProjectDir2);

    expect(settings1.localSharedBlockIds.test).toBe("block-1");
    expect(settings2.localSharedBlockIds.test).toBe("block-2");
  });
});

// ============================================================================
// Reset Tests
// ============================================================================

describe("Settings Manager - Reset", () => {
  test("Reset clears all cached data", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({ lastAgent: "agent-reset-test" });

    settingsManager.reset();

    // Should throw error after reset
    expect(() => settingsManager.getSettings()).toThrow();
  });

  test("Can reinitialize after reset", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({ uiMode: "rich" });

    // Wait for persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    settingsManager.reset();
    await settingsManager.initialize();

    const settings = settingsManager.getSettings();
    expect(settings.uiMode).toBe("rich");
  });
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe("Settings Manager - Edge Cases", () => {
  test("Handles corrupted settings file gracefully", async () => {
    // Create corrupted settings file
    const { writeFile, mkdir } = await import("../utils/fs.js");
    const settingsDir = join(testHomeDir, ".letta");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.json"), "{ invalid json");

    // Should fall back to defaults
    await settingsManager.initialize();
    const settings = settingsManager.getSettings();

    // Should have default values (not corrupt)
    expect(settings).toBeDefined();
    expect(settings.uiMode).toBeDefined();
    expect(settings.tokenStreaming).toBeDefined();
    expect(typeof settings.tokenStreaming).toBe("boolean");
  });

  test("Modifying returned settings doesn't affect internal state", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      lastAgent: "agent-123",
      globalSharedBlockIds: {},
    });

    const settings = settingsManager.getSettings();
    settings.lastAgent = "modified-agent";
    settings.globalSharedBlockIds = { modified: "block" };

    // Internal state should be unchanged
    const actualSettings = settingsManager.getSettings();
    expect(actualSettings.lastAgent).toBe("agent-123");
    expect(actualSettings.globalSharedBlockIds).toEqual({});
  });

  test("Partial updates preserve existing values", async () => {
    await settingsManager.initialize();

    settingsManager.updateSettings({
      uiMode: "rich",
      tokenStreaming: true,
      lastAgent: "agent-1",
    });

    // Partial update
    settingsManager.updateSettings({
      lastAgent: "agent-2",
    });

    const settings = settingsManager.getSettings();
    expect(settings.uiMode).toBe("rich"); // Preserved
    expect(settings.tokenStreaming).toBe(true); // Preserved
    expect(settings.lastAgent).toBe("agent-2"); // Updated
  });
});
