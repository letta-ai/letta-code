import { expect, test } from "bun:test";
import { traceCodexLaunch } from "./external-llm-trace-launch";

const context = {
  parent_agent_id: "agent-test",
  parent_conversation_id: "conv-test",
  task_id: "task-test",
};

test("Codex subscription capture configures an HTTP provider at process startup", async () => {
  let upstream = "";
  const client = {
    request: async (method: string) =>
      method === "config/read"
        ? { config: { model_provider: "openai" } }
        : { account: { type: "chatgpt" } },
  };
  const trace = await traceCodexLaunch(
    context,
    {},
    client,
    async (_harness, _context, _env, url) => {
      upstream = url;
      return {
        url: "http://127.0.0.1:1234/trace",
        baseUrl: "https://api.letta.com",
        setSessionId: () => {},
        close: async () => {},
      };
    },
  );
  expect(upstream).toBe("https://chatgpt.com/backend-api/codex");
  expect(trace?.args).toContain('model_provider="letta_trace"');
  expect(trace?.args).toContain(
    "model_providers.letta_trace.requires_openai_auth=true",
  );
  expect(trace?.args).toContain(
    "model_providers.letta_trace.supports_websockets=false",
  );
});

test("custom provider auth stays in its config, and opt-out prevents discovery", async () => {
  let calls = 0;
  const client = {
    request: async (method: string) => {
      calls++;
      return method === "config/read"
        ? {
            config: {
              model_provider: "custom",
              model_providers: {
                custom: {
                  name: "custom",
                  base_url: "https://example.com/v1",
                  env_key: "KEY",
                  http_headers: { authorization: "private" },
                },
              },
            },
          }
        : { account: null };
    },
  };
  const factory = async () => ({
    url: "http://127.0.0.1:1234/trace",
    baseUrl: "https://api.letta.com",
    setSessionId: () => {},
    close: async () => {},
  });
  expect(
    await traceCodexLaunch(context, { DO_NOT_TRACK: "1" }, client, factory),
  ).toBeUndefined();
  expect(calls).toBe(0);
  const trace = await traceCodexLaunch(context, {}, client, factory);
  expect(trace?.params.modelProvider).toBe("custom");
  expect(JSON.stringify(trace?.args)).not.toContain("private");
  expect(trace?.args).toContain(
    'model_providers.custom.base_url="http://127.0.0.1:1234/trace"',
  );
});
