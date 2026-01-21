import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearHooksCache,
  loadProjectHooks,
  mergeHooksConfigs,
  matchesTool,
  getMatchingHooks,
} from "../../hooks/loader";
import type { HooksConfig } from "../../hooks/types";

describe("Hooks Loader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hooks-loader-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    clearHooksCache();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
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
  });
});
