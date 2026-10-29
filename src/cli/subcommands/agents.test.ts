import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentConfigReport } from "@/cli/subcommands/model";

describe("buildAgentConfigReport", () => {
  test("reports agent defaults and redacts credential fields", () => {
    const report = buildAgentConfigReport(
      {
        id: "agent-test",
        name: "Tutor",
        model: "letta/auto",
        context_window_limit: 140000,
        model_settings: {
          provider_type: "openai",
          max_output_tokens: 28000,
          api_key: "secret-key",
          auth_token: "secret-token",
        },
        llm_config: {
          context_window: 140000,
          credentials: "not-safe",
        },
        system: "compiled prompt",
      },
      null,
    );

    expect(report).toEqual({
      agent: {
        id: "agent-test",
        name: "Tutor",
        model: "letta/auto",
        context_window_limit: 140000,
        model_settings: {
          provider_type: "openai",
          max_output_tokens: 28000,
          api_key: "[redacted]",
          auth_token: "[redacted]",
        },
        llm_config: { context_window: 140000 },
      },
      conversation: null,
      effective: {
        scope: "agent",
        model: "letta/auto",
        context_window_limit: 140000,
        model_settings: {
          provider_type: "openai",
          max_output_tokens: 28000,
          api_key: "[redacted]",
          auth_token: "[redacted]",
        },
      },
      note: "model is the configured handle; router handles do not identify the underlying model selected for one inference",
    });
    expect(JSON.stringify(report)).not.toContain("secret-key");
    expect(JSON.stringify(report)).not.toContain("secret-token");
    expect(JSON.stringify(report)).not.toContain("compiled prompt");
  });

  test("reports conversation overrides with their parent agent", () => {
    const report = buildAgentConfigReport(
      {
        id: "agent-test",
        model: "letta/auto",
        model_settings: { provider_type: "openai" },
      },
      {
        id: "conv-test",
        agent_id: "agent-test",
        model: "anthropic/claude-sonnet-4-6",
        model_settings: {
          provider_type: "anthropic",
          effort: "high",
        },
      },
    );

    expect(report).toMatchObject({
      agent: {
        id: "agent-test",
        model: "letta/auto",
      },
      conversation: {
        id: "conv-test",
        agent_id: "agent-test",
        model: "anthropic/claude-sonnet-4-6",
      },
      effective: {
        scope: "conversation",
        model: "anthropic/claude-sonnet-4-6",
        model_settings: {
          provider_type: "anthropic",
          effort: "high",
        },
      },
    });
  });

  test("reports a context-only conversation override without replacing the model", () => {
    const report = buildAgentConfigReport(
      {
        id: "agent-test",
        model: "letta/auto",
        context_window_limit: 140000,
        model_settings: { provider_type: "openai" },
      },
      {
        id: "conv-test",
        agent_id: "agent-test",
        model: null,
        context_window_limit: 64000,
      },
    );
    expect(report).toMatchObject({
      agent: { context_window_limit: 140000 },
      conversation: { model: null, context_window_limit: 64000 },
      effective: {
        scope: "conversation",
        model: "letta/auto",
        context_window_limit: 64000,
        model_settings: { provider_type: "openai" },
      },
    });
  });

  test("falls back to agent defaults when the conversation has no override", () => {
    const report = buildAgentConfigReport(
      {
        id: "agent-test",
        model: "letta/auto",
        model_settings: { provider_type: "openai" },
      },
      {
        id: "conv-test",
        agent_id: "agent-test",
        model: null,
        context_window_limit: null,
      },
    );

    expect(report).toMatchObject({
      conversation: {
        id: "conv-test",
        agent_id: "agent-test",
        model: null,
        context_window_limit: null,
      },
      effective: {
        scope: "agent",
        model: "letta/auto",
        model_settings: { provider_type: "openai" },
      },
    });
  });
});

// Real CLI subprocesses against a disk-backed local backend; no inference.
describe("agents create --body", () => {
  const root = resolve(import.meta.dir, "../../..");
  let home: string;
  let env: NodeJS.ProcessEnv;

  const body = {
    name: "Body agent",
    system: "You are a body-created agent.",
    tags: ["parent:agent-seeded", "suite:test"],
    model: "llama.cpp/policy",
    model_settings: { max_tokens: 2048, context_window_limit: 32768 },
    compaction_settings: { mode: "all", prompt: "Summarize." },
  };

  async function agents(args: string[], stdin?: string) {
    const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
    const child = Bun.spawn(
      [
        bundle ? "node" : process.execPath,
        bundle || "src/index.ts",
        "--backend",
        "local",
        "agents",
        ...args,
      ],
      {
        cwd: root,
        env,
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
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

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "letta-agents-body-"));
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LETTA_LOCAL_BACKEND_DIR: join(home, "backend"),
      LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
      LETTA_API_KEY: undefined,
      LETTA_DEBUG: "0",
      LETTA_DISABLE_MODS: "1",
    };
  });

  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  test("creates the agent the request describes, from a file or stdin", async () => {
    const path = join(home, "body.json");
    await writeFile(path, JSON.stringify(body));

    for (const [args, stdin] of [
      [["create", "--body", path], undefined],
      [["create", "--body", "-"], JSON.stringify(body)],
    ] as const) {
      const result = await agents([...args], stdin);
      expect(result.code, result.stderr).toBe(0);
      const agent = JSON.parse(result.stdout);
      expect(agent.id).toStartWith("agent-local-");
      expect(agent).toMatchObject({
        name: body.name,
        system: body.system,
        model: body.model,
        model_settings: body.model_settings,
        compaction_settings: body.compaction_settings,
      });
      expect(agent.tags).toEqual(expect.arrayContaining(body.tags));
    }

    const listed = await agents(["list", "--name", body.name]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).items).toHaveLength(2);
  }, 30000);

  test("rejects --body combined with other create options", async () => {
    const result = await agents(["create", "--body", "-", "--name", "x"], "{}");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--body cannot be combined with --name");
  }, 30000);

  test("rejects a body that is not a JSON object", async () => {
    const result = await agents(["create", "--body", "-"], "[]");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--body must contain a JSON object");
  }, 30000);
});
