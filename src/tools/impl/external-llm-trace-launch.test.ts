import { expect, test } from "bun:test";
import { traceCodexLaunch } from "./external-llm-trace-launch";

test.each(["openai", "letta_trace", "custom"])(
  "configures trace routing for the persisted %s provider",
  async (modelProvider) => {
    const url = "http://127.0.0.1:12345/trace";
    const client = {
      async request(method: string, params: Record<string, unknown>) {
        if (method === "config/read")
          return {
            config: {
              model_provider: "current",
              model_providers: {
                custom: { base_url: "https://custom.example/v1" },
              },
            },
          };
        if (method === "thread/read") {
          expect(params).toEqual({ threadId: "thread-1", includeTurns: false });
          return { thread: { modelProvider } };
        }
        return { account: { type: "apiKey" } };
      },
    };
    const trace = await traceCodexLaunch(
      {
        parent_agent_id: "agent",
        parent_conversation_id: "conversation",
        task_id: "task",
      },
      {},
      client,
      "thread-1",
      async (_harness, _context, _env, upstream) => {
        expect(upstream).toBe(
          modelProvider === "custom"
            ? "https://custom.example/v1"
            : "https://api.openai.com/v1",
        );
        return {
          url,
          baseUrl: upstream,
          setSessionId() {},
          async close() {},
        };
      },
    );
    const selected = modelProvider === "custom" ? "custom" : "letta_trace";
    expect(trace?.args).toContain(
      `model_providers.${selected}.base_url="${url}"`,
    );
    if (modelProvider === "openai") {
      expect(trace?.args).toContain(`openai_base_url="${url}"`);
    }
  },
);
