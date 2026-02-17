import { describe, expect, test } from "bun:test";
import { getMemoryFilesystemRoot } from "../agent/memoryFilesystem";
import { buildSessionContext } from "../cli/helpers/sessionContext";
import { settingsManager } from "../settings-manager";

describe("session context reminder", () => {
  test("always includes AGENT_ID env var", () => {
    const agentId = "agent-test-session-context";
    const context = buildSessionContext({
      agentInfo: {
        id: agentId,
        name: "Test Agent",
        description: "Test description",
        lastRunAt: null,
      },
      serverUrl: "https://api.letta.com",
    });

    expect(context).toContain(`- **Agent ID**: ${agentId}`);
    expect(context).toContain(`- **AGENT_ID env var**: \`${agentId}\``);
  });

  test("does not include MEMORY_DIR env var when memfs is disabled", () => {
    const agentId = "agent-test-session-context-disabled";
    const original = settingsManager.isMemfsEnabled.bind(settingsManager);
    (
      settingsManager as unknown as {
        isMemfsEnabled: (id: string) => boolean;
      }
    ).isMemfsEnabled = () => false;

    try {
      const context = buildSessionContext({
        agentInfo: {
          id: agentId,
          name: "Test Agent",
          description: "Test description",
          lastRunAt: null,
        },
        serverUrl: "https://api.letta.com",
      });

      expect(context).not.toContain("- **MEMORY_DIR env var**:");
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
    const agentId = "agent-test-session-context-enabled";
    const original = settingsManager.isMemfsEnabled.bind(settingsManager);
    (
      settingsManager as unknown as {
        isMemfsEnabled: (id: string) => boolean;
      }
    ).isMemfsEnabled = () => true;

    try {
      const context = buildSessionContext({
        agentInfo: {
          id: agentId,
          name: "Test Agent",
          description: "Test description",
          lastRunAt: null,
        },
        serverUrl: "https://api.letta.com",
      });

      expect(context).toContain(
        `- **MEMORY_DIR env var**: \`${getMemoryFilesystemRoot(agentId)}\``,
      );
    } finally {
      (
        settingsManager as unknown as {
          isMemfsEnabled: (id: string) => boolean;
        }
      ).isMemfsEnabled = original;
    }
  });
});
