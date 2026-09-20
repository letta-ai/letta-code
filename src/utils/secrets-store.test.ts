import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __testOverrideLocalSecretStorage,
  __testOverrideSecretsBackend,
  applySecretBatch,
  clearSecretsCache,
  deleteSecretOnServer,
  initSecretsFromServer,
  loadSecrets,
  setSecretOnServer,
} from "./secrets-store";

describe("reserved agent secrets", () => {
  const storage = new Map<string, string>();
  let serverSecrets: Record<string, string> = {};
  const update = mock(
    async (_id: string, body: { secrets: Record<string, string> }) => {
      serverSecrets = body.secrets;
    },
  );

  beforeEach(() => {
    storage.clear();
    serverSecrets = {};
    update.mockClear();
    __testOverrideLocalSecretStorage({
      get: async (key) => storage.get(key) ?? null,
      set: async (key, value) => {
        storage.set(key, value);
      },
      delete: async (key) => storage.delete(key),
    });
    __testOverrideSecretsBackend({
      capabilities: { serverSecrets: true },
      retrieveAgent: async () => ({ secrets: [] }),
      listAgentSecrets: async () =>
        Object.entries(serverSecrets).map(([key, value]) => ({ key, value })),
      updateAgent: update,
    });
  });

  afterEach(() => {
    __testOverrideLocalSecretStorage(null);
    __testOverrideSecretsBackend(null);
    clearSecretsCache(null);
  });

  for (const id of ["agent-reserved-secret", "agent-local-reserved-secret"]) {
    test(`${id} rejects single and batch writes before mutating storage`, async () => {
      for (const key of ["LETTA_API_KEY", "letta_api_key"]) {
        await expect(setSecretOnServer(key, "forbidden", id)).rejects.toThrow(
          "LETTA_API_KEY is managed by Letta and cannot be set as an agent secret.",
        );
        await expect(
          applySecretBatch(
            { set: { OTHER_TOKEN: "allowed", [key]: "forbidden" } },
            id,
          ),
        ).rejects.toThrow(
          "LETTA_API_KEY is managed by Letta and cannot be set as an agent secret.",
        );
      }
      expect(update).not.toHaveBeenCalled();
      expect(storage.size).toBe(0);
      expect(loadSecrets(id)).toEqual({});
    });

    test(`${id} allows ordinary keys including other LETTA names`, async () => {
      await setSecretOnServer("LETTA_OTHER_KEY", "allowed", id);
      await applySecretBatch({ set: { API_TOKEN: "token" } }, id);
      await initSecretsFromServer(id);
      expect(loadSecrets(id)).toEqual({
        LETTA_OTHER_KEY: "allowed",
        API_TOKEN: "token",
      });
    });

    for (const batch of [false, true]) {
      test(`${id} deletes an existing reserved key via ${batch ? "batch" : "single"} mutation`, async () => {
        serverSecrets = {
          LETTA_API_KEY: "old-agent-secret",
          OTHER_TOKEN: "keep",
        };
        storage.set(
          `agent:${id}:secrets:index`,
          JSON.stringify(Object.keys(serverSecrets)),
        );
        for (const [key, value] of Object.entries(serverSecrets)) {
          storage.set(`agent:${id}:secrets:${key}`, value);
        }
        await initSecretsFromServer(id);
        if (batch) {
          expect(
            await applySecretBatch({ unset: ["LETTA_API_KEY"] }, id),
          ).toEqual(["OTHER_TOKEN"]);
        } else {
          expect(await deleteSecretOnServer("LETTA_API_KEY", id)).toBe(true);
        }
        await initSecretsFromServer(id);
        expect(loadSecrets(id)).toEqual({ OTHER_TOKEN: "keep" });
      });
    }
  }
});
