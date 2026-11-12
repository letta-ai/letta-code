import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setAgentContext } from "@/agent/context";
import { buildEphemeralConversationCreateBody } from "@/agent/ephemeral-conversation";
import type { SubagentConfig } from "@/agent/subagents";
import {
  EPHEMERAL_SUBAGENTS_ENV,
  getEffectiveAgentId,
  lookupDetachedConversationParent,
  resolveDetachedSubagentEnvAgentId,
  resolveEffectiveAgentId,
  resolveEphemeralSubagentLink,
  shouldRunSubagentEphemerally,
} from "@/agent/subagents/ephemeral-subagent";
import { buildSubagentArgs } from "@/agent/subagents/manager";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend/backend";
import { parseCliArgs } from "@/cli/args";
import { validatePrimaryStartupFlagConflicts } from "@/cli/startup-flag-validation";
import {
  initHeadlessSecrets,
  resolveAmbientAgentId,
} from "@/headless-ephemeral-startup";
import { getMcpScopeAgentId } from "@/mcp-scope";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { resolveSecretEnvFromCommand } from "@/tools/secret-substitution";
import {
  __testOverrideSecretsBackend,
  clearSecretsCache,
  ensureSecretsLoaded,
  listSecretNames,
  loadSecrets,
} from "@/utils/secrets-store";
import { SUBAGENT_NAME_ENV } from "@/utils/subagent-launch-marker";

setupRuntimeModelCatalogFixture();

const PARENT = "agent-parent";
const EPHEMERAL = "conv-ephemeral";
const subagentEnv = {
  LETTA_CODE_AGENT_ROLE: "subagent",
  LETTA_PARENT_AGENT_ID: PARENT,
};

const presetConfig: SubagentConfig = {
  name: "explore",
  description: "test",
  systemPrompt: "preset prompt",
  allowedTools: ["Read", "Bash"],
  recommendedModel: "inherit",
  skills: [],
  fork: false,
  launchProfile: "default",
};

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Detached conversations as Cloud returns them, keyed by ID. */
function conversationBackend(
  conversations: Record<string, Record<string, unknown>>,
): Backend {
  return {
    retrieveConversation: async (id: string) => {
      const conversation = conversations[id];
      if (!conversation) throw new Error(`Conversation ${id} not found`);
      return { id, ...conversation };
    },
    // The walk continues at the parent, an ordinary (top-level) agent.
    retrieveAgent: async (id: string) => ({ id, tags: [] }),
  } as unknown as Backend;
}

describe("launch decision", () => {
  test("only fresh Cloud launches run ephemerally", () => {
    expect(shouldRunSubagentEphemerally({ backendMode: "api", env: {} })).toBe(
      true,
    );
    expect(
      shouldRunSubagentEphemerally({ backendMode: "local", env: {} }),
    ).toBe(false);
    // agent_id, conversation_id and fork_context deploy an existing owner.
    expect(
      shouldRunSubagentEphemerally({
        backendMode: "api",
        existingAgentId: "agent-existing",
        env: {},
      }),
    ).toBe(false);
    expect(
      shouldRunSubagentEphemerally({
        backendMode: "api",
        existingConversationId: "conv-fork",
        env: {},
      }),
    ).toBe(false);
    expect(
      shouldRunSubagentEphemerally({
        backendMode: "api",
        environment: "laptop",
        env: {},
      }),
    ).toBe(false);
    for (const value of ["0", "false", "FALSE"]) {
      expect(
        shouldRunSubagentEphemerally({
          backendMode: "api",
          env: { [EPHEMERAL_SUBAGENTS_ENV]: value },
        }),
      ).toBe(false);
    }
  });
});

describe("child arguments", () => {
  test("a fresh subagent runs ephemerally with its preset prompt, model and tools", () => {
    const args = buildSubagentArgs(
      "explore",
      presetConfig,
      "openai/gpt-5.6-luna",
      "hello",
      undefined,
      undefined,
      5,
      {
        backendMode: "api",
        parentAgentId: PARENT,
        extraTools: ["Task"],
        ephemeral: true,
      },
    );

    expect(args).toContain("--ephemeral");
    expect(args).not.toContain("--new-agent");
    expect(args).not.toContain("--tags");
    expect(flagValue(args, "--system")).toBe("explore");
    expect(flagValue(args, "--model")).toBe("openai/gpt-5.6-luna");
    // The toolset is client-side, so the preset allowlist narrows it.
    expect(flagValue(args, "--tools")).toBe("Read,Bash,Task");
    expect(flagValue(args, "--max-turns")).toBe("5");
  });

  test("a prompt override replaces the preset prompt", () => {
    const args = buildSubagentArgs(
      "explore",
      presetConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { systemPromptOverride: "custom persona", ephemeral: true },
    );
    expect(flagValue(args, "--system-custom")).toBe("custom persona");
    expect(args).not.toContain("--system");
  });

  test("memory presets keep their flags but omit agent-only base tools", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...presetConfig, name: "reflection", allowedTools: ["Bash", "Edit"] },
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { platform: "linux", ephemeral: true },
    );
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-system-info-reminder");
    expect(args).not.toContain("--base-tools");
  });

  test("the child accepts the ephemeral argument set", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...presetConfig, skills: ["memory"] },
      "openai/gpt-5.6-luna",
      "hello",
      undefined,
      undefined,
      3,
      { backendMode: "api", promptTransport: "stdin", ephemeral: true },
    );
    const { values } = parseCliArgs(args, true);
    expect(() =>
      validatePrimaryStartupFlagConflicts({
        specifiedConversationId: values.conversation,
        specifiedAgentId: values.agent,
        specifiedAgentName: values.name,
        forceNewAgent: values["new-agent"],
        forceNewConversation: values.new,
        stateless: values.stateless,
        ephemeral: values.ephemeral,
        isHeadless: true,
        memfs: values.memfs,
        memfsStartup: values["memfs-startup"],
      }),
    ).not.toThrow();
    expect(values.ephemeral).toBe(true);
    expect(values["base-tools"]).toBeUndefined();
  });

  test("an inherited AGENT_ID/LETTA_AGENT_ID does not become --agent", () => {
    const args = buildSubagentArgs(
      "general-purpose",
      presetConfig,
      "anthropic/claude-haiku-4-5",
      "hello",
      undefined,
      undefined,
      3,
      { backendMode: "api", promptTransport: "stdin", ephemeral: true },
    );
    const { values } = parseCliArgs(args, true);
    expect(values.backend).toBe("api");
    const parentEnv = { AGENT_ID: PARENT, LETTA_AGENT_ID: PARENT };
    const routed = { routed: true, explicitTarget: false };
    // The non-ephemeral route still infers the ambient agent.
    expect(
      resolveAmbientAgentId({ ...routed, ephemeral: false }, parentEnv),
    ).toBe(PARENT);
    const ambient = resolveAmbientAgentId(
      { ...routed, ephemeral: Boolean(values.ephemeral) },
      parentEnv,
    );
    expect(ambient).toBeUndefined();
    expect(() =>
      validatePrimaryStartupFlagConflicts({
        specifiedConversationId: values.conversation,
        specifiedAgentId: values.agent ?? ambient,
        specifiedAgentName: values.name,
        forceNewAgent: values["new-agent"],
        forceNewConversation: values.new,
        stateless: values.stateless,
        ephemeral: values.ephemeral,
        isHeadless: true,
        memfs: values.memfs,
        memfsStartup: values["memfs-startup"],
      }),
    ).not.toThrow();
  });

  test("agent_id and conversation_id deployments are unchanged", () => {
    const options = { parentAgentId: PARENT, ephemeral: false };
    const deployAgent = buildSubagentArgs(
      "explore",
      presetConfig,
      null,
      "hello",
      "agent-existing",
      undefined,
      undefined,
      options,
    );
    expect(deployAgent).toEqual(
      expect.arrayContaining(["--agent", "agent-existing", "--new"]),
    );
    const deployConversation = buildSubagentArgs(
      "fork",
      presetConfig,
      null,
      "hello",
      undefined,
      "conv-fork",
      undefined,
      options,
    );
    expect(flagValue(deployConversation, "--conv")).toBe("conv-fork");
    for (const args of [deployAgent, deployConversation]) {
      expect(args).not.toContain("--ephemeral");
      expect(args).not.toContain("--new-agent");
      expect(args).not.toContain("--system");
    }
  });

  test("the hidden-agent fallback still tags the new agent", () => {
    const args = buildSubagentArgs(
      "explore",
      presetConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { parentAgentId: PARENT },
    );
    expect(args).toContain("--new-agent");
    expect(flagValue(args, "--tags")).toBe(`type:explore,parent:${PARENT}`);
  });
});

describe("create payload", () => {
  beforeEach(() => {
    __testSetBackend({
      ...conversationBackend({}),
      capabilities: { localMemfs: false },
    } as Backend);
  });
  afterEach(() => __testSetBackend(null));
  test("links the conversation to the parent agent as a named subagent", async () => {
    const body = await buildEphemeralConversationCreateBody(
      { model: "gpt-5.6-luna", systemPromptCustom: "preset prompt" },
      { ...subagentEnv, [SUBAGENT_NAME_ENV]: "Ada" },
    );
    expect(body).toMatchObject({
      model: "openai/gpt-5.6-luna",
      system: "preset prompt",
      parent_agent_id: PARENT,
      is_subagent: true,
      name: "Ada",
    });
    expect(body.context_window_limit).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("agent_id");
    expect(body).not.toHaveProperty("tags");
  });

  test("resolves a subagent preset prompt by type", async () => {
    const body = await buildEphemeralConversationCreateBody(
      { model: "gpt-5.6-luna", systemPromptPreset: "recall" },
      subagentEnv,
    );
    expect(body.system.length).toBeGreaterThan(0);
    expect(body.parent_agent_id).toBe(PARENT);
  });

  test("a plain --ephemeral session has no parent", async () => {
    const body = await buildEphemeralConversationCreateBody(
      { model: "gpt-5.6-luna", systemPromptCustom: "isolated" },
      {},
    );
    expect(body).not.toHaveProperty("parent_agent_id");
    expect(body).not.toHaveProperty("is_subagent");
    expect(
      resolveEphemeralSubagentLink({ LETTA_PARENT_AGENT_ID: PARENT }),
    ).toBe(null);
  });
});

describe("MCP scope", () => {
  afterEach(() => __testSetBackend(null));

  test("a detached subagent conversation inherits from its parent agent", async () => {
    __testSetBackend(
      conversationBackend({
        [EPHEMERAL]: {
          agent_id: null,
          parent_agent_id: PARENT,
          is_subagent: true,
        },
      }),
    );
    expect(await getMcpScopeAgentId(EPHEMERAL, subagentEnv)).toBe(PARENT);
  });

  test("conversations that are not detached subagents keep their own scope", async () => {
    const backend = conversationBackend({
      "conv-owned": { agent_id: "agent-owner", is_subagent: true },
      "conv-plain": { agent_id: null, parent_agent_id: PARENT },
    });
    expect(
      await lookupDetachedConversationParent("conv-owned", backend),
    ).toBeUndefined();
    expect(
      await lookupDetachedConversationParent("conv-plain", backend),
    ).toBeUndefined();
    __testSetBackend(backend);
    expect(await getMcpScopeAgentId("conv-plain", subagentEnv)).toBe(
      "conv-plain",
    );
    // Outside a subagent process the parent linkage is never followed.
    expect(await getMcpScopeAgentId(EPHEMERAL, {})).toBe(EPHEMERAL);
  });
});

describe("secrets", () => {
  afterEach(() => {
    __testOverrideSecretsBackend(null);
    __testSetBackend(null);
    clearSecretsCache(null);
  });

  function vaultBackend(vaults: Record<string, Record<string, string>>) {
    const requested: string[] = [];
    __testOverrideSecretsBackend({
      capabilities: { serverSecrets: true },
      listAgentSecrets: async (agentId) => {
        requested.push(agentId);
        const vault = vaults[agentId];
        if (!vault) throw new Error(`Agent ${agentId} not found`);
        return Object.entries(vault).map(([key, value]) => ({ key, value }));
      },
      updateAgent: async () => {
        throw new Error("unexpected write");
      },
    });
    return requested;
  }

  test("a detached subagent reads its parent agent's vault", async () => {
    const requested = vaultBackend({
      [PARENT]: { API_TOKEN: "parent-token-value" },
    });
    await initHeadlessSecrets(EPHEMERAL, true, PARENT, subagentEnv);

    expect(requested).toEqual([PARENT]);
    expect(loadSecrets(EPHEMERAL)).toEqual({ API_TOKEN: "parent-token-value" });
    expect(listSecretNames(EPHEMERAL)).toEqual(["API_TOKEN"]);
    await ensureSecretsLoaded(EPHEMERAL);
    expect(requested).toEqual([PARENT]);
    expect(
      await resolveSecretEnvFromCommand("curl -H $API_TOKEN", EPHEMERAL),
    ).toEqual({ API_TOKEN: "parent-token-value" });
  });

  test("substitution falls back to the parent through the conversation link", async () => {
    vaultBackend({ [PARENT]: { API_TOKEN: "parent-token-value" } });
    __testSetBackend(
      conversationBackend({
        "conv-unlinked": {
          agent_id: null,
          parent_agent_id: PARENT,
          is_subagent: true,
        },
      }),
    );
    const previous = { ...process.env };
    Object.assign(process.env, subagentEnv);
    try {
      expect(
        await resolveSecretEnvFromCommand("echo $API_TOKEN", "conv-unlinked"),
      ).toEqual({ API_TOKEN: "parent-token-value" });
    } finally {
      for (const key of Object.keys(subagentEnv)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("other sessions keep their existing vault", async () => {
    const requested = vaultBackend({
      "agent-own": { OWN: "own-secret-value" },
    });
    await initHeadlessSecrets("agent-own", false, null, subagentEnv);
    // A detached session that is not a subagent gets no vault.
    await initHeadlessSecrets("conv-plain", true, PARENT, {});
    expect(requested).toEqual(["agent-own"]);
    expect(loadSecrets("conv-plain")).toEqual({});
  });
});

describe("tool env identity", () => {
  test("a detached subagent exports its parent agent as AGENT_ID", () => {
    expect(resolveDetachedSubagentEnvAgentId(EPHEMERAL, subagentEnv)).toBe(
      PARENT,
    );
  });

  test("other sessions keep their own ID", () => {
    expect(
      resolveDetachedSubagentEnvAgentId("agent-child", subagentEnv),
    ).toBeUndefined();
    expect(resolveDetachedSubagentEnvAgentId(EPHEMERAL, {})).toBeUndefined();
    expect(
      resolveDetachedSubagentEnvAgentId(EPHEMERAL, {
        LETTA_PARENT_AGENT_ID: PARENT,
      }),
    ).toBeUndefined();
  });
});

describe("nested launches from a detached subagent", () => {
  afterEach(() => {
    setAgentContext("");
  });

  test("a grandchild links to the real parent agent, not the conversation", () => {
    // Inside an ephemeral child, the session's own ID is its conversation.
    setAgentContext(EPHEMERAL);
    const nestedParent = getEffectiveAgentId(subagentEnv);
    expect(nestedParent).toBe(PARENT);
    // Task passes its notification scope (the conversation ID) explicitly.
    expect(resolveEffectiveAgentId(EPHEMERAL, subagentEnv)).toBe(PARENT);

    const grandchildEnv = composeSubagentChildEnv({
      parentProcessEnv: { ...subagentEnv },
      backendMode: "api",
      localBackendStorageDir: null,
      parentAgentId: nestedParent,
      subagentType: "explore",
      launchProfile: "default",
      inheritedPrimaryRoot: null,
    });
    expect(grandchildEnv.LETTA_PARENT_AGENT_ID).toBe(PARENT);
    expect(resolveEphemeralSubagentLink(grandchildEnv)?.parent_agent_id).toBe(
      PARENT,
    );
  });

  test("ordinary sessions keep their own agent ID", () => {
    setAgentContext("agent-top");
    expect(getEffectiveAgentId({})).toBe("agent-top");
    expect(getEffectiveAgentId(subagentEnv)).toBe("agent-top");
    expect(resolveEffectiveAgentId(EPHEMERAL, {})).toBe(EPHEMERAL);
    expect(resolveEffectiveAgentId(undefined, subagentEnv)).toBeUndefined();
  });
});
