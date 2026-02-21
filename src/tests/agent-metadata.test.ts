import { describe, expect, test } from "bun:test";
import { getMemoryFilesystemRoot } from "../agent/memoryFilesystem";
import { buildAgentMetadata } from "../cli/helpers/agentMetadata";
import { settingsManager } from "../settings-manager";

describe("agent metadata reminder", () => {
  test("always includes AGENT_ID env var", () => {
    const agentId = "agent-test-agent-metadata";
    const context = buildAgentMetadata({
      agentInfo: {
        id: agentId,
        name: "Test Agent",
        description: "Test description",
        lastRunAt: null,
      },
      serverUrl: "https://api.letta.com",
    });

    expect(context).toContain(
      `- **Agent ID (also stored in \`AGENT_ID\` env var)**: ${agentId}`,
    );
  });

  test("does not include MEMORY_DIR env var when memfs is disabled", () => {
    const agentId = "agent-test-agent-metadata-disabled";
    const original = settingsManager.isMemfsEnabled.bind(settingsManager);
    (
      settingsManager as unknown as {
        isMemfsEnabled: (id: string) => boolean;
      }
    ).isMemfsEnabled = () => false;

    try {
      const context = buildAgentMetadata({
        agentInfo: {
          id: agentId,
          name: "Test Agent",
          description: "Test description",
          lastRunAt: null,
        },
        serverUrl: "https://api.letta.com",
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
    const agentId = "agent-test-agent-metadata-enabled";
    const original = settingsManager.isMemfsEnabled.bind(settingsManager);
    (
      settingsManager as unknown as {
        isMemfsEnabled: (id: string) => boolean;
      }
    ).isMemfsEnabled = () => true;

    try {
      const context = buildAgentMetadata({
        agentInfo: {
          id: agentId,
          name: "Test Agent",
          description: "Test description",
          lastRunAt: null,
        },
        serverUrl: "https://api.letta.com",
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

  test("includes agent name and description", () => {
    const context = buildAgentMetadata({
      agentInfo: {
        id: "agent-test",
        name: "My Agent",
        description: "Does cool stuff",
        lastRunAt: null,
      },
      serverUrl: "https://api.letta.com",
    });

    expect(context).toContain("**Agent name**: My Agent");
    expect(context).toContain("**Agent description**: Does cool stuff");
  });

  test("includes server location", () => {
    const context = buildAgentMetadata({
      agentInfo: {
        id: "agent-test",
        name: "Test Agent",
        lastRunAt: null,
      },
    });

    expect(context).toContain("**Server location**:");
  });

  test("does not include device information", () => {
    const context = buildAgentMetadata({
      agentInfo: {
        id: "agent-test",
        name: "Test Agent",
        lastRunAt: null,
      },
      serverUrl: "https://api.letta.com",
    });

    expect(context).not.toContain("## Device Information");
    expect(context).not.toContain("Local time");
    expect(context).not.toContain("Git repository");
  });
});
