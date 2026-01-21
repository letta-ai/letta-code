import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearHooksCache,
  getHooksForEvent,
  getMatchingHooks,
  hasHooksForEvent,
  loadHooks,
  loadProjectHooks,
  loadProjectLocalHooks,
  matchesTool,
  mergeHooksConfigs,
} from "../../hooks/loader";
import type { HookEvent, HooksConfig } from "../../hooks/types";

describe("Hooks Loader", () => {
  let tempDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    const baseDir = join(tmpdir(), `hooks-loader-test-${Date.now()}`);
    // Create separate directories for HOME and project to avoid double-loading
    fakeHome = join(baseDir, "home");
    tempDir = join(baseDir, "project");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    // Override HOME to isolate from real global hooks
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    clearHooksCache();
  });

  afterEach(() => {
    // Restore HOME
    process.env.HOME = originalHome;
    try {
      // Clean up the parent directory
      const baseDir = join(tempDir, "..");
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    clearHooksCache();
  });

  describe("loadProjectHooks", () => {
    test("returns empty config when no settings file exists", async () => {
      const hooks = await loadProjectHooks(tempDir);
      expect(hooks).toEqual({});
    });

    test("loads hooks from .letta/settings.json", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo test" }],
            },
          ],
        },
      };

      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify(settings),
      );

      const hooks = await loadProjectHooks(tempDir);
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
    });

    test("caches loaded hooks", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "echo cached" }],
            },
          ],
        },
      };

      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify(settings),
      );

      const hooks1 = await loadProjectHooks(tempDir);
      const hooks2 = await loadProjectHooks(tempDir);

      // Should return same object from cache
      expect(hooks1).toBe(hooks2);
    });
  });

  describe("mergeHooksConfigs", () => {
    test("merges global and project configs", () => {
      const global: HooksConfig = {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "global hook" }],
          },
        ],
      };

      const project: HooksConfig = {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "project hook" }],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "post hook" }],
          },
        ],
      };

      const merged = mergeHooksConfigs(global, project);

      // Project hooks come first
      expect(merged.PreToolUse).toHaveLength(2);
      expect(merged.PreToolUse?.[0]?.matcher).toBe("Bash"); // project first
      expect(merged.PreToolUse?.[1]?.matcher).toBe("*"); // global second

      // PostToolUse only in project
      expect(merged.PostToolUse).toHaveLength(1);
    });

    test("handles empty configs", () => {
      const global: HooksConfig = {};
      const project: HooksConfig = {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "test" }],
          },
        ],
      };

      const merged = mergeHooksConfigs(global, project);
      expect(merged.PreToolUse).toHaveLength(1);
    });
  });

  describe("matchesTool", () => {
    test("wildcard matches all tools", () => {
      expect(matchesTool("*", "Bash")).toBe(true);
      expect(matchesTool("*", "Edit")).toBe(true);
      expect(matchesTool("*", "Write")).toBe(true);
    });

    test("empty string matches all tools", () => {
      expect(matchesTool("", "Bash")).toBe(true);
      expect(matchesTool("", "Read")).toBe(true);
    });

    test("exact match works", () => {
      expect(matchesTool("Bash", "Bash")).toBe(true);
      expect(matchesTool("Bash", "Edit")).toBe(false);
    });

    test("pipe-separated list matches any", () => {
      expect(matchesTool("Edit|Write", "Edit")).toBe(true);
      expect(matchesTool("Edit|Write", "Write")).toBe(true);
      expect(matchesTool("Edit|Write", "Bash")).toBe(false);
      expect(matchesTool("Edit|Write|Read", "Read")).toBe(true);
    });
  });

  describe("getMatchingHooks", () => {
    test("returns hooks for matching tool", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "bash hook" }],
          },
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "edit hook" }],
          },
        ],
      };

      const bashHooks = getMatchingHooks(config, "PreToolUse", "Bash");
      expect(bashHooks).toHaveLength(1);
      expect(bashHooks[0]?.command).toBe("bash hook");

      const editHooks = getMatchingHooks(config, "PreToolUse", "Edit");
      expect(editHooks).toHaveLength(1);
      expect(editHooks[0]?.command).toBe("edit hook");
    });

    test("returns wildcard hooks for any tool", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "all tools hook" }],
          },
        ],
      };

      const hooks = getMatchingHooks(config, "PreToolUse", "AnyTool");
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.command).toBe("all tools hook");
    });

    test("returns multiple matching hooks", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "global hook" }],
          },
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "bash specific" }],
          },
        ],
      };

      const hooks = getMatchingHooks(config, "PreToolUse", "Bash");
      expect(hooks).toHaveLength(2);
    });

    test("returns empty array for non-matching event", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "test" }],
          },
        ],
      };

      const hooks = getMatchingHooks(config, "PostToolUse", "Bash");
      expect(hooks).toHaveLength(0);
    });

    test("returns empty array for non-matching tool", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "edit only" }],
          },
        ],
      };

      const hooks = getMatchingHooks(config, "PreToolUse", "Bash");
      expect(hooks).toHaveLength(0);
    });

    test("handles undefined tool name (for non-tool events)", () => {
      const config: HooksConfig = {
        SessionStart: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "session hook" }],
          },
        ],
      };

      const hooks = getMatchingHooks(config, "SessionStart", undefined);
      expect(hooks).toHaveLength(1);
    });

    test("returns hooks from multiple matchers in order", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "Bash|Edit",
            hooks: [{ type: "command", command: "multi tool" }],
          },
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "bash specific" }],
          },
          {
            matcher: "*",
            hooks: [{ type: "command", command: "wildcard" }],
          },
        ],
      };

      const hooks = getMatchingHooks(config, "PreToolUse", "Bash");
      expect(hooks).toHaveLength(3);
      expect(hooks[0]?.command).toBe("multi tool");
      expect(hooks[1]?.command).toBe("bash specific");
      expect(hooks[2]?.command).toBe("wildcard");
    });
  });

  describe("hasHooksForEvent", () => {
    test("returns true when hooks exist for event", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "test" }],
          },
        ],
      };

      expect(hasHooksForEvent(config, "PreToolUse")).toBe(true);
    });

    test("returns false when no hooks for event", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "test" }],
          },
        ],
      };

      expect(hasHooksForEvent(config, "PostToolUse")).toBe(false);
    });

    test("returns false for empty matchers array", () => {
      const config: HooksConfig = {
        PreToolUse: [],
      };

      expect(hasHooksForEvent(config, "PreToolUse")).toBe(false);
    });

    test("returns false for matcher with empty hooks", () => {
      const config: HooksConfig = {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [],
          },
        ],
      };

      expect(hasHooksForEvent(config, "PreToolUse")).toBe(false);
    });

    test("returns true if any matcher has hooks", () => {
      const config: HooksConfig = {
        PreToolUse: [
          { matcher: "Bash", hooks: [] },
          { matcher: "Edit", hooks: [{ type: "command", command: "test" }] },
        ],
      };

      expect(hasHooksForEvent(config, "PreToolUse")).toBe(true);
    });
  });

  describe("getHooksForEvent", () => {
    test("loads and returns matching hooks", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "bash hook" }],
            },
          ],
        },
      };

      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify(settings),
      );

      const hooks = await getHooksForEvent("PreToolUse", "Bash", tempDir);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.command).toBe("bash hook");
    });

    test("returns empty for non-matching tool", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "bash hook" }],
            },
          ],
        },
      };

      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify(settings),
      );

      const hooks = await getHooksForEvent("PreToolUse", "Edit", tempDir);
      expect(hooks).toHaveLength(0);
    });
  });

  describe("All 11 hook events", () => {
    const allEvents: HookEvent[] = [
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "UserPromptSubmit",
      "Notification",
      "Stop",
      "SubagentStop",
      "PreCompact",
      "Setup",
      "SessionStart",
      "SessionEnd",
    ];

    test("config can have all 11 event types", () => {
      const config: HooksConfig = {};
      for (const event of allEvents) {
        config[event] = [
          {
            matcher: "*",
            hooks: [{ type: "command", command: `echo ${event}` }],
          },
        ];
      }

      for (const event of allEvents) {
        expect(hasHooksForEvent(config, event)).toBe(true);
        const hooks = getMatchingHooks(config, event);
        expect(hooks).toHaveLength(1);
      }
    });

    test("merging preserves all event types", () => {
      const global: HooksConfig = {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "g1" }] },
        ],
        SessionStart: [
          { matcher: "*", hooks: [{ type: "command", command: "g2" }] },
        ],
      };

      const project: HooksConfig = {
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "p1" }] },
        ],
        SessionEnd: [
          { matcher: "*", hooks: [{ type: "command", command: "p2" }] },
        ],
      };

      const merged = mergeHooksConfigs(global, project);

      expect(merged.PreToolUse).toHaveLength(1);
      expect(merged.PostToolUse).toHaveLength(1);
      expect(merged.SessionStart).toHaveLength(1);
      expect(merged.SessionEnd).toHaveLength(1);
    });
  });

  describe("Edge cases", () => {
    test("handles malformed JSON gracefully", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(join(settingsDir, "settings.json"), "{ invalid json }");

      // Should not throw, returns empty config
      const hooks = await loadProjectHooks(tempDir);
      expect(hooks).toEqual({});
    });

    test("handles settings without hooks field", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({ someOtherSetting: true }),
      );

      const hooks = await loadProjectHooks(tempDir);
      expect(hooks).toEqual({});
    });

    test("clearHooksCache resets cache", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: "v1" }] },
            ],
          },
        }),
      );

      const hooks1 = await loadProjectHooks(tempDir);
      expect(hooks1.PreToolUse?.[0]?.hooks[0]?.command).toBe("v1");

      // Update the file
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: "v2" }] },
            ],
          },
        }),
      );

      // Without clearing cache, should still return v1
      const hooks2 = await loadProjectHooks(tempDir);
      expect(hooks2.PreToolUse?.[0]?.hooks[0]?.command).toBe("v1");

      // After clearing cache, should return v2
      clearHooksCache();
      const hooks3 = await loadProjectHooks(tempDir);
      expect(hooks3.PreToolUse?.[0]?.hooks[0]?.command).toBe("v2");
    });
  });

  // ============================================================================
  // Project-Local Hooks Tests (settings.local.json)
  // ============================================================================

  describe("loadProjectLocalHooks", () => {
    test("returns empty config when no local settings file exists", async () => {
      const hooks = await loadProjectLocalHooks(tempDir);
      expect(hooks).toEqual({});
    });

    test("loads hooks from .letta/settings.local.json", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo local" }],
            },
          ],
        },
      };

      writeFileSync(
        join(settingsDir, "settings.local.json"),
        JSON.stringify(settings),
      );

      const hooks = await loadProjectLocalHooks(tempDir);
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("echo local");
    });

    test("caches loaded local hooks", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      writeFileSync(
        join(settingsDir, "settings.local.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: "cached" }] },
            ],
          },
        }),
      );

      const hooks1 = await loadProjectLocalHooks(tempDir);
      const hooks2 = await loadProjectLocalHooks(tempDir);

      // Should return same object from cache
      expect(hooks1).toBe(hooks2);
    });
  });

  describe("Merged hooks priority (local > project > global)", () => {
    test("project-local hooks run before project hooks", () => {
      const global: HooksConfig = {};
      const project: HooksConfig = {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "project" }] },
        ],
      };
      const projectLocal: HooksConfig = {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "local" }] },
        ],
      };

      const merged = mergeHooksConfigs(global, project, projectLocal);

      expect(merged.PreToolUse).toHaveLength(2);
      expect(merged.PreToolUse?.[0]?.hooks[0]?.command).toBe("local"); // Local first
      expect(merged.PreToolUse?.[1]?.hooks[0]?.command).toBe("project"); // Project second
    });

    test("project-local hooks run before global hooks", () => {
      const global: HooksConfig = {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "global" }] },
        ],
      };
      const project: HooksConfig = {};
      const projectLocal: HooksConfig = {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "local" }] },
        ],
      };

      const merged = mergeHooksConfigs(global, project, projectLocal);

      expect(merged.PreToolUse).toHaveLength(2);
      expect(merged.PreToolUse?.[0]?.hooks[0]?.command).toBe("local"); // Local first
      expect(merged.PreToolUse?.[1]?.hooks[0]?.command).toBe("global"); // Global last
    });

    test("all three levels merge correctly", () => {
      const global: HooksConfig = {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "global" }] },
        ],
        SessionEnd: [
          { matcher: "*", hooks: [{ type: "command", command: "global-end" }] },
        ],
      };
      const project: HooksConfig = {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "project" }] },
        ],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "project-post" }] },
        ],
      };
      const projectLocal: HooksConfig = {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "local" }] },
        ],
        SessionStart: [
          { matcher: "*", hooks: [{ type: "command", command: "local-start" }] },
        ],
      };

      const merged = mergeHooksConfigs(global, project, projectLocal);

      // PreToolUse: local -> project -> global
      expect(merged.PreToolUse).toHaveLength(3);
      expect(merged.PreToolUse?.[0]?.hooks[0]?.command).toBe("local");
      expect(merged.PreToolUse?.[1]?.hooks[0]?.command).toBe("project");
      expect(merged.PreToolUse?.[2]?.hooks[0]?.command).toBe("global");

      // Others only have one source
      expect(merged.PostToolUse).toHaveLength(1);
      expect(merged.SessionStart).toHaveLength(1);
      expect(merged.SessionEnd).toHaveLength(1);
    });
  });

  describe("loadHooks (full merge)", () => {
    test("loads and merges all three config sources", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      // Create project settings
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: "project" }] },
            ],
          },
        }),
      );

      // Create project-local settings
      writeFileSync(
        join(settingsDir, "settings.local.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: "local" }] },
            ],
          },
        }),
      );

      const hooks = await loadHooks(tempDir);

      // Local should come before project
      expect(hooks.PreToolUse).toHaveLength(2);
      expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("local");
      expect(hooks.PreToolUse?.[1]?.hooks[0]?.command).toBe("project");
    });

    test("handles missing local settings gracefully", async () => {
      const settingsDir = join(tempDir, ".letta");
      mkdirSync(settingsDir, { recursive: true });

      // Only create project settings (no local)
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "project" }] },
            ],
          },
        }),
      );

      const hooks = await loadHooks(tempDir);

      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("project");
    });
  });
});
