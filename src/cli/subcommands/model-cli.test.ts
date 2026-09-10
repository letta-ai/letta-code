import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real CLI subprocesses and disk-backed local backend; no inference or mocks.
describe("model CLI", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let agentId: string;
  let otherAgentId: string;
  let conversationId: string;
  let initialModel: string;
  let nextModel: string;
  let models: {
    id: string;
    handle: string;
    reasoning_levels?: string[];
  }[];
  let runtimeModels: { handle: string; reasoning_levels?: string[] }[];
  const root = resolve(import.meta.dir, "../../..");

  async function run(
    args: string[],
    overrides: NodeJS.ProcessEnv = {},
    runtime = process.execPath,
  ) {
    const child = Bun.spawn([runtime, ...args], {
      cwd: root,
      env: { ...env, ...overrides },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }

  async function cli(
    args: string[],
    overrides: NodeJS.ProcessEnv = {},
    command = "model",
  ) {
    const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
    return run(
      [bundle || "src/index.ts", "--backend", "local", command, ...args],
      overrides,
      bundle ? "node" : process.execPath,
    );
  }

  async function config(
    args: string[] = [],
    overrides: NodeJS.ProcessEnv = {},
  ) {
    // Inspect persisted state directly; don't retain a public diagnostic
    // command just to compare both scopes in regression tests.
    const explicitAgent = args[0] === "--agent" ? args[1] : undefined;
    const explicitConversation = ["--conversation", "--conv"].includes(
      args[0] ?? "",
    )
      ? args[1]
      : undefined;
    const result = await run(
      [
        "-e",
        `
      import { configureBackendMode, getBackend } from "./src/backend/backend";
      import { buildAgentConfigReport } from "./src/cli/subcommands/model";
      configureBackendMode("local");
      const backend = getBackend();
      const explicitAgent = ${JSON.stringify(explicitAgent)};
      const conversationId = explicitAgent ? undefined : (${JSON.stringify(explicitConversation)} ?? process.env.CONVERSATION_ID);
      const conversation = conversationId && conversationId !== "default"
        ? await backend.retrieveConversation(conversationId) : null;
      const agent = await backend.retrieveAgent(explicitAgent ?? conversation?.agent_id ?? process.env.AGENT_ID);
      console.log(JSON.stringify(buildAgentConfigReport(agent, conversation)));
    `,
      ],
      overrides,
    );
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "letta-model-cli-"));
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LETTA_LOCAL_BACKEND_DIR: join(home, "backend"),
      LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
      LETTA_API_KEY: undefined,
      AGENT_ID: undefined,
      CONVERSATION_ID: undefined,
      LETTA_DEBUG: "0",
      LETTA_DISABLE_MODS: "1",
    };
    const fixture = await run([
      "-e",
      `
      import { configureBackendMode, getBackend } from "./src/backend/backend";
      import { createOrUpdateLocalProvider } from "./src/backend/local";
      import { LOCAL_GOOGLE_AI_PROVIDER_NAME } from "./src/backend/dev/pi-provider-registry";
      configureBackendMode("local");
      for (const providerType of ["openai", "anthropic", "google_ai"]) {
        await createOrUpdateLocalProvider({
          providerType, providerName: providerType === "google_ai" ? LOCAL_GOOGLE_AI_PROVIDER_NAME : "lc-" + providerType, apiKey: "unused-config-test",
          storageDir: process.env.LETTA_LOCAL_BACKEND_DIR,
        });
      }
      const backend = getBackend();
      const models = await backend.listModels();
      const handles = [...new Set(models.map(m => m.handle).filter(h => h?.startsWith("openai/")))];
      if (handles.length < 2) throw new Error("Expected two real runtime catalog models");
      const agent = await backend.createAgent({ name: "CLI model test", model: handles[0] });
      const other = await backend.createAgent({ name: "Other CLI agent", model: handles[0] });
      const conversation = await backend.createConversation({ agent_id: agent.id });
      console.log(JSON.stringify({ agentId: agent.id, otherAgentId: other.id,
        conversationId: conversation.id, initialModel: handles[0], nextModel: handles[1], models }));
    `,
    ]);
    expect(fixture.code, fixture.stderr).toBe(0);
    ({
      agentId,
      otherAgentId,
      conversationId,
      initialModel,
      nextModel,
      models: runtimeModels,
    } = JSON.parse(fixture.stdout));
    env.AGENT_ID = agentId;
    env.CONVERSATION_ID = conversationId;
    const listed = await cli(["list"]);
    expect(listed.code, listed.stderr).toBe(0);
    models = JSON.parse(listed.stdout);
  }, 30000);

  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  test("removes agents config and its help/options", async () => {
    const removed = await cli(["config"], {}, "agents");
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain("Unknown action: config");
    const help = await cli(["--help"], {}, "agents");
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("letta agents list");
    expect(help.stdout).toContain("letta agents create");
    expect(help.stdout).not.toContain("agents config");
    expect(help.stdout).not.toContain("--conversation");
    const legacyOption = await cli(["list", "--agent", agentId], {}, "agents");
    expect(legacyOption.code).toBe(1);
  }, 30000);

  test("lists the runtime catalog without a target", async () => {
    const result = await cli(["list"], {
      AGENT_ID: undefined,
      CONVERSATION_ID: undefined,
    });
    expect(result.code, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout);
    expect(Array.isArray(rows)).toBe(true);
    expect(new Set(rows.map((row: { handle: string }) => row.handle))).toEqual(
      new Set(runtimeModels.map((row) => row.handle)),
    );
    for (const row of rows) {
      const model = runtimeModels.find((entry) => entry.handle === row.handle);
      if (!model) throw new Error(`Unexpected catalog handle: ${row.handle}`);
      expect(typeof row.id).toBe("string");
      expect(typeof row.label).toBe("string");
      expect(row.context_window_limit).toBeGreaterThan(0);
      expect(row.reasoning_levels).toEqual(
        (model.reasoning_levels ?? []).map((level) =>
          level === "off" ? "none" : level,
        ),
      );
    }
  }, 30000);

  test("filters the local inventory as BYOK, with no hosted models", async () => {
    const byok = await cli(["list", "--byok"]);
    expect(byok.code, byok.stderr).toBe(0);
    expect(JSON.parse(byok.stdout)).toEqual(models);
    const hosted = await cli(["list", "--hosted"]);
    expect(hosted.code, hosted.stderr).toBe(0);
    expect(JSON.parse(hosted.stdout)).toEqual([]);
    const alias = await cli(["list", "--byok"], {}, "models");
    expect(alias.code, alias.stderr).toBe(0);
    expect(JSON.parse(alias.stdout)).toEqual(models);
  }, 30000);

  test("rejects conflicting and misplaced model category filters", async () => {
    for (const args of [
      ["list", "--byok", "--hosted"],
      ["get", "--byok"],
      ["set", nextModel, "--hosted"],
    ]) {
      const result = await cli(args);
      expect(result.code, result.stderr).toBe(1);
    }
  }, 30000);

  test("infers current conversation and agent, persists across CLI processes", async () => {
    const result = await cli(["set", nextModel]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      agent: { id: agentId, model: initialModel },
      conversation: { id: conversationId, agent_id: agentId, model: nextModel },
      effective: { scope: "conversation", model: nextModel },
    });
    const saved = await config();
    expect(saved.effective.model).toBe(nextModel);
    expect(saved.effective.model_settings.provider_type).toBe("openai");
    expect(saved.effective.model_settings.max_tokens).toBeGreaterThan(0);
    expect(saved.effective.model_settings.parallel_tool_calls).toBe(true);
    expect(result.stdout).not.toContain("unused-config-test");
    const current = await cli(["get"]);
    expect(current.code, current.stderr).toBe(0);
    expect(JSON.parse(current.stdout)).toEqual({
      model: saved.effective.model,
      context_window_limit: saved.effective.context_window_limit,
      model_settings: saved.effective.model_settings,
    });
  }, 30000);

  test("get --default returns only agent defaults, ignoring the ambient conversation", async () => {
    const saved = await config(["--agent", agentId]);
    const expected = {
      model: saved.effective.model,
      context_window_limit: saved.effective.context_window_limit,
      model_settings: saved.effective.model_settings,
    };
    const result = await cli(["get", "--default"], {
      CONVERSATION_ID: "conv-stale",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
    const inferred = await cli(["get", "--default"], { AGENT_ID: undefined });
    expect(inferred.code, inferred.stderr).toBe(0);
    expect(JSON.parse(inferred.stdout)).toEqual(expected);
    const explicit = await cli(["get", "--default", "--agent", agentId]);
    expect(explicit.code, explicit.stderr).toBe(0);
    expect(JSON.parse(explicit.stdout)).toEqual(expected);
  }, 30000);

  test("set --default changes agent defaults without altering the conversation", async () => {
    const before = await config();
    const changed = await cli(["set", nextModel, "--default"]);
    expect(changed.code, changed.stderr).toBe(0);
    const after = await config();
    expect(after.agent.model).toBe(nextModel);
    expect(after.conversation).toEqual(before.conversation);
    const restored = await cli(["set", before.agent.model, "--default"]);
    expect(restored.code, restored.stderr).toBe(0);
  }, 30000);

  test("rejects conflicting default scope and default on list", async () => {
    for (const args of [
      ["get", "--default", "--conversation", conversationId],
      ["set", nextModel, "--default", "--conversation", conversationId],
      ["list", "--default"],
    ]) {
      const result = await cli(args);
      expect(result.code, result.stderr).toBe(1);
    }
  }, 30000);

  test("resolves a short name and catalog ID", async () => {
    const preset = models.find((m) => m.handle === nextModel);
    if (!preset) throw new Error("Missing runtime preset");
    for (const identifier of [
      nextModel.split("/").slice(1).join("/"),
      preset.id,
    ]) {
      const result = await cli(["set", identifier]);
      expect(result.code, result.stderr).toBe(0);
      expect((await config()).effective.model).toBe(nextModel);
    }
  }, 30000);

  test("explicit agent ignores ambient conversation and leaves overrides intact", async () => {
    const before = await config();
    const result = await cli(["set", nextModel, "--agent", otherAgentId]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      agent: { id: otherAgentId, model: nextModel },
      conversation: null,
      effective: { scope: "agent", model: nextModel },
    });
    expect(await config()).toEqual(before);
  }, 30000);

  test.each([undefined, "default"])(
    "infers AGENT_ID without a persisted conversation (%s)",
    async (conversation) => {
      const result = await cli(["set", nextModel], {
        CONVERSATION_ID: conversation,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        agent: { id: agentId, model: nextModel },
        conversation: null,
        effective: { scope: "agent", model: nextModel },
      });
    },
    30000,
  );

  test("explicit conversation derives its owner, independent of ambient agent", async () => {
    const result = await cli(
      ["set", initialModel, "--conversation", conversationId],
      { AGENT_ID: otherAgentId },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).conversation.model).toBe(initialModel);
    expect((await config()).agent.model).toBe(nextModel);
  }, 30000);

  test.each(["high", "none"])(
    "persists reasoning %s when advertised by the runtime",
    async (level) => {
      const model = models.find(
        (m) =>
          m.handle.startsWith("openai/") && m.reasoning_levels?.includes(level),
      );
      if (!model)
        throw new Error(`Missing runtime model with ${level} reasoning`);
      for (const target of [
        ["--conversation", conversationId],
        ["--agent", otherAgentId],
      ]) {
        const result = await cli([
          "set",
          model.handle,
          "--reasoning",
          level,
          ...target,
        ]);
        expect(result.code, result.stderr).toBe(0);
        expect(
          (await config(target)).effective.model_settings.reasoning
            .reasoning_effort,
        ).toBe(level);
      }
    },
    30000,
  );

  test.each(["anthropic/", "google/"])(
    "preserves runtime reasoning for %s",
    async (prefix) => {
      const model = models.find(
        (entry) =>
          entry.handle.startsWith(prefix) &&
          entry.reasoning_levels?.includes("high"),
      );
      if (!model)
        throw new Error(`No reasoning-capable runtime model for ${prefix}`);
      const result = await cli(["set", model.handle, "--reasoning", "high"]);
      expect(result.code, result.stderr).toBe(0);
      const settings = (await config()).effective.model_settings;
      expect(settings.reasoning_effort).toBe("high");
      const consumed = await run([
        "-e",
        `
      import { configureBackendMode, getBackend } from "./src/backend/backend";
      import { reasoningForSettings } from "./src/backend/dev/pi-model-factory";
      configureBackendMode("local");
      const conversation = await getBackend().retrieveConversation(process.env.CONVERSATION_ID);
      console.log(reasoningForSettings(conversation.model_settings, conversation.model));
    `,
      ]);
      expect(consumed.code, consumed.stderr).toBe(0);
      expect(consumed.stdout.trim()).toBe("high");
      if (prefix === "anthropic/") {
        expect(settings.effort).toBe("high");
        expect(settings.thinking?.type).not.toBe("disabled");
      }
    },
    30000,
  );

  test("rejects invalid and unsupported reasoning without persisting changes", async () => {
    const highModel = models.find((m) => m.reasoning_levels?.includes("high"));
    const unsupported = models.find(
      (m) => !m.reasoning_levels?.includes("high"),
    );
    if (!highModel || !unsupported)
      throw new Error("Missing reasoning capability test models");
    for (const [model, level] of [
      [highModel.handle, "not-a-level"],
      [unsupported.handle, "high"],
    ] as const) {
      for (const target of [
        ["--conversation", conversationId],
        ["--agent", otherAgentId],
      ]) {
        const before = await config(target);
        const result = await cli([
          "set",
          model,
          "--reasoning",
          level,
          ...target,
        ]);
        expect(result.code, result.stderr).toBe(1);
        expect(await config(target)).toEqual(before);
      }
    }
  }, 30000);

  test.each(["conversation", "agent", "inherited"])(
    "reasoning-only set preserves other settings (%s)",
    async (scope) => {
      const model = models.find(
        (entry) =>
          entry.handle.startsWith("openai/") &&
          entry.reasoning_levels?.includes("high") &&
          entry.reasoning_levels.includes("low"),
      );
      if (!model) throw new Error("Missing runtime reasoning model");
      const target = scope === "agent" ? ["--default"] : [];
      const setup = await cli([
        "set",
        model.handle,
        "--reasoning",
        "high",
        ...(scope === "inherited" ? ["--default"] : target),
      ]);
      expect(setup.code, setup.stderr).toBe(0);
      const customized = await run([
        "-e",
        `
      import { configureBackendMode, getBackend } from "./src/backend/backend";
      configureBackendMode("local");
      const backend = getBackend();
      const agent = ${JSON.stringify(scope)} !== "conversation";
      const id = agent ? process.env.AGENT_ID : process.env.CONVERSATION_ID;
      const entity = agent ? await backend.retrieveAgent(id) : await backend.retrieveConversation(id);
      const patch = { context_window_limit: 64000, model_settings: {
        ...entity.model_settings, context_window_limit: 64000,
        max_tokens: 1234, temperature: 0.23, parallel_tool_calls: false,
        api_key: "config-test-only",
      }};
      if (agent) await backend.updateAgent(id, patch); else await backend.updateConversation(id, patch);
      if (${JSON.stringify(scope)} === "inherited") await backend.updateConversation(process.env.CONVERSATION_ID, {
        model: null, model_settings: null, context_window_limit: null,
      });
    `,
      ]);
      expect(customized.code, customized.stderr).toBe(0);
      const reportTarget = scope === "agent" ? ["--agent", agentId] : [];
      const before = await config(reportTarget);
      const result = await cli(["set", "--reasoning", "low", ...target]);
      expect(result.code, result.stderr).toBe(0);
      const after = await config(reportTarget);
      expect(after.effective.model).toBe(before.effective.model);
      expect(after.effective.context_window_limit).toBe(
        before.effective.context_window_limit,
      );
      expect(after.effective.model_settings).toEqual({
        ...before.effective.model_settings,
        reasoning: {
          ...before.effective.model_settings.reasoning,
          reasoning_effort: "low",
        },
        reasoning_effort: "low",
      });
      if (scope !== "agent") expect(after.agent).toEqual(before.agent);
      if (scope === "inherited") expect(after.conversation.model).toBeNull();
      const secretPreserved = await run([
        "-e",
        `
      import { configureBackendMode, getBackend } from "./src/backend/backend";
      configureBackendMode("local");
      const entity = ${JSON.stringify(scope)} === "agent"
        ? await getBackend().retrieveAgent(process.env.AGENT_ID)
        : await getBackend().retrieveConversation(process.env.CONVERSATION_ID);
      console.log(entity.model_settings.api_key === "config-test-only");
    `,
      ]);
      expect(secretPreserved.code, secretPreserved.stderr).toBe(0);
      expect(secretPreserved.stdout.trim()).toBe("true");
    },
    30000,
  );

  test("refuses inconsistent inferred ownership before writing", async () => {
    const before = await config();
    const result = await cli(["set", nextModel], { AGENT_ID: otherAgentId });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not current AGENT_ID");
    expect(await config()).toEqual(before);
  }, 30000);

  test.each([
    [],
    [" "],
    ["nonexistent-model-name"],
    ["unknown-provider/nonexistent-model"],
    ["model", "extra"],
    ["model", "--agent", ""],
    ["model", "--agent", "a", "--conversation", "c"],
    ["model", "--conversation", "c", "--conv", "d"],
    ["model", "--model", "ignored"],
    ["model", "--reasoning"],
  ])(
    "rejects invalid input without changing configuration: %j",
    async (...args: string[]) => {
      const before = await config();
      const result = await cli(["set", ...args]);
      expect(result.code, result.stderr).toBe(1);
      expect(await config()).toEqual(before);
    },
    30000,
  );

  test("removes the unpublished agents set-model command", async () => {
    const before = await config();
    const result = await cli(["set-model", nextModel], {}, "agents");
    expect(result.code).toBe(1);
    expect(await config()).toEqual(before);
  }, 30000);

  test("requires a target when session identifiers are absent", async () => {
    const result = await cli(["set", nextModel], {
      AGENT_ID: undefined,
      CONVERSATION_ID: undefined,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Set AGENT_ID");
  }, 30000);
});
