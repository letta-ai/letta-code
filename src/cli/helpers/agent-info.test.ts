import { describe, expect, test } from "bun:test";
import {
  getMemoryFilesystemRoot,
  getScopedMemoryFilesystemRoot,
} from "@/agent/memory-filesystem";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { buildAgentInfo } from "@/cli/helpers/agent-info";
import { settingsManager } from "@/settings-manager";

function withTemporaryEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => T,
): T {
  const original = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("agent info reminder", () => {
  test("always includes AGENT_ID env var", () => {
    const agentId = "agent-test-agent-info";
    const context = buildAgentInfo({
      agentInfo: {
        id: agentId,
        name: "Test Agent",
        description: "Test description",
        lastRunAt: null,
      },
    });

    expect(context).toContain(
      `- **Agent ID (also stored in \`AGENT_ID\` env var)**: ${agentId}`,
    );
  });

  test("does not include MEMORY_DIR env var when memfs is disabled", () => {
    const agentId = "agent-test-agent-info-disabled";
    const original = settingsManager.isMemfsEnabled.bind(settingsManager);
    (
      settingsManager as unknown as {
        isMemfsEnabled: (id: string) => boolean;
      }
    ).isMemfsEnabled = () => false;

    try {
      const context = buildAgentInfo({
        agentInfo: {
          id: agentId,
          name: "Test Agent",
          description: "Test description",
          lastRunAt: null,
        },
      });

      expect(context).not.toContain(
        "Memory directory (also stored in `MEMORY_DIR` env var)",
      );
      expect(context).not.toContain(getMemoryFilesystemRoot(agentId));
    } finally {
      (
        settingsManager as unknown as {
          isMemfsEnabled: (id: string) => boolean;
        }
      ).isMemfsEnabled = original;
    }
  });

  test("includes MEMORY_DIR env var when memfs is enabled", () => {
    const agentId = "agent-test-agent-info-enabled";
    const original = settingsManager.isMemfsEnabled.bind(settingsManager);
    (
      settingsManager as unknown as {
        isMemfsEnabled: (id: string) => boolean;
      }
    ).isMemfsEnabled = () => true;

    try {
      const context = buildAgentInfo({
        agentInfo: {
          id: agentId,
          name: "Test Agent",
          description: "Test description",
          lastRunAt: null,
        },
      });

      expect(context).toContain(
        `- **Memory directory (also stored in \`MEMORY_DIR\` env var)**: \`${getMemoryFilesystemRoot(agentId)}\``,
      );
    } finally {
      (
        settingsManager as unknown as {
          isMemfsEnabled: (id: string) => boolean;
        }
      ).isMemfsEnabled = original;
    }
  });

  test("uses local backend MemFS path for local backend agents", () => {
    const agentId = "agent-local-agent-info-enabled";
    const original = settingsManager.isMemfsEnabled.bind(settingsManager);
    (
      settingsManager as unknown as {
        isMemfsEnabled: (id: string) => boolean;
      }
    ).isMemfsEnabled = () => false;

    try {
      withTemporaryEnv({ LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1" }, () => {
        const context = buildAgentInfo({
          agentInfo: {
            id: agentId,
            name: "Test Agent",
            description: "Test description",
            lastRunAt: null,
          },
        });

        expect(getScopedMemoryFilesystemRoot(agentId)).toBe(
          getLocalBackendMemoryFilesystemRoot(agentId),
        );
        expect(context).toContain(
          `- **Memory directory (also stored in \`MEMORY_DIR\` env var)**: \`${getLocalBackendMemoryFilesystemRoot(agentId)}\``,
        );
        expect(context).not.toContain(getMemoryFilesystemRoot(agentId));
      });
    } finally {
      (
        settingsManager as unknown as {
          isMemfsEnabled: (id: string) => boolean;
        }
      ).isMemfsEnabled = original;
    }
  });

  test("includes agent name and description", () => {
    const context = buildAgentInfo({
      agentInfo: {
        id: "agent-test",
        name: "My Agent",
        description: "Does cool stuff",
        lastRunAt: null,
      },
    });

    expect(context).toContain("**Agent name**: My Agent");
    expect(context).toContain("**Agent description**: Does cool stuff");
  });

  test("does not include server location", () => {
    const context = buildAgentInfo({
      agentInfo: {
        id: "agent-test",
        name: "Test Agent",
        lastRunAt: null,
      },
    });

    expect(context).not.toContain("Server location");
  });

  test("includes CONVERSATION_ID when provided", () => {
    const convId = "conv-abc123";
    const context = buildAgentInfo({
      agentInfo: {
        id: "agent-test",
        name: "Test Agent",
        lastRunAt: null,
      },
      conversationId: convId,
    });

    expect(context).toContain(
      `- **Conversation ID (also stored in \`CONVERSATION_ID\` env var)**: ${convId}`,
    );
  });

  test("omits CONVERSATION_ID when not provided", () => {
    const context = buildAgentInfo({
      agentInfo: {
        id: "agent-test",
        name: "Test Agent",
        lastRunAt: null,
      },
    });

    expect(context).not.toContain("Conversation ID");
  });

  test("does not include device information", () => {
    const context = buildAgentInfo({
      agentInfo: {
        id: "agent-test",
        name: "Test Agent",
        lastRunAt: null,
      },
    });

    expect(context).not.toContain("## Device Information");
    expect(context).not.toContain("Local time");
    expect(context).not.toContain("Git repository");
  });
});
