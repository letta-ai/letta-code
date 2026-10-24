import { expect, test } from "bun:test";
import { APIBackend, type APIClient } from "./backend";

test("agent retrieval keeps query parameters separate from SDK request cancellation", async () => {
  let requestSignal: AbortSignal | undefined;
  const client = {
    agents: {
      retrieve: async (
        _id: string,
        _query: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        requestSignal = options?.signal;
        return { id: "agent" };
      },
    },
  } as unknown as APIClient;
  const backend = new APIBackend({ getClient: async () => client });
  const signal = new AbortController().signal;
  await backend.retrieveAgent("agent", undefined, { signal });
  expect(requestSignal).toBe(signal);
});

test.each(["default", "conv"])(
  "resume history propagates cancellation to SDK reads in %s",
  async (conversationId) => {
    const signals: Array<AbortSignal | undefined> = [];
    const list = async (
      _id: string,
      _body: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      signals.push(options?.signal);
      return { getPaginatedItems: () => [] };
    };
    const client = {
      agents: { messages: { list } },
      conversations: {
        retrieve: async (_id: string, options?: { signal?: AbortSignal }) => {
          signals.push(options?.signal);
          return { id: "conv" };
        },
        messages: { list },
      },
    } as unknown as APIClient;
    const backend = new APIBackend({ getClient: async () => client });
    const controller = new AbortController();
    const options = { limit: 1, signal: controller.signal };
    await backend.getConversationResumeTail("agent", conversationId, options);
    expect(signals).toEqual(
      conversationId === "default"
        ? [controller.signal]
        : [controller.signal, controller.signal],
    );
  },
);
