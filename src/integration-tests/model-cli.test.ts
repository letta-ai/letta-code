import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Letta from "@letta-ai/letta-client";

async function verifyCloudModelCli(verifyInference: boolean) {
  const client = new Letta({
    apiKey: process.env.LETTA_API_KEY,
    baseURL: process.env.LETTA_BASE_URL || "https://api.letta.com",
    timeout: 120000,
  });
  const home = await mkdtemp(join(tmpdir(), "letta-cloud-set-model-"));
  const model = "openai/gpt-5.6-luna";
  const agent = await client.agents.create({
    name: "CLI set-model integration",
    agent_type: "letta_v1_agent",
    model: "letta/auto",
    system: "Reply concisely. Do not call tools.",
    include_base_tools: false,
    include_base_tool_rules: false,
    initial_message_sequence: [],
  });
  let conversationId: string | undefined;
  try {
    const conversation = await client.conversations.create({
      agent_id: agent.id,
    });
    conversationId = conversation.id;
    async function cli(args: string[]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "src/index.ts",
          "--backend",
          "cloud",
          "model",
          ...args,
        ],
        {
          cwd: resolve(import.meta.dir, "../.."),
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            AGENT_ID: agent.id,
            CONVERSATION_ID: conversationId,
            LETTA_DEBUG: "0",
            LETTA_DISABLE_MODS: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    }

    const changed = await cli(["set", model, "--reasoning", "high"]);
    expect(changed.code, changed.stderr).toBe(0);
    expect(JSON.parse(changed.stdout)).toMatchObject({
      agent: { id: agent.id, model: "letta/auto" },
      conversation: { id: conversationId, agent_id: agent.id, model },
      effective: { scope: "conversation", model },
    });
    const saved = await client.conversations.retrieve(conversationId);
    expect(saved.model).toBe(model);
    expect(saved.model_settings).toMatchObject({
      provider_type: "openai",
      reasoning: { reasoning_effort: "high" },
    });
    expect(
      JSON.parse(changed.stdout).conversation.context_window_limit,
    ).toBeGreaterThan(0);

    await client.conversations.update(conversationId, {
      context_window_limit: 64000,
      model_settings: {
        ...saved.model_settings,
        temperature: 0.23,
        max_output_tokens: 8192,
        parallel_tool_calls: false,
      },
    } as Parameters<typeof client.conversations.update>[1]);
    const effortOnly = await cli(["set", "--reasoning", "low"]);
    expect(effortOnly.code, effortOnly.stderr).toBe(0);
    const preserved = JSON.parse(effortOnly.stdout).effective;
    expect(preserved.model).toBe(model);
    expect(preserved.context_window_limit).toBe(64000);
    expect(preserved.model_settings).toMatchObject({
      temperature: 0.23,
      max_output_tokens: 8192,
      parallel_tool_calls: false,
      reasoning: { reasoning_effort: "low" },
    });

    const changedDefault = await cli([
      "set",
      model,
      "--reasoning",
      "high",
      "--agent",
      agent.id,
    ]);
    expect(changedDefault.code, changedDefault.stderr).toBe(0);
    expect(await client.agents.retrieve(agent.id)).toMatchObject({
      model,
      model_settings: {
        provider_type: "openai",
        reasoning: { reasoning_effort: "high" },
      },
    });
    const invalid = await cli(["set", "unknown-provider/does-not-exist"]);
    expect(invalid.code).toBe(1);
    expect((await client.conversations.retrieve(conversationId)).model).toBe(
      model,
    );

    const zai = await cli(["set", "zai/glm-5.3", "--reasoning", "low"]);
    expect(zai.code, zai.stderr).toBe(0);
    expect(
      (await client.conversations.retrieve(conversationId)).model_settings,
    ).toMatchObject({
      reasoning_effort: "low",
    });
    const restored = await cli(["set", model, "--reasoning", "high"]);
    expect(restored.code, restored.stderr).toBe(0);

    if (!verifyInference) return;

    // No override_model: the request must resolve the persisted CLI change.
    const stream = await client.conversations.messages.create(conversationId, {
      messages: [{ role: "user", content: "Reply with exactly OK." }],
    });
    let stepId: string | undefined;
    let assistant = "";
    let totalTokens = 0;
    let stopReason: string | undefined;
    for await (const event of stream) {
      if (event.message_type === "error_message")
        throw new Error(event.message);
      if (event.message_type === "assistant_message") {
        assistant += event.content;
        stepId = event.step_id ?? stepId;
      }
      if (event.message_type === "usage_statistics")
        totalTokens += event.total_tokens ?? 0;
      if (event.message_type === "stop_reason") stopReason = event.stop_reason;
    }
    expect(assistant.trim()).toBe("OK");
    expect(totalTokens).toBeGreaterThan(0);
    expect(stopReason).toBe("end_turn");
    expect(stepId).toBeDefined();
    const step = await client.steps.retrieve(stepId as string);
    expect(step.model_handle).toBe(model);
  } finally {
    if (conversationId) await client.conversations.delete(conversationId);
    await client.agents.delete(agent.id);
    await rm(home, { recursive: true, force: true });
  }
}

// Both run in the existing API CI job; configuration can also be verified
// independently when the test account cannot pay for a provider inference.
test.skipIf(!process.env.LETTA_API_KEY)(
  "CLI model configuration and reasoning persist in Cloud",
  () => verifyCloudModelCli(false),
  60000,
);
test.skipIf(!process.env.LETTA_API_KEY)(
  "CLI model changes select the model used for Cloud inference",
  () => verifyCloudModelCli(true),
  180000,
);

test.skipIf(!process.env.LETTA_API_KEY)(
  "CLI filters Cloud models by provider category",
  async () => {
    const client = new Letta({
      apiKey: process.env.LETTA_API_KEY,
      baseURL: process.env.LETTA_BASE_URL || "https://api.letta.com",
    });
    const inventory = await client.models.list();
    const expectedByok = new Set(
      inventory
        .filter(
          (entry) =>
            (entry as unknown as { provider_category?: string })
              .provider_category === "byok",
        )
        .map((entry) => entry.handle)
        .filter((handle): handle is string => typeof handle === "string"),
    );
    const listings: Array<Array<{ id: string; handle: string }>> = [];
    for (const flags of [[], ["--byok"], ["--hosted"]]) {
      console.info(`Checking Cloud model list ${flags.join(" ") || "(all)"}`);
      const child = Bun.spawn(
        [
          process.execPath,
          "src/index.ts",
          "--backend",
          "cloud",
          "models",
          "list",
          ...flags,
        ],
        {
          cwd: resolve(import.meta.dir, "../.."),
          env: { ...process.env, LETTA_DEBUG: "0" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      listings.push(JSON.parse(stdout));
    }
    const [all = [], byok = [], hosted = []] = listings;
    // Keep account-specific provider handles out of failure output.
    expect(new Set(byok.map((entry) => entry.handle)).size).toBe(
      expectedByok.size,
    );
    expect(byok.every((entry) => expectedByok.has(entry.handle))).toBe(true);
    expect(hosted.some((entry) => entry.handle === "openai/gpt-5.6-luna")).toBe(
      true,
    );
    expect(hosted.every((entry) => !expectedByok.has(entry.handle))).toBe(true);
    const allIds = new Set(all.map((entry) => entry.id));
    const filteredIds = new Set([...byok, ...hosted].map((entry) => entry.id));
    expect(allIds.size).toBe(filteredIds.size);
    expect([...allIds].every((id) => filteredIds.has(id))).toBe(true);
  },
  60000,
);
