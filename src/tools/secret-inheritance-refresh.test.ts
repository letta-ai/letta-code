import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testSetBackend, type Backend } from "@/backend";
import { listAvailableSecretNames } from "@/reminders/engine";
import { runWithRuntimeContext } from "@/runtime-context";
import { resolveSecretEnvFromCommand } from "@/tools/secret-substitution";
import {
  __testOverrideSecretsBackend,
  __testSetSecretsMaxAgeMs,
  clearSecretsCache,
  ensureSecretsLoaded,
  loadSecrets,
} from "@/utils/secrets-store";

const CHILD = "agent-secret-refresh-child";
const PARENT = "agent-secret-refresh-parent";

// A subagent on a connected computer reads its parent's vault through the
// shared cache. A secret added to the parent after that cache was first
// filled must still reach the subagent once the entry goes stale.
describe("inherited secrets refresh", () => {
  let parentVault: Record<string, string>;
  let fetches: string[];
  let failFetch: boolean;

  beforeEach(() => {
    parentVault = { OLD_SECRET: "old-secret-value" };
    fetches = [];
    failFetch = false;
    __testOverrideSecretsBackend({
      capabilities: { serverSecrets: true },
      listAgentSecrets: async (agentId) => {
        fetches.push(agentId);
        if (failFetch) throw new Error("vault unavailable");
        const vault = agentId === PARENT ? parentVault : {};
        return Object.entries(vault).map(([key, value]) => ({ key, value }));
      },
      updateAgent: async () => ({}),
    });
    __testSetBackend({
      retrieveAgent: async (agentId: string) =>
        agentId === CHILD
          ? { tags: ["role:subagent", `parent:${PARENT}`] }
          : { tags: [] },
    } as unknown as Backend);
  });

  afterEach(() => {
    __testOverrideSecretsBackend(null);
    __testSetBackend(null);
    __testSetSecretsMaxAgeMs(null);
    clearSecretsCache(CHILD);
    clearSecretsCache(PARENT);
  });

  function asSubagent<T>(fn: () => T): T {
    return runWithRuntimeContext(
      {
        agentId: CHILD,
        executionSettings: {
          allowed_tools: [],
          disallowed_tools: [],
          disable_memory_guard: false,
          agent_role: "subagent",
          parent_agent_id: PARENT,
        },
      },
      fn,
    );
  }

  test("a secret added to the parent later resolves after the entry goes stale", async () => {
    const command = 'echo "$OLD_SECRET" "$NEW_SECRET"';
    const first = await asSubagent(() =>
      resolveSecretEnvFromCommand(command, CHILD),
    );
    expect(first).toEqual({ OLD_SECRET: "old-secret-value" });

    parentVault.NEW_SECRET = "new-secret-value";

    // Within the freshness window the cached parent vault is reused.
    const cached = await asSubagent(() =>
      resolveSecretEnvFromCommand(command, CHILD),
    );
    expect(cached.NEW_SECRET).toBeUndefined();

    // Once the entry is stale, the next lookup re-fetches the parent vault.
    __testSetSecretsMaxAgeMs(0);
    const refreshed = await asSubagent(() =>
      resolveSecretEnvFromCommand(command, CHILD),
    );
    expect(refreshed).toEqual({
      OLD_SECRET: "old-secret-value",
      NEW_SECRET: "new-secret-value",
    });
  });

  test("the subagent's secret name list picks up the refreshed parent vault", async () => {
    const lookupParent = async (agentId: string) =>
      agentId === CHILD ? PARENT : undefined;
    const before = await asSubagent(() =>
      listAvailableSecretNames(CHILD, lookupParent),
    );
    expect(before).toEqual(["OLD_SECRET"]);

    parentVault.NEW_SECRET = "new-secret-value";
    __testSetSecretsMaxAgeMs(0);
    const after = await asSubagent(() =>
      listAvailableSecretNames(CHILD, lookupParent),
    );
    expect(after).toEqual(["NEW_SECRET", "OLD_SECRET"]);
  });

  test("a failed refresh keeps the previously loaded secrets", async () => {
    await ensureSecretsLoaded(PARENT);
    failFetch = true;
    __testSetSecretsMaxAgeMs(0);
    await ensureSecretsLoaded(PARENT);
    expect(loadSecrets(PARENT)).toEqual({ OLD_SECRET: "old-secret-value" });
  });

  test("concurrent stale lookups share one fetch", async () => {
    await ensureSecretsLoaded(PARENT);
    fetches = [];
    __testSetSecretsMaxAgeMs(0);
    await Promise.all([
      ensureSecretsLoaded(PARENT),
      ensureSecretsLoaded(PARENT),
    ]);
    expect(fetches).toEqual([PARENT]);
  });
});
