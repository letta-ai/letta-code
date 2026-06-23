import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setCurrentAgentId } from "@/agent/context";
import { handleSecretCommand } from "@/cli/commands/secret";
import {
  extractSecretEnvFromCommand,
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import {
  __testOverrideLocalSecretStorage,
  __testOverrideSecretsBackend,
  applySecretBatch,
  clearSecretsCache,
  loadSecrets,
  refreshAndListSecrets,
  setSecretOnServer,
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

function installLocalSecretStorage(values = new Map<string, string>()) {
  __testOverrideLocalSecretStorage({
    delete: async (name) => values.delete(name),
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => {
      values.set(name, value);
    },
  });
  return values;
}

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
    __testOverrideLocalSecretStorage(null);
    setCurrentAgentId(null);
    clearSecretsCache(null);
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

  test("local agent set, list, and unset use local secure storage", async () => {
    const localAgentId = "agent-local-secret-command";
    const storage = installLocalSecretStorage();
    setCurrentAgentId(localAgentId);
    clearSecretsCache(localAgentId);

    const setResult = await handleSecretCommand([
      "set",
      "exa_api_key",
      "local-secret-value",
    ]);

    expect(setResult.output).toBe("Secret '$EXA_API_KEY' set.");
    expect(setResult.refreshSecretsInfo).toBe(true);
    expect(updateAgentMock).not.toHaveBeenCalled();
    expect(loadSecrets(localAgentId)).toEqual({
      EXA_API_KEY: "local-secret-value",
    });

    clearSecretsCache(localAgentId);
    const listResult = await handleSecretCommand(["list"]);

    expect(listResult.output).toContain("Available secrets (1):");
    expect(listResult.output).toContain("$EXA_API_KEY");
    expect(listResult.output).not.toContain("local-secret-value");
    expect(loadSecrets(localAgentId)).toEqual({
      EXA_API_KEY: "local-secret-value",
    });
    expect(storage.get(`agent:${localAgentId}:secrets:index`)).toBe(
      '["EXA_API_KEY"]',
    );

    const unsetResult = await handleSecretCommand(["unset", "EXA_API_KEY"]);

    expect(unsetResult.output).toBe("Secret '$EXA_API_KEY' unset.");
    expect(unsetResult.refreshSecretsInfo).toBe(true);
    expect(loadSecrets(localAgentId)).toEqual({});

    const emptyListResult = await handleSecretCommand(["list"]);
    expect(emptyListResult.output).toContain("No secrets stored.");
  });

  test("local agent secrets are scoped by agent id", async () => {
    const firstAgentId = "agent-local-first-secret-command";
    const secondAgentId = "agent-local-second-secret-command";
    installLocalSecretStorage();

    setCurrentAgentId(firstAgentId);
    await handleSecretCommand(["set", "api_token", "first-secret"]);

    setCurrentAgentId(secondAgentId);
    clearSecretsCache(secondAgentId);
    const secondList = await handleSecretCommand(["list"]);

    expect(secondList.output).toContain("No secrets stored.");
    expect(
      extractSecretEnvFromCommand("echo $API_TOKEN", secondAgentId),
    ).toEqual({});

    setCurrentAgentId(firstAgentId);
    clearSecretsCache(firstAgentId);
    const firstList = await handleSecretCommand(["list"]);

    expect(firstList.output).toContain("$API_TOKEN");
    expect(
      extractSecretEnvFromCommand("echo $API_TOKEN", firstAgentId),
    ).toEqual({ API_TOKEN: "first-secret" });
    expect(scrubSecretsFromString("value=first-secret", firstAgentId)).toBe(
      "value=API_TOKEN=<REDACTED>",
    );
  });

  test("local agent mutations validate keys before writing secure storage", async () => {
    const localAgentId = "agent-local-invalid-secret-command";
    const storage = installLocalSecretStorage();

    await expect(
      applySecretBatch({ set: { "1BAD": "value" } }, localAgentId),
    ).rejects.toThrow(
      "Invalid secret name '1BAD'. Use uppercase letters, numbers, and underscores only. Must start with a letter or underscore.",
    );
    expect([...storage.entries()]).toEqual([]);

    await expect(
      setSecretOnServer("bad-name", "value", localAgentId),
    ).rejects.toThrow(
      "Invalid secret name 'bad-name'. Use uppercase letters, numbers, and underscores only. Must start with a letter or underscore.",
    );
    expect([...storage.entries()]).toEqual([]);
  });

  test("local agent batch apply supports list modal operations", async () => {
    const localAgentId = "agent-local-secret-batch";
    installLocalSecretStorage();

    const names = await applySecretBatch(
      {
        set: { API_TOKEN: "first", OTHER_TOKEN: "second" },
      },
      localAgentId,
    );

    expect(names).toEqual(["API_TOKEN", "OTHER_TOKEN"]);
    expect(await refreshAndListSecrets(localAgentId)).toEqual([
      { key: "API_TOKEN", value: "first" },
      { key: "OTHER_TOKEN", value: "second" },
    ]);

    const nextNames = await applySecretBatch(
      {
        set: { THIRD_TOKEN: "third" },
        unset: ["API_TOKEN"],
      },
      localAgentId,
    );

    expect(nextNames).toEqual(["OTHER_TOKEN", "THIRD_TOKEN"]);
    expect(await refreshAndListSecrets(localAgentId)).toEqual([
      { key: "OTHER_TOKEN", value: "second" },
      { key: "THIRD_TOKEN", value: "third" },
    ]);
  });
});
