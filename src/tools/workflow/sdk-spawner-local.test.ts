import { describe, expect, test } from "bun:test";
import { createSdkSpawner, type SdkSpawnerConfig } from "./sdk-spawner";
import type {
  SdkClient,
  SdkQuery,
  SdkStreamMessage,
  SubagentRequest,
} from "./types";

const CONFIG: SdkSpawnerConfig = {
  parentAgentId: "agent-parent",
  model: "openai/gpt-5.6-luna",
  supportsAgentFreeResume: true,
  verifyPersistedRuns: false,
  retrieveConversation: async () => ({
    agent_id: null,
    parent_agent_id: "agent-parent",
    model: "openai/gpt-5.6-luna",
  }),
};

function request(options: SubagentRequest["options"] = {}): SubagentRequest {
  return { prompt: "inspect", options, callIndex: 0 };
}

function completedQuery(
  messages: SdkStreamMessage[],
  conversationId = "conv-worker",
): SdkQuery {
  return {
    conversationId,
    agentId: null,
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
    async interrupt() {},
    close() {},
  };
}

function fakeClient(messages: SdkStreamMessage[]): SdkClient {
  return { query: () => completedQuery(messages) };
}

describe("createSdkSpawner local continuation", () => {
  test("continues only after this spawner observed completion", async () => {
    let latestCalls = 0;
    const spawner = createSdkSpawner(
      fakeClient([
        { type: "result", success: true, result: "continued locally" },
      ]),
      {
        ...CONFIG,
        latestRun: async () => {
          latestCalls++;
          return null;
        },
      },
    );
    const signal = new AbortController().signal;
    await spawner(request(), signal);
    const outcome = await spawner(
      request({ conversationId: "conv-worker" }),
      signal,
    );
    expect(outcome).toMatchObject({
      value: "continued locally",
      conversationId: "conv-worker",
    });
    expect(latestCalls).toBe(0);
  });

  test("fails closed without observed local completion", async () => {
    const spawner = createSdkSpawner(fakeClient([]), CONFIG);
    await expect(
      spawner(
        request({ conversationId: "conv-foreign" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("only safe within the workflow execution");
  });

  test("tracks a fresh worker ID before exposing it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let conversationId: string | undefined;
    const query: SdkQuery = {
      get conversationId() {
        return conversationId;
      },
      agentId: null,
      async *[Symbol.asyncIterator]() {
        conversationId = "conv-fresh";
        yield { type: "loop_status", conversationId: "conv-fresh" };
        await gate;
        yield { type: "result", success: true, result: "done" };
      },
      async interrupt() {},
      close() {},
    };
    const spawner = createSdkSpawner({ query: () => query }, CONFIG);
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = spawner(request(), new AbortController().signal, {
      onStarted: started,
    });
    await didStart;
    await expect(
      spawner(
        request({ conversationId: "conv-fresh" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("already has an active workflow turn");
    release();
    expect(await first).toMatchObject({ value: "done" });
  });

  test("releases a resume lock after an immediate SDK ID mismatch", async () => {
    let calls = 0;
    const spawner = createSdkSpawner(
      {
        query: () => {
          calls++;
          return calls === 1
            ? completedQuery(
                [{ type: "result", success: true, result: "created" }],
                "conv-worker",
              )
            : completedQuery([], "conv-wrong");
        },
      },
      CONFIG,
    );
    await spawner(request(), new AbortController().signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        spawner(
          request({ conversationId: "conv-worker" }),
          new AbortController().signal,
        ),
      ).rejects.toThrow("unexpected worker conversation");
    }
    expect(calls).toBe(3);
  });
});
