import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { composeSubagentChildEnv } from "../../agent/subagents/manager";
import { cliPermissions } from "../../permissions/cli";

const PARENT_ID = "agent-226cd814-09bf-4436-940e-aea9d91d14cb";
const PARENT_MEMORY_DIR = `/Users/someone/.letta/agents/${PARENT_ID}/memory`;

describe("composeSubagentChildEnv", () => {
  beforeEach(() => {
    cliPermissions.clear();
  });

  afterEach(() => {
    cliPermissions.clear();
  });

  test("non-memory subagent still gets parent in LETTA_MEMORY_SCOPE", () => {
    // An explore/general-purpose subagent asked to Read parent memory
    // would previously be denied because scope wasn't propagated for
    // non-memory modes. It must get parent in scope regardless.
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      permissionMode: "default",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.LETTA_MEMORY_SCOPE).toBe(PARENT_ID);
    expect(env.LETTA_PARENT_AGENT_ID).toBe(PARENT_ID);
    expect(env.LETTA_CODE_AGENT_ROLE).toBe("subagent");
    // Non-memory mode: MEMORY_DIR is NOT overridden to parent
    expect(env.MEMORY_DIR).toBeUndefined();
    expect(env.LETTA_MEMORY_DIR).toBeUndefined();
  });

  test("memory-mode subagent with parent + primaryRoot sets both scope and dir", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      permissionMode: "memory",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.LETTA_MEMORY_SCOPE).toBe(PARENT_ID);
    expect(env.LETTA_PARENT_AGENT_ID).toBe(PARENT_ID);
    expect(env.MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
    expect(env.LETTA_MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
    expect(env.LETTA_CODE_AGENT_ROLE).toBe("subagent");
  });

  test("memory-mode subagent with no primaryRoot keeps scope but clears dir", () => {
    // memfs disabled for parent — subagent has auth but no filesystem
    // pointer. Its memory tool calls will error appropriately.
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        // Parent env happened to have stale MEMORY_DIR — must be cleared.
        MEMORY_DIR: "/stale/memory/dir",
      },
      parentAgentId: PARENT_ID,
      permissionMode: "memory",
      inheritedPrimaryRoot: null,
    });

    expect(env.LETTA_MEMORY_SCOPE).toBe(PARENT_ID);
    expect(env.MEMORY_DIR).toBeUndefined();
    expect(env.LETTA_MEMORY_DIR).toBeUndefined();
  });

  test("no parent ID → no scope, no parent ID marker, subagent fully self-scoped", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: undefined,
      permissionMode: "memory",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.LETTA_MEMORY_SCOPE).toBeUndefined();
    expect(env.LETTA_PARENT_AGENT_ID).toBeUndefined();
    // Even in memory mode with an inherited root, without a parent ID
    // the subagent shouldn't claim to operate on parent memory.
    // (We still set MEMORY_DIR here because that's the filesystem pointer
    // decision — the guard will still block cross-agent access because
    // scope is empty.)
    expect(env.MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
  });

  test("non-memory subagent preserves parent's pre-existing MEMORY_DIR", () => {
    // If the developer sourced a .envrc or otherwise had MEMORY_DIR in
    // their listener env, non-memory subagents shouldn't clobber it —
    // they have no opinion about where the fs root should be.
    const existingMemoryDir = "/existing/memory/dir";
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        MEMORY_DIR: existingMemoryDir,
      },
      parentAgentId: PARENT_ID,
      permissionMode: "default",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.LETTA_MEMORY_SCOPE).toBe(PARENT_ID);
    expect(env.MEMORY_DIR).toBe(existingMemoryDir);
  });

  test("memory-mode subagent overrides parent's pre-existing MEMORY_DIR", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        MEMORY_DIR: "/stale/memory/dir",
        LETTA_MEMORY_DIR: "/stale/memory/dir",
      },
      parentAgentId: PARENT_ID,
      permissionMode: "memory",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
    expect(env.LETTA_MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
  });

  test("API key + base URL forwarded when provided", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      permissionMode: "memory",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      inheritedApiKey: "sk-test-key",
      inheritedBaseUrl: "https://api.example.com",
    });

    expect(env.LETTA_API_KEY).toBe("sk-test-key");
    expect(env.LETTA_BASE_URL).toBe("https://api.example.com");
  });

  test("missing API key + base URL preserves parent env values", () => {
    // When auth resolution returns null/undefined, we shouldn't clobber
    // whatever the parent had (could be legitimately set by user).
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        LETTA_API_KEY: "sk-parent-key",
        LETTA_BASE_URL: "https://parent.example.com",
      },
      parentAgentId: PARENT_ID,
      permissionMode: "memory",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      inheritedApiKey: null,
      inheritedBaseUrl: null,
    });

    expect(env.LETTA_API_KEY).toBe("sk-parent-key");
    expect(env.LETTA_BASE_URL).toBe("https://parent.example.com");
  });

  test("preserves inherited env scope and adds the parent agent", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        LETTA_MEMORY_SCOPE: "agent-grandparent,agent-random",
      },
      parentAgentId: PARENT_ID,
      permissionMode: "memory",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(new Set(env.LETTA_MEMORY_SCOPE?.split(",") ?? [])).toEqual(
      new Set([PARENT_ID, "agent-grandparent", "agent-random"]),
    );
  });

  test("preserves CLI memory-scope grants and adds the parent agent", () => {
    cliPermissions.setMemoryScope("agent-shared,agent-ops");

    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
      },
      parentAgentId: PARENT_ID,
      permissionMode: "default",
      inheritedPrimaryRoot: null,
    });

    expect(new Set(env.LETTA_MEMORY_SCOPE?.split(",") ?? [])).toEqual(
      new Set([PARENT_ID, "agent-shared", "agent-ops"]),
    );
  });

  test("LETTA_CODE_AGENT_ROLE is always 'subagent' regardless of mode", () => {
    for (const permissionMode of [
      "memory",
      "default",
      "plan",
      undefined,
    ] as const) {
      const env = composeSubagentChildEnv({
        parentProcessEnv: {},
        parentAgentId: PARENT_ID,
        permissionMode,
        inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      });
      expect(env.LETTA_CODE_AGENT_ROLE).toBe("subagent");
    }
  });

  test("parent process env is inherited (HOME, PATH, etc.)", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        PATH: "/usr/bin:/bin",
        CUSTOM_VAR: "preserved",
      },
      parentAgentId: PARENT_ID,
      permissionMode: "default",
      inheritedPrimaryRoot: null,
    });

    expect(env.HOME).toBe("/home/user");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.CUSTOM_VAR).toBe("preserved");
  });
});
