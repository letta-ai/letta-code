import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMatchingHooks,
  hasHooksForEvent,
  loadHooks,
  loadProjectHooks,
  loadProjectLocalHooks,
  matchesTool,
  mergeHooksConfigs,
} from "../../hooks/loader";
import {
  type CommandHookConfig,
  type HookCommand,
  type HookEvent,
  type HooksConfig,
  isToolEvent,
  type SimpleHookEvent,
  type ToolHookEvent,
} from "../../hooks/types";
import { settingsManager } from "../../settings-manager";

// Type-safe helper to extract command from a hook (tests only use command hooks)
function asCommand(
  hook: HookCommand | undefined,
): CommandHookConfig | undefined {
  if (hook && hook.type === "command") {
    return hook as CommandHookConfig;
  }
  return undefined;
}

describe("Hooks Loader", () => {
  let tempDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Reset settings manager FIRST before changing HOME
    await settingsManager.reset();

    const baseDir = join(tmpdir(), `hooks-loader-test-${Date.now()}`);
    // Create separate directories for HOME and project to avoid double-loading
    fakeHome = join(baseDir, "home");
    tempDir = join(baseDir, "project");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    // Override HOME to isolate from real global hooks
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    // Initialize settings manager with new HOME
    await settingsManager.initialize();
  });

  afterEach(async () => {
    // Wait for pending writes and reset
    await settingsManager.reset();

    // Restore HOME
    process.env.HOME = originalHome;
    try {
      // Clean up the parent directory
      const baseDir = join(tempDir, "..");
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
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

    // Note: Caching is now handled by settingsManager, not the loader
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

    test("regex patterns work", () => {
      // .* suffix pattern
      expect(matchesTool("Notebook.*", "Notebook")).toBe(true);
      expect(matchesTool("Notebook.*", "NotebookEdit")).toBe(true);
      expect(matchesTool("Notebook.*", "NotebookRead")).toBe(true);
      expect(matchesTool("Notebook.*", "Edit")).toBe(false);

      // Prefix pattern
      expect(matchesTool(".*Edit", "NotebookEdit")).toBe(true);
      expect(matchesTool(".*Edit", "Edit")).toBe(true);
      expect(matchesTool(".*Edit", "Write")).toBe(false);

      // Character class
      expect(matchesTool("Task|Bash", "Task")).toBe(true);
      expect(matchesTool("Task|Bash", "Bash")).toBe(true);

      // More complex patterns
      expect(matchesTool("Web.*", "WebFetch")).toBe(true);
      expect(matchesTool("Web.*", "WebSearch")).toBe(true);
      expect(matchesTool("Web.*", "Bash")).toBe(false);
    });

    test("invalid regex falls back to exact match", () => {
      // Unclosed bracket is invalid regex
      expect(matchesTool("[invalid", "[invalid")).toBe(true);
      expect(matchesTool("[invalid", "invalid")).toBe(false);
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
      expect(asCommand(bashHooks[0])?.command).toBe("bash hook");

      const editHooks = getMatchingHooks(config, "PreToolUse", "Edit");
      expect(editHooks).toHaveLength(1);
      expect(asCommand(editHooks[0])?.command).toBe("edit hook");
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
      expect(asCommand(hooks[0])?.command).toBe("all tools hook");
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
        // Simple events use SimpleHookMatcher[] (hooks wrapper, no matcher)
        SessionStart: [
          { hooks: [{ type: "command", command: "session hook" }] },
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
      expect(asCommand(hooks[0])?.command).toBe("multi tool");
      expect(asCommand(hooks[1])?.command).toBe("bash specific");
      expect(asCommand(hooks[2])?.command).toBe("wildcard");
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

  describe("All 10 hook events", () => {
    const allEvents: HookEvent[] = [
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
    ];

    test("config can have all 10 event types", () => {
      const config: HooksConfig = {};
      for (const event of allEvents) {
        if (isToolEvent(event)) {
          // Tool events use HookMatcher[]
          (config as Record<ToolHookEvent, unknown>)[event as ToolHookEvent] = [
            {
              matcher: "*",
              hooks: [{ type: "command", command: `echo ${event}` }],
            },
          ];
        } else {
          // Simple events use SimpleHookMatcher[] (hooks wrapper)
          (config as Record<SimpleHookEvent, unknown>)[
            event as SimpleHookEvent
          ] = [{ hooks: [{ type: "command", command: `echo ${event}` }] }];
        }
      }

      for (const event of allEvents) {
        expect(hasHooksForEvent(config, event)).toBe(true);
        const hooks = getMatchingHooks(config, event);
        expect(hooks).toHaveLength(1);
      }
    });

    test("merging preserves all event types", () => {
      const global: HooksConfig = {
        // Tool events use HookMatcher[]
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "g1" }] },
        ],
        // Simple events use SimpleHookMatcher[] (hooks wrapper)
        SessionStart: [{ hooks: [{ type: "command", command: "g2" }] }],
      };

      const project: HooksConfig = {
        // Tool events use HookMatcher[]
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "p1" }] },
        ],
        // Simple events use SimpleHookMatcher[] (hooks wrapper)
        SessionEnd: [{ hooks: [{ type: "command", command: "p2" }] }],
      };

      const merged = mergeHooksConfigs(global, project);

      expect(merged.PreToolUse).toHaveLength(1);
      expect(merged.PostToolUse).toHaveLength(1);
      expect(merged.SessionStart).toHaveLength(1);
      expect(merged.SessionEnd).toHaveLength(1);
    });
  });

  describe("Edge cases", () => {
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
      expect(asCommand(hooks.PreToolUse?.[0]?.hooks[0])?.command).toBe(
        "echo local",
      );
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
      expect(asCommand(merged.PreToolUse?.[0]?.hooks[0])?.command).toBe(
        "local",
      ); // Local first
      expect(asCommand(merged.PreToolUse?.[1]?.hooks[0])?.command).toBe(
        "project",
      ); // Project second
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
      expect(asCommand(merged.PreToolUse?.[0]?.hooks[0])?.command).toBe(
        "local",
      ); // Local first
      expect(asCommand(merged.PreToolUse?.[1]?.hooks[0])?.command).toBe(
        "global",
      ); // Global last
    });

    test("all three levels merge correctly", () => {
      const global: HooksConfig = {
        // Tool event with HookMatcher[]
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "global" }] },
        ],
        // Simple event with SimpleHookMatcher[]
        SessionEnd: [{ hooks: [{ type: "command", command: "global-end" }] }],
      };
      const project: HooksConfig = {
        // Tool event with HookMatcher[]
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "project" }] },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "project-post" }],
          },
        ],
      };
      const projectLocal: HooksConfig = {
        // Tool event with HookMatcher[]
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "local" }] },
        ],
        // Simple event with SimpleHookMatcher[]
        SessionStart: [
          { hooks: [{ type: "command", command: "local-start" }] },
        ],
      };

      const merged = mergeHooksConfigs(global, project, projectLocal);

      // PreToolUse: local -> project -> global
      expect(merged.PreToolUse).toHaveLength(3);
      expect(asCommand(merged.PreToolUse?.[0]?.hooks[0])?.command).toBe(
        "local",
      );
      expect(asCommand(merged.PreToolUse?.[1]?.hooks[0])?.command).toBe(
        "project",
      );
      expect(asCommand(merged.PreToolUse?.[2]?.hooks[0])?.command).toBe(
        "global",
      );

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
              {
                matcher: "*",
                hooks: [{ type: "command", command: "project" }],
              },
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
      expect(asCommand(hooks.PreToolUse?.[0]?.hooks[0])?.command).toBe("local");
      expect(asCommand(hooks.PreToolUse?.[1]?.hooks[0])?.command).toBe(
        "project",
      );
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
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "project" }],
              },
            ],
          },
        }),
      );

      const hooks = await loadHooks(tempDir);

      expect(hooks.PreToolUse).toHaveLength(1);
      expect(asCommand(hooks.PreToolUse?.[0]?.hooks[0])?.command).toBe(
        "project",
      );
    });

    test("does not double-load global hooks when cwd is HOME", async () => {
      const globalSettingsDir = join(fakeHome, ".letta");
      mkdirSync(globalSettingsDir, { recursive: true });

      writeFileSync(
        join(globalSettingsDir, "settings.json"),
        JSON.stringify({
          hooks: {
            Notification: [
              {
                hooks: [
                  { type: "command", command: "echo home-global-notify" },
                ],
              },
            ],
          },
        }),
      );

      // Re-initialize so global settings are re-read from disk after test writes.
      await settingsManager.reset();
      await settingsManager.initialize();

      const hooks = await loadHooks(fakeHome);
      const notificationHooks = getMatchingHooks(hooks, "Notification");

      expect(notificationHooks).toHaveLength(1);
      expect(asCommand(notificationHooks[0])?.command).toBe(
        "echo home-global-notify",
      );

      // In HOME, project settings path collides with global settings path.
      // Project hooks should be treated as empty to avoid duplicate merging.
      const projectHooks = await loadProjectHooks(fakeHome);
      expect(projectHooks).toEqual({});
    });
  });
});
