import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

const fixture = `
import { __testSetBackend } from "./src/backend";
import { setConfiguredBackendMode } from "./src/backend/backend-mode";
import { FakeHeadlessBackend } from "./src/backend/dev/fake-headless-backend";
import { parseCliArgs } from "./src/cli/args";
import { handleHeadlessCommand } from "./src/headless";
import { settingsManager } from "./src/settings-manager";
import { installRuntimeModelCatalogFixture } from "./src/test-utils/runtime-model-catalog";

const agentId = "agent-headless-model-override";
const backend = new FakeHeadlessBackend(agentId);
const update = backend.updateAgent.bind(backend);
backend.updateAgent = async (...args) => {
  console.log(JSON.stringify({ type: "fixture_agent_update", body: args[1] }));
  return update(...args);
};
const create = backend.createConversation.bind(backend);
backend.createConversation = async (body) => {
  const agent = await backend.retrieveAgent(agentId);
  console.log(JSON.stringify({ type: "fixture_create", body, agentModel: agent.model }));
  return create(body);
};
setConfiguredBackendMode("local");
__testSetBackend(backend);
installRuntimeModelCatalogFixture();
await settingsManager.initialize();
const model = process.env.HEADLESS_TEST_MODEL;
if (!model) throw new Error("Missing test model");
await handleHeadlessCommand(parseCliArgs([
  "bun", "letta", "--agent", agentId,
  ...(process.env.HEADLESS_TEST_EXPLICIT_NEW === "1" ? ["--new"] : []),
  "-m", model,
  "-p", "Reply with pong", "--output-format", "stream-json",
  "--memfs-startup", "skip", "--no-mods"
], true), model, undefined, undefined, false);
`;

test.each([
  {
    model: "auto",
    explicitNew: true,
    expectedModel: "letta/auto",
    expectedSettings: {
      provider_type: "openai",
      parallel_tool_calls: true,
      max_output_tokens: 28000,
    },
    expectedContextWindow: 140000,
  },
  {
    model: "gpt-5.6-luna",
    explicitNew: false,
    expectedModel: "openai/gpt-5.6-luna",
    expectedSettings: {
      provider_type: "openai",
      parallel_tool_calls: true,
      reasoning: { reasoning_effort: "high" },
      reasoning_effort: "high",
      verbosity: "medium",
      max_output_tokens: 128000,
    },
    expectedContextWindow: 350000,
  },
])(
  "headless model $model targets the new conversation, not the agent",
  async ({
    model,
    explicitNew,
    expectedModel,
    expectedSettings,
    expectedContextWindow,
  }) => {
    const home = await mkdtemp(join(tmpdir(), "letta-headless-model-"));
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--loader=.md:text",
          "--loader=.mdx:text",
          "--loader=.txt:text",
          "--eval",
          fixture,
        ],
        {
          cwd: resolve(import.meta.dir, ".."),
          env: createIsolatedCliTestEnv({
            HOME: home,
            HEADLESS_TEST_MODEL: model,
            HEADLESS_TEST_EXPLICIT_NEW: explicitNew ? "1" : "0",
          }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const deadline = setTimeout(() => child.kill(), 20_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stderr).toBe(0);
        const events = stdout
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
        expect(events.find((event) => event.type === "fixture_create")).toEqual(
          {
            type: "fixture_create",
            body: {
              agent_id: "agent-headless-model-override",
              model: expectedModel,
              model_settings: expectedSettings,
              context_window_limit: expectedContextWindow,
            },
            agentModel: "dev/fake-headless",
          },
        );
        expect(
          events.filter(
            (event) =>
              event.type === "fixture_agent_update" &&
              ("model" in event.body || "model_settings" in event.body),
          ),
        ).toEqual([]);
        expect(
          events.find(
            (event) => event.type === "system" && event.subtype === "init",
          )?.model,
        ).toBe(expectedModel);
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  25_000,
);
