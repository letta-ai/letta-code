import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setCurrentAgentId } from "@/agent/context";
import { handleSecretCommand } from "@/cli/commands/secret";
import {
  __testOverrideSecretsBackend,
  clearSecretsCache,
  loadSecrets,
} from "@/utils/secrets-store";

const AGENT_ID = "agent-secret-command";

const retrieveAgentMock = mock((_agentId: string, _options?: unknown) =>
  Promise.resolve({
    secrets: [] as Array<{ key: string; value: string }>,
  }),
);

const updateAgentMock = mock(
  (_agentId: string, _body: unknown, _options?: unknown) =>
    Promise.resolve({ id: AGENT_ID }),
);

const capabilities = {
  remoteMemfs: true,
  serverSideToolManagement: true,
  serverSecrets: true,
  agentFileImportExport: true,
  promptRecompile: true,
  byokProviderRefresh: true,
  localModelCatalog: false,
  localMemfs: false,
};

describe("/secret command", () => {
  beforeEach(() => {
    retrieveAgentMock.mockReset();
    updateAgentMock.mockReset();
    retrieveAgentMock.mockResolvedValue({ secrets: [] });
    updateAgentMock.mockResolvedValue({ id: AGENT_ID });
    setCurrentAgentId(AGENT_ID);
    clearSecretsCache(AGENT_ID);
    __testOverrideSecretsBackend({
      capabilities,
      retrieveAgent: retrieveAgentMock,
      updateAgent: updateAgentMock,
    });
  });

  afterEach(() => {
    __testOverrideSecretsBackend(null);
    clearSecretsCache(AGENT_ID);
    setCurrentAgentId(null);
  });

  test("list refreshes server secrets instead of trusting an empty local cache", async () => {
    retrieveAgentMock.mockResolvedValueOnce({
      secrets: [{ key: "CLOUDFLARE_API_TOKEN", value: "cf-token" }],
    });

    const result = await handleSecretCommand(["list"]);

    expect(retrieveAgentMock).toHaveBeenCalledWith(AGENT_ID, {
      include: ["agent.secrets"],
    });
    expect(result.output).toContain("Available secrets (1):");
    expect(result.output).toContain("$CLOUDFLARE_API_TOKEN");
    expect(result.output).not.toContain("No secrets stored");
    expect(loadSecrets(AGENT_ID)).toEqual({
      CLOUDFLARE_API_TOKEN: "cf-token",
    });
  });

  test("set refreshes before patching so existing server secrets are preserved", async () => {
    retrieveAgentMock.mockResolvedValueOnce({
      secrets: [{ key: "CLOUDFLARE_API_TOKEN", value: "cf-token" }],
    });

    const result = await handleSecretCommand(["set", "new_token", "new-value"]);

    expect(result.output).toBe("Secret '$NEW_TOKEN' set.");
    expect(result.refreshSecretsInfo).toBe(true);
    expect(updateAgentMock).toHaveBeenCalledWith(AGENT_ID, {
      secrets: {
        CLOUDFLARE_API_TOKEN: "cf-token",
        NEW_TOKEN: "new-value",
      },
    });
  });

  test("unset refreshes before checking whether the secret exists", async () => {
    retrieveAgentMock.mockResolvedValueOnce({
      secrets: [{ key: "CLOUDFLARE_API_TOKEN", value: "cf-token" }],
    });

    const result = await handleSecretCommand(["unset", "CLOUDFLARE_API_TOKEN"]);

    expect(result.output).toBe("Secret '$CLOUDFLARE_API_TOKEN' unset.");
    expect(result.refreshSecretsInfo).toBe(true);
    expect(updateAgentMock).toHaveBeenCalledWith(AGENT_ID, { secrets: {} });
  });

  test("unchanged or invalid commands do not request a secrets reminder refresh", async () => {
    const invalidSet = await handleSecretCommand(["set", "1bad", "value"]);
    const missingValue = await handleSecretCommand(["set", "TOKEN"]);
    const missingUnset = await handleSecretCommand(["unset", "MISSING_TOKEN"]);

    expect(invalidSet.refreshSecretsInfo).toBeUndefined();
    expect(missingValue.refreshSecretsInfo).toBeUndefined();
    expect(missingUnset.refreshSecretsInfo).toBeUndefined();
  });
});
