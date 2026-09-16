import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setCurrentAgentId } from "@/agent/context";
import { executeCommand } from "@/cli/commands/registry";
import {
  __testOverrideSecretsBackend,
  clearSecretsCache,
} from "@/utils/secrets-store";

const AGENT_ID = "agent-registry-secret-command";

const listAgentSecretsMock = mock((_agentId: string) =>
  Promise.resolve([] as Array<{ key: string; value: string }>),
);

const updateAgentMock = mock(
  (_agentId: string, _body: unknown, _options?: unknown) =>
    Promise.resolve({ id: AGENT_ID }),
);

const capabilities = {
  remoteMemfs: true,
  serverSideToolManagement: true,
  serverSecrets: true,
  promptRecompile: true,
  byokProviderRefresh: true,
  localModelCatalog: false,
  localMemfs: false,
};

describe("removed AgentFile commands", () => {
  test.each(["/export", "/download"])(
    "%s is not executable",
    async (command) => {
      const result = await executeCommand(command);
      expect(result.success).toBe(false);
      expect(result.notFound).toBe(true);
    },
  );
});

describe("command registry", () => {
  beforeEach(() => {
    listAgentSecretsMock.mockReset();
    updateAgentMock.mockReset();
    listAgentSecretsMock.mockResolvedValue([]);
    updateAgentMock.mockResolvedValue({ id: AGENT_ID });
    setCurrentAgentId(AGENT_ID);
    clearSecretsCache(AGENT_ID);
    __testOverrideSecretsBackend({
      capabilities,
      listAgentSecrets: listAgentSecretsMock,
      updateAgent: updateAgentMock,
    });
  });

  afterEach(() => {
    __testOverrideSecretsBackend(null);
    clearSecretsCache(AGENT_ID);
    setCurrentAgentId(null);
  });

  test("propagates secrets reminder refresh metadata for secret mutations", async () => {
    const setResult = await executeCommand(
      "/secret set registry_token registry-value",
    );

    expect(setResult).toEqual({
      success: true,
      output: "Secret '$REGISTRY_TOKEN' set.",
      refreshSecretsInfo: true,
    });

    listAgentSecretsMock.mockResolvedValueOnce([
      { key: "REGISTRY_TOKEN", value: "registry-value" },
    ]);

    const unsetResult = await executeCommand("/secret unset registry_token");

    expect(unsetResult).toEqual({
      success: true,
      output: "Secret '$REGISTRY_TOKEN' unset.",
      refreshSecretsInfo: true,
    });
  });

  test("does not request a secrets reminder refresh for non-mutating commands", async () => {
    const result = await executeCommand("/secret help");

    expect(result.success).toBe(true);
    expect(result.output).toContain("Secret management commands");
    expect(result.refreshSecretsInfo).toBeUndefined();
  });
});
