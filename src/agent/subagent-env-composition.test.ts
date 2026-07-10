import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  composeSubagentChildEnv,
  resolveSubagentInheritedPrimaryRoot,
} from "@/agent/subagents/manager";
import { LETTA_INHERITED_CHANNEL_CONTEXT_ENV } from "@/runtime-context";

const PARENT_ID = "agent-226cd814-09bf-4436-940e-aea9d91d14cb";
const PARENT_MEMORY_DIR = `/Users/someone/.letta/agents/${PARENT_ID}/memory`;

describe("composeSubagentChildEnv", () => {
  test("normal subagent records parent identity without overriding memory dir", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      launchProfile: "default",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.LETTA_PARENT_AGENT_ID).toBe(PARENT_ID);
    expect(env.LETTA_CODE_AGENT_ROLE).toBe("subagent");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    // Default launch profile: MEMORY_DIR is NOT overridden to parent
    expect(env.MEMORY_DIR).toBeUndefined();
    expect(env.LETTA_MEMORY_DIR).toBeUndefined();
  });

  test("memory subagent with parent + primaryRoot sets parent marker and dir", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.LETTA_PARENT_AGENT_ID).toBe(PARENT_ID);
    expect(env.MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
    expect(env.LETTA_MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
    expect(env.LETTA_CODE_AGENT_ROLE).toBe("subagent");
  });

  test("memory subagent with no primaryRoot keeps parent marker but clears dir", () => {
    // memfs disabled for parent — subagent knows its parent but has no
    // filesystem pointer. Its memory tool calls will error appropriately.
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        // Parent env happened to have stale MEMORY_DIR — must be cleared.
        MEMORY_DIR: "/stale/memory/dir",
      },
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: null,
    });

    expect(env.LETTA_PARENT_AGENT_ID).toBe(PARENT_ID);
    expect(env.MEMORY_DIR).toBeUndefined();
    expect(env.LETTA_MEMORY_DIR).toBeUndefined();
  });

  test("no parent ID → no parent ID marker, subagent fully self-scoped", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: undefined,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.LETTA_PARENT_AGENT_ID).toBeUndefined();
    // Even in the memory-subagent profile with an inherited root, without a parent
    // ID the subagent shouldn't claim to operate on parent memory.
    // (We still set MEMORY_DIR here because that's the filesystem pointer
    // decision — the guard will still block cross-agent access because
    // there is no parent marker.)
    expect(env.MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
  });

  test("normal subagent preserves parent's pre-existing MEMORY_DIR", () => {
    // If the developer sourced a .envrc or otherwise had MEMORY_DIR in
    // their listener env, default-profile subagents shouldn't clobber it —
    // they have no opinion about where the fs root should be.
    const existingMemoryDir = "/existing/memory/dir";
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        MEMORY_DIR: existingMemoryDir,
      },
      parentAgentId: PARENT_ID,
      launchProfile: "default",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.MEMORY_DIR).toBe(existingMemoryDir);
  });

  test("memory subagent overrides parent's pre-existing MEMORY_DIR", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        MEMORY_DIR: "/stale/memory/dir",
        LETTA_MEMORY_DIR: "/stale/memory/dir",
      },
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
    expect(env.LETTA_MEMORY_DIR).toBe(PARENT_MEMORY_DIR);
  });

  test("memory subagent memoryScope overrides inherited primary root", () => {
    const worktreeDir = `/Users/someone/.letta/agents/${PARENT_ID}/memory-worktrees/reflection-123`;
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        MEMORY_DIR: "/stale/memory/dir",
      },
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      memoryScope: {
        primaryRoot: worktreeDir,
        writableRoots: [worktreeDir],
      },
    });

    expect(env.MEMORY_DIR).toBe(worktreeDir);
    expect(env.LETTA_MEMORY_DIR).toBe(worktreeDir);
  });

  test("transcriptPath is forwarded as TRANSCRIPT_PATH env var when set", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      transcriptPath: "/tmp/payload-auto-abc123.json",
    });

    expect(env.TRANSCRIPT_PATH).toBe("/tmp/payload-auto-abc123.json");
  });

  test("TRANSCRIPT_PATH not set when transcriptPath omitted", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.TRANSCRIPT_PATH).toBeUndefined();
  });

  test("TRANSCRIPT_PATH not set when transcriptPath is null", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      transcriptPath: null,
    });

    expect(env.TRANSCRIPT_PATH).toBeUndefined();
  });

  test("API key + base URL forwarded when provided", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      inheritedApiKey: "sk-test-key",
      inheritedBaseUrl: "https://api.example.com",
    });

    expect(env.LETTA_API_KEY).toBe("sk-test-key");
    expect(env.LETTA_BASE_URL).toBe("https://api.example.com");
  });

  test("local backend mode is forwarded explicitly to child process env", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: "0",
      },
      backendMode: "local",
      localBackendStorageDir: "/tmp/lc-local-backend",
      parentAgentId: PARENT_ID,
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
    });

    expect(env.LETTA_LOCAL_BACKEND_EXPERIMENTAL).toBe("1");
    expect(env.LETTA_LOCAL_BACKEND_DIR).toBe("/tmp/lc-local-backend");
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
      launchProfile: "memory-subagent",
      inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      inheritedApiKey: null,
      inheritedBaseUrl: null,
    });

    expect(env.LETTA_API_KEY).toBe("sk-parent-key");
    expect(env.LETTA_BASE_URL).toBe("https://parent.example.com");
  });

  test("LETTA_CODE_AGENT_ROLE is always 'subagent' regardless of launch profile", () => {
    for (const launchProfile of [
      "memory-subagent",
      "default",
      undefined,
    ] as const) {
      const env = composeSubagentChildEnv({
        parentProcessEnv: {},
        parentAgentId: PARENT_ID,
        launchProfile,
        inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      });
      expect(env.LETTA_CODE_AGENT_ROLE).toBe("subagent");
      expect(env.DISABLE_AUTOUPDATER).toBe("1");
    }
  });

  test("subagent child env force-disables startup auto-update", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        DISABLE_AUTOUPDATER: "0",
      },
      parentAgentId: PARENT_ID,
      launchProfile: "default",
      inheritedPrimaryRoot: null,
    });

    expect(env.DISABLE_AUTOUPDATER).toBe("1");
  });

  test("parent process env is inherited (HOME, PATH, etc.)", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: {
        HOME: "/home/user",
        PATH: "/usr/bin:/bin",
        CUSTOM_VAR: "preserved",
      },
      parentAgentId: PARENT_ID,
      launchProfile: "default",
      inheritedPrimaryRoot: null,
    });

    expect(env.HOME).toBe("/home/user");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.CUSTOM_VAR).toBe("preserved");
  });
  test("inherited channel context is serialized for child process scope", () => {
    const env = composeSubagentChildEnv({
      parentProcessEnv: { HOME: "/home/user" },
      parentAgentId: PARENT_ID,
      launchProfile: "default",
      inheritedPrimaryRoot: null,
      inheritedChannelContext: {
        channelToolScope: {
          channels: [{ channelId: "telegram", accountId: "account-1" }],
        },
        channelTurnSources: [
          {
            channel: "telegram",
            accountId: "account-1",
            chatId: "7952253975",
            chatType: "channel",
            threadId: "42",
            agentId: PARENT_ID,
            conversationId: "default",
          },
        ],
      },
    });

    expect(env[LETTA_INHERITED_CHANNEL_CONTEXT_ENV]).toBe(
      JSON.stringify({
        channelToolScope: {
          channels: [{ channelId: "telegram", accountId: "account-1" }],
        },
        channelTurnSources: [
          {
            channel: "telegram",
            accountId: "account-1",
            chatId: "7952253975",
            chatType: "channel",
            threadId: "42",
            agentId: PARENT_ID,
            conversationId: "default",
          },
        ],
      }),
    );
  });
});

describe("resolveSubagentInheritedPrimaryRoot", () => {
  test("uses the local backend MemFS root for local backend parent agents", () => {
    expect(
      resolveSubagentInheritedPrimaryRoot({
        backendMode: "local",
        parentAgentId: PARENT_ID,
        inheritedPrimaryRoot: "/Users/someone/.letta/agents/stale/memory",
        localBackendStorageDir: "/tmp/lc-local-backend",
      }),
    ).toBe(join("/tmp/lc-local-backend", "memfs", PARENT_ID, "memory"));
  });

  test("keeps the resolved remote MemFS root for API backend agents", () => {
    expect(
      resolveSubagentInheritedPrimaryRoot({
        backendMode: "api",
        parentAgentId: PARENT_ID,
        inheritedPrimaryRoot: PARENT_MEMORY_DIR,
      }),
    ).toBe(PARENT_MEMORY_DIR);
  });
});
